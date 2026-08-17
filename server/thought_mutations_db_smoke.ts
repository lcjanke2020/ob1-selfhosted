// Explicit PostgreSQL regression for the production thought-mutation query
// path: updateThoughtContent and moveThought (queries.ts) as the forced-RLS
// application role, against db/10-thought-mutations.sql.
//
// This file intentionally is not named *_test.ts: the ordinary hermetic suite
// has no PostgreSQL dependency and only pins the SQL shapes. db-init.yml runs
// this against its disposable, fully initialized pgvector container. It proves
// the exact statements the server issues execute (bound parameter types, the
// jsonb merge, the recomputed fingerprint, the RETURNING shapes, the
// SECURITY DEFINER call), and that the outcomes match the contract:
// invisible → null, identical → unchanged, collision → ConflictError, and
// history that follows the head's audience.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
import type { PoolClient } from "postgres";
import type { ResolvedReadScope } from "./scope_contract.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");

// queries.ts imports the production config graph. Install the same minimum
// runtime values as the shipped server before loading that graph.
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("MCP_ACCESS_KEY", "thought-mutations-smoke-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");

const { moveThought, updateThoughtContent } = await import("./queries.ts");
const { updateThoughtInScope } = await import("./services.ts");
const { ConflictError } = await import("./errors.ts");

const database = "openbrain";
const MARKER = { _thought_mutations_db_smoke: true };
const WORKSPACE = "__mut_db_smoke_team";
const ALICE = "auth0|mut-db-smoke-alice";
const BOB = "auth0|mut-db-smoke-bob";
const ZERO_VECTOR = new Array(768).fill(0);
const ONE_VECTOR = new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0));

const adminPool = new Pool(
  { hostname: host, port, database, user: "postgres", password: adminPassword },
  1,
);
// Sized for the concurrency probes below: several production calls must be
// in flight against one head at the same time to contend for its row lock.
const appPool = new Pool(
  {
    hostname: host,
    port,
    database,
    user: "openbrain_app",
    password: appPassword,
  },
  8,
);

const CANONICAL_FINGERPRINT_SQL =
  "encode(sha256(convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')), 'hex')";

async function fingerprintOf(text: string): Promise<string> {
  return await withAdmin(async (client) => {
    const r = await client.queryObject<{ fp: string }>(
      `SELECT ${CANONICAL_FINGERPRINT_SQL} AS fp`,
      [text],
    );
    return r.rows[0].fp;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withAdmin<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function cleanFixture(): Promise<void> {
  await withAdmin(async (client) => {
    // The update path replaces classifier metadata (the marker included), so
    // key cleanup on the fixture content prefix and workspace as well.
    await client.queryArray(
      `DELETE FROM public.thoughts
       WHERE metadata @> $1::jsonb OR workspace_id = $2 OR content LIKE $3`,
      [JSON.stringify(MARKER), WORKSPACE, "db smoke:%"],
    );
    await client.queryArray(
      "DELETE FROM memory_scope.project WHERE workspace_id = $1",
      [WORKSPACE],
    );
    await client.queryArray(
      "DELETE FROM memory_scope.workspace WHERE id = $1",
      [
        WORKSPACE,
      ],
    );
  });
}

async function insertThought(
  client: PoolClient,
  row: {
    content: string;
    workspaceId: string;
    projectId: string | null;
    visibility: "personal" | "project" | "workspace";
    ownerSubject: string | null;
    metadata?: Record<string, unknown>;
    // Legacy rows captured before fingerprints carry NULL.
    nullFingerprint?: boolean;
  },
): Promise<string> {
  const result = await client.queryObject<{ id: string }>(
    `INSERT INTO public.thoughts (
       content, embedding, metadata, content_fingerprint,
       workspace_id, project_id, visibility, owner_subject
     ) VALUES (
       $1, $2::vector, $3::jsonb,
       CASE WHEN $8::boolean THEN NULL ELSE ${CANONICAL_FINGERPRINT_SQL} END,
       $4, $5, $6::memory_scope.visibility, $7
     ) RETURNING id`,
    [
      row.content,
      `[${ZERO_VECTOR.join(",")}]`,
      JSON.stringify({ ...MARKER, ...(row.metadata ?? {}) }),
      row.workspaceId,
      row.projectId,
      row.visibility,
      row.ownerSubject,
      row.nullFingerprint === true,
    ],
  );
  return result.rows[0].id;
}

const scope = (
  workspaceId: string,
  principal: string | null,
  visibilities: ResolvedReadScope["visibilities"],
  projectId: string | null = null,
): ResolvedReadScope => ({ workspaceId, projectId, principal, visibilities });

const actor = (subject: string | null, door = "funnel") => ({
  subject,
  door,
  tokenLabel: null,
});

await cleanFixture();
try {
  const ids = await withAdmin(async (client) => {
    await client.queryArray(
      `INSERT INTO memory_scope.workspace (id, description, default_visibility, personal_only)
       VALUES ($1, 'thought_mutations_db_smoke fixture', 'workspace', false)`,
      [WORKSPACE],
    );
    await client.queryArray(
      `INSERT INTO memory_scope.project (workspace_id, id, description)
       VALUES ($1, 'alpha', 'alpha fixture')`,
      [WORKSPACE],
    );
    return {
      // Misfiled workspace thought that alice will correct, then move personal.
      misfiled: await insertThought(client, {
        content: "db smoke: Aristotle runs mismatched Corsair kits",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
        metadata: {
          type: "observation",
          topics: ["hardware"],
          source: "mcp",
          door: "funnel",
          sub: ALICE,
          token_label: null,
          provenance: {
            schema_version: 1,
            caller_asserted: { author: "alice" },
          },
          metadata_extraction: { schema_version: 1, endpoint: "stub" },
        },
      }),
      // Existing workspace thought whose text an update will collide with.
      collider: await insertThought(client, {
        content: "db smoke: already captured text",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      // Personal thought of alice; the same content already sits in the
      // team workspace audience, so moving it there must conflict.
      alicePersonal: await insertThought(client, {
        content: "db smoke: shared text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "personal",
        ownerSubject: ALICE,
      }),
      teamCopy: await insertThought(client, {
        content: "db smoke: shared text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      // Legacy NULL-fingerprint personal row whose text equals teamCopy's:
      // moving it into the team workspace must conflict, not duplicate.
      legacyDuplicate: await insertThought(client, {
        content: "db smoke: shared text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "personal",
        ownerSubject: BOB,
        nullFingerprint: true,
      }),
      // Legacy NULL-fingerprint row with unique text: a move must heal it.
      legacyLonely: await insertThought(client, {
        content: "db smoke: lonely legacy text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "personal",
        ownerSubject: BOB,
        nullFingerprint: true,
      }),
      // Two workspace heads for the concurrency probes.
      raceA: await insertThought(client, {
        content: "db smoke: race head A",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      raceB: await insertThought(client, {
        content: "db smoke: race head B",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      dense: await insertThought(client, {
        content: "db smoke: dense revisions head",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      // Legacy NULL-fingerprint RESIDENT of the team workspace audience: a
      // fingerprinted mover and a content update onto its text must conflict.
      legacyResident: await insertThought(client, {
        content: "db smoke: legacy resident text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
        nullFingerprint: true,
      }),
      residentMover: await insertThought(client, {
        content: "db smoke: legacy resident text",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "personal",
        ownerSubject: ALICE,
      }),
      residentUpdater: await insertThought(client, {
        content: "db smoke: will be corrected onto the resident",
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
      // Head for the service-level locked no-op probe.
      probeHead: await insertThought(client, {
        content: "db smoke: probe head original",
        workspaceId: "default",
        projectId: null,
        visibility: "workspace",
        ownerSubject: null,
      }),
    };
  });

  const defaultAlice = scope("default", ALICE, ["personal", "workspace"]);
  const defaultAnon = scope("default", null, ["workspace"]);
  const teamBob = scope(WORKSPACE, BOB, ["personal", "workspace"]);
  const teamAlicePersonal = scope(WORKSPACE, ALICE, ["personal"]);

  // ---- update: invisible → null, no writes -----------------------------
  assertEquals(
    await updateThoughtContent(appPool, {
      id: ids.misfiled,
      content: "hijack",
      embedding: ONE_VECTOR,
      freshMetadata: { type: "idea" },
      degradationEvents: [],
      actor: actor(BOB),
      scope: teamBob,
    }),
    null,
    "a thought outside the caller's audience must read as null",
  );

  // ---- update: identical content → unchanged, no writes ----------------
  const unchanged = await updateThoughtContent(appPool, {
    id: ids.misfiled,
    content: "db smoke: Aristotle runs mismatched Corsair kits",
    embedding: ONE_VECTOR,
    freshMetadata: { type: "idea" },
    degradationEvents: [],
    actor: actor(ALICE),
    scope: defaultAlice,
  });
  assert(unchanged);
  assertEquals(unchanged.outcome, "unchanged");
  assertEquals(unchanged.revision, 0);
  assertEquals(unchanged.metadata.type, "observation");

  // ---- update: same-audience collision → ConflictError, no writes ------
  const conflict = await assertRejects(
    () =>
      updateThoughtContent(appPool, {
        id: ids.misfiled,
        content: "DB SMOKE:   already captured   text",
        embedding: ONE_VECTOR,
        freshMetadata: { type: "idea" },
        degradationEvents: [],
        actor: actor(ALICE),
        scope: defaultAlice,
      }),
    ConflictError,
  );
  assert(conflict.message.includes(ids.collider), conflict.message);

  // ---- update: the real thing ------------------------------------------
  const updated = await updateThoughtContent(appPool, {
    id: ids.misfiled,
    content: "db smoke: Aristotle runs 4x G.Skill Trident Z5 48GB",
    embedding: ONE_VECTOR,
    freshMetadata: {
      type: "reference",
      topics: ["hardware", "memory"],
      metadata_extraction: {
        schema_version: 1,
        endpoint: "primary",
        model: "smoke",
      },
    },
    degradationEvents: [{
      event_type: "stub_used",
      endpoint_role: null,
      failure_reason: null,
      http_status: null,
      endpoint_model: null,
      endpoint_base_url: null,
    }],
    actor: actor(ALICE),
    scope: defaultAlice,
  });
  assert(updated);
  assertEquals(updated.outcome, "updated");
  assertEquals(updated.revision, 1);
  assertEquals(
    updated.content,
    "db smoke: Aristotle runs 4x G.Skill Trident Z5 48GB",
  );
  assertEquals(updated.metadata.type, "reference");
  assertEquals(updated.metadata.topics, ["hardware", "memory"]);
  assertEquals(
    (updated.metadata.metadata_extraction as { model?: string }).model,
    "smoke",
  );
  // Capture stamps + caller-asserted provenance survive; the smoke marker
  // (an unreserved key) is classifier territory and is replaced.
  assertEquals(updated.metadata.sub, ALICE);
  assertEquals(updated.metadata.source, "mcp");
  assertEquals(updated.metadata.token_label, null);
  assertEquals(
    (updated.metadata.provenance as { caller_asserted: unknown })
      .caller_asserted,
    { author: "alice" },
  );
  assertEquals("_thought_mutations_db_smoke" in updated.metadata, false);
  assert(updated.updated_at, "updated_at must be returned");

  await withAdmin(async (client) => {
    const head = await client.queryObject<{
      fingerprint: string;
      expected: string;
      lexical: boolean;
      embedded: string;
      degradation_events: bigint;
    }>(
      `SELECT content_fingerprint AS fingerprint,
              encode(sha256(convert_to(lower(trim(regexp_replace(content, '\\s+', ' ', 'g'))), 'UTF8')), 'hex') AS expected,
              content_tsv @@ to_tsquery('simple', 'trident') AS lexical,
              embedding::text AS embedded,
              (SELECT count(*) FROM metadata_degradation_events WHERE thought_id = t.id) AS degradation_events
       FROM public.thoughts AS t WHERE id = $1`,
      [ids.misfiled],
    );
    const row = head.rows[0];
    assertEquals(
      row.fingerprint,
      row.expected,
      "fingerprint must be recomputed",
    );
    assertEquals(row.lexical, true, "generated tsvector must follow content");
    assert(row.embedded.startsWith("[1,0,0"), "embedding must be replaced");
    assertEquals(Number(row.degradation_events), 1);
    const revisions = await client.queryObject<{
      revision: number;
      change_kind: string;
      prior_content: string;
      prior_visibility: string;
      changed_by_subject: string;
      changed_by_door: string;
    }>(
      `SELECT revision, change_kind, prior_content, prior_visibility::text,
              changed_by_subject, changed_by_door
       FROM public.thought_revisions WHERE thought_id = $1 ORDER BY revision`,
      [ids.misfiled],
    );
    assertEquals(revisions.rows.length, 1);
    assertEquals(revisions.rows[0].change_kind, "content");
    assertEquals(
      revisions.rows[0].prior_content,
      "db smoke: Aristotle runs mismatched Corsair kits",
    );
    assertEquals(revisions.rows[0].changed_by_subject, ALICE);
    assertEquals(revisions.rows[0].changed_by_door, "funnel");
  });

  // ---- move: invisible → null ------------------------------------------
  assertEquals(
    await moveThought(appPool, {
      id: ids.misfiled,
      target: {
        workspaceId: WORKSPACE,
        projectId: null,
        visibility: "workspace",
      },
      actor: actor(BOB),
      scope: teamBob,
    }),
    null,
  );

  // ---- move: workspace → personal (alice), history follows the head ----
  const moved = await moveThought(appPool, {
    id: ids.misfiled,
    target: { workspaceId: WORKSPACE, projectId: null, visibility: "personal" },
    actor: actor(ALICE),
    scope: defaultAlice,
  });
  assert(moved);
  assertEquals(moved.outcome, "moved");
  assertEquals(moved.revision, 2);
  assertEquals(moved.workspace_id, WORKSPACE);
  assertEquals(moved.visibility, "personal");
  assertEquals(moved.conflict_thought_id, null);

  // Old audience (and an anonymous default reader) no longer see it; the
  // owner does, with two revisions; bob in the destination workspace does not.
  const anonUpdate = await updateThoughtContent(appPool, {
    id: ids.misfiled,
    content: "hijack again",
    embedding: ONE_VECTOR,
    freshMetadata: {},
    degradationEvents: [],
    actor: actor(null, "tailnet"),
    scope: defaultAnon,
  });
  assertEquals(anonUpdate, null);
  const bobMove = await moveThought(appPool, {
    id: ids.misfiled,
    target: {
      workspaceId: WORKSPACE,
      projectId: null,
      visibility: "workspace",
    },
    actor: actor(BOB),
    scope: teamBob,
  });
  assertEquals(bobMove, null);
  const ownerNoop = await moveThought(appPool, {
    id: ids.misfiled,
    target: { workspaceId: WORKSPACE, projectId: null, visibility: "personal" },
    actor: actor(ALICE),
    scope: teamAlicePersonal,
  });
  assertEquals(ownerNoop?.outcome, "unchanged");
  assertEquals(ownerNoop?.revision, 2);

  await withAdmin(async (client) => {
    const head = await client.queryObject<{
      owner_subject: string | null;
      content: string;
    }>(
      `SELECT owner_subject, content FROM public.thoughts WHERE id = $1`,
      [ids.misfiled],
    );
    assertEquals(head.rows[0].owner_subject, ALICE);
    assertEquals(
      head.rows[0].content,
      "db smoke: Aristotle runs 4x G.Skill Trident Z5 48GB",
      "a move must not touch content",
    );
    const scopeRevision = await client.queryObject<{
      prior_workspace_id: string;
      prior_visibility: string;
      prior_owner_subject: string | null;
      change_kind: string;
    }>(
      `SELECT prior_workspace_id, prior_visibility::text, prior_owner_subject,
              change_kind
       FROM public.thought_revisions WHERE thought_id = $1 AND revision = 2`,
      [ids.misfiled],
    );
    assertEquals(scopeRevision.rows[0], {
      prior_workspace_id: "default",
      prior_visibility: "workspace",
      prior_owner_subject: null,
      change_kind: "scope",
    });
  });

  // ---- move: dedupe conflict in the target audience --------------------
  const collided = await moveThought(appPool, {
    id: ids.alicePersonal,
    target: {
      workspaceId: WORKSPACE,
      projectId: null,
      visibility: "workspace",
    },
    actor: actor(ALICE),
    scope: teamAlicePersonal,
  });
  assertEquals(collided?.outcome, "conflict");
  assertEquals(collided?.conflict_thought_id, ids.teamCopy);
  assertEquals(collided?.visibility, "personal");

  // ---- move: personal → project (explicit widening by the owner) -------
  const widened = await moveThought(appPool, {
    id: ids.alicePersonal,
    target: {
      workspaceId: WORKSPACE,
      projectId: "alpha",
      visibility: "project",
    },
    actor: actor(ALICE),
    scope: teamAlicePersonal,
  });
  assertEquals(widened?.outcome, "moved");
  assertEquals(widened?.project_id, "alpha");
  // Readable by the project audience without any principal now.
  const projectRead = await updateThoughtContent(appPool, {
    id: ids.alicePersonal,
    content: "db smoke: shared text",
    embedding: ONE_VECTOR,
    freshMetadata: {},
    degradationEvents: [],
    actor: actor(null, "tailnet"),
    scope: scope(WORKSPACE, null, ["project"], "alpha"),
  });
  assertEquals(projectRead?.outcome, "unchanged");
  assertEquals(projectRead?.revision, 1);

  // ---- move: legacy NULL fingerprint — dedupe on the derived value ------
  const teamBobPersonal = scope(WORKSPACE, BOB, ["personal"]);
  const legacyConflict = await moveThought(appPool, {
    id: ids.legacyDuplicate,
    target: {
      workspaceId: WORKSPACE,
      projectId: null,
      visibility: "workspace",
    },
    actor: actor(BOB),
    scope: teamBobPersonal,
  });
  assertEquals(legacyConflict?.outcome, "conflict");
  assertEquals(legacyConflict?.conflict_thought_id, ids.teamCopy);
  const legacyHealed = await moveThought(appPool, {
    id: ids.legacyLonely,
    target: {
      workspaceId: WORKSPACE,
      projectId: null,
      visibility: "workspace",
    },
    actor: actor(BOB),
    scope: teamBobPersonal,
  });
  assertEquals(legacyHealed?.outcome, "moved");
  const lonelyFingerprint = await fingerprintOf("db smoke: lonely legacy text");
  await withAdmin(async (client) => {
    const rows = await client.queryObject<{ id: string; fp: string | null }>(
      `SELECT id, content_fingerprint AS fp FROM public.thoughts
       WHERE id = ANY ($1::uuid[])`,
      [[ids.legacyDuplicate, ids.legacyLonely]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.fp]));
    assertEquals(
      byId.get(ids.legacyDuplicate),
      null,
      "a conflicting legacy move must leave the row untouched",
    );
    assertEquals(
      byId.get(ids.legacyLonely),
      lonelyFingerprint,
      "a successful move must heal a legacy NULL fingerprint",
    );
  });

  // ---- concurrency: N updates on one head → dense revisions 1..N -------
  const N = 6;
  const dense = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      updateThoughtContent(appPool, {
        id: ids.dense,
        content: `db smoke: dense revisions head v${i + 1}`,
        embedding: ONE_VECTOR,
        freshMetadata: { type: "observation" },
        degradationEvents: [],
        actor: actor(ALICE),
        scope: defaultAlice,
      })),
  );
  assertEquals(dense.filter(Boolean).length, N, "every writer must succeed");
  assertEquals(
    dense.map((r) => r!.revision).sort((a, b) => a - b),
    Array.from({ length: N }, (_, i) => i + 1),
    "revision numbers must be dense under contention",
  );
  await withAdmin(async (client) => {
    const r = await client.queryObject<{ revisions: bigint }>(
      `SELECT count(*) AS revisions FROM public.thought_revisions
       WHERE thought_id = $1`,
      [ids.dense],
    );
    assertEquals(Number(r.rows[0].revisions), N);
  });

  // ---- concurrency: two heads converging on one target audience --------
  // A competitor commits an identical fingerprint into the target audience
  // AFTER our pre-check but BEFORE our write. Deterministic reproduction: an
  // uncommitted admin transaction already holds that index entry, so the
  // production write blocks on the unique index until the competitor commits,
  // then fails with 23505 — which must surface as the documented conflict
  // naming the competitor, not as an internal error. The elapsed time proves
  // the write path (not the pre-check) produced the outcome.
  const HOLD_MS = 1200;
  await withAdmin(async (client) => {
    // Identical text in two distinct audiences: raceA default/workspace,
    // raceB alice's default/personal. Both are about to converge on
    // team/alpha/project.
    await client.queryArray(
      `UPDATE public.thoughts SET workspace_id = 'default', project_id = NULL,
         visibility = 'workspace', owner_subject = NULL,
         content = $1, content_fingerprint = ${CANONICAL_FINGERPRINT_SQL}
       WHERE id = $2`,
      ["db smoke: converging text", ids.raceA],
    );
    await client.queryArray(
      `UPDATE public.thoughts SET workspace_id = 'default', project_id = NULL,
         visibility = 'personal', owner_subject = $3,
         content = $1, content_fingerprint = ${CANONICAL_FINGERPRINT_SQL}
       WHERE id = $2`,
      ["db smoke: converging text", ids.raceB, ALICE],
    );
  });
  {
    const held = await adminPool.connect();
    try {
      await held.queryArray("BEGIN");
      await held.queryArray(
        `UPDATE public.thoughts
         SET workspace_id = $2, project_id = 'alpha', visibility = 'project',
             owner_subject = NULL
         WHERE id = $1`,
        [ids.raceB, WORKSPACE],
      );
      const started = performance.now();
      const racing = moveThought(appPool, {
        id: ids.raceA,
        target: {
          workspaceId: WORKSPACE,
          projectId: "alpha",
          visibility: "project",
        },
        actor: actor(ALICE),
        scope: defaultAlice,
      });
      await sleep(HOLD_MS);
      await held.queryArray("COMMIT");
      const outcome = await racing;
      const elapsed = performance.now() - started;
      assertEquals(outcome?.outcome, "conflict", JSON.stringify(outcome));
      assertEquals(outcome?.conflict_thought_id, ids.raceB);
      assert(
        elapsed >= HOLD_MS * 0.9,
        `move must have waited on the index (${elapsed.toFixed(0)}ms)`,
      );
    } finally {
      held.release();
    }
    await withAdmin(async (client) => {
      const r = await client.queryObject<{
        visibility: string;
        revisions: bigint;
      }>(
        `SELECT visibility::text,
                (SELECT count(*) FROM public.thought_revisions WHERE thought_id = t.id) AS revisions
         FROM public.thoughts t WHERE id = $1`,
        [ids.raceA],
      );
      assertEquals(
        r.rows[0].visibility,
        "workspace",
        "conflicting move must not move",
      );
      assertEquals(
        Number(r.rows[0].revisions),
        0,
        "conflicting move must write no history",
      );
    });
  }
  // The update path has the same check-then-write shape: a competitor's
  // uncommitted fingerprint in the same audience must yield ConflictError
  // naming it, after the savepoint rollback, with the head untouched.
  {
    const held = await adminPool.connect();
    try {
      // raceB is now team/alpha/project with "converging text"; give raceA the
      // same audience but different text, then have the competitor (raceB)
      // rewrite its fingerprint to the value raceA's update will compute.
      await held.queryArray(
        `UPDATE public.thoughts SET workspace_id = $2, project_id = 'alpha',
           visibility = 'project', owner_subject = NULL,
           content = 'db smoke: race head A again',
           content_fingerprint = ${CANONICAL_FINGERPRINT_SQL}
         WHERE id = $3`,
        ["db smoke: race head A again", WORKSPACE, ids.raceA],
      );
      await held.queryArray("BEGIN");
      await held.queryArray(
        `UPDATE public.thoughts
         SET content = 'db smoke: the winning text',
             content_fingerprint = ${CANONICAL_FINGERPRINT_SQL}
         WHERE id = $2`,
        ["db smoke: the winning text", ids.raceB],
      );
      const started = performance.now();
      const racing = updateThoughtContent(appPool, {
        id: ids.raceA,
        content: "db smoke: the winning text",
        embedding: ONE_VECTOR,
        freshMetadata: { type: "observation" },
        degradationEvents: [],
        actor: actor(null, "tailnet"),
        scope: scope(WORKSPACE, null, ["project"], "alpha"),
      }).then(
        (r) => ({ ok: r }),
        (e: unknown) => ({ err: e }),
      );
      await sleep(HOLD_MS);
      await held.queryArray("COMMIT");
      const settled = await racing;
      const elapsed = performance.now() - started;
      assert("err" in settled, "update onto a competing fingerprint must fail");
      assert(
        settled.err instanceof ConflictError,
        `expected ConflictError, got ${String(settled.err)}`,
      );
      assert(
        (settled.err as Error).message.includes(ids.raceB),
        (settled.err as Error).message,
      );
      assert(
        elapsed >= HOLD_MS * 0.9,
        `update must have waited on the index (${elapsed.toFixed(0)}ms)`,
      );
    } finally {
      held.release();
    }
    await withAdmin(async (client) => {
      const r = await client.queryObject<{
        content: string;
        revisions: bigint;
      }>(
        `SELECT content,
                (SELECT count(*) FROM public.thought_revisions WHERE thought_id = t.id) AS revisions
         FROM public.thoughts t WHERE id = $1`,
        [ids.raceA],
      );
      assertEquals(r.rows[0].content, "db smoke: race head A again");
      assertEquals(
        Number(r.rows[0].revisions),
        0,
        "the savepoint must roll the revision row back with the head rewrite",
      );
    });
  }

  // ---- legacy NULL fingerprint on the TARGET side, both paths -----------
  const teamAliceUnion = scope(WORKSPACE, ALICE, ["personal", "workspace"]);
  const residentMove = await moveThought(appPool, {
    id: ids.residentMover,
    target: {
      workspaceId: WORKSPACE,
      projectId: null,
      visibility: "workspace",
    },
    actor: actor(ALICE),
    scope: teamAliceUnion,
  });
  assertEquals(residentMove?.outcome, "conflict");
  assertEquals(residentMove?.conflict_thought_id, ids.legacyResident);
  const residentUpdate = await assertRejects(
    () =>
      updateThoughtContent(appPool, {
        id: ids.residentUpdater,
        content: "db smoke: legacy resident text",
        embedding: ONE_VECTOR,
        freshMetadata: {},
        degradationEvents: [],
        actor: actor(null, "tailnet"),
        scope: scope(WORKSPACE, null, ["workspace"]),
      }),
    ConflictError,
  );
  assert(residentUpdate.message.includes(ids.legacyResident));
  await withAdmin(async (client) => {
    const r = await client.queryObject<{ n: bigint }>(
      `SELECT count(*) AS n FROM public.thoughts
       WHERE workspace_id = $1 AND visibility = 'workspace'
         AND content = 'db smoke: legacy resident text'`,
      [WORKSPACE],
    );
    assertEquals(
      Number(r.rows[0].n),
      1,
      "the legacy resident must remain the only copy in its audience",
    );
  });

  // ---- service no-op probe is a single locked decision -----------------
  // A competitor holds a content rewrite of the head uncommitted. The service
  // must wait it out (row lock), then decide against the LATEST tuple:
  // (a) the request carrying the competitor's new text is a no-op reported
  //     with revision 1 — the head and history depth as one atomic state;
  // (b) the request carrying the ORIGINAL text is NOT a no-op: it falls
  //     through to embed/classify and writes revision 2 restoring the text.
  {
    // Recording fakes for the service's embed/classify seam (real vector width
    // so the write path can persist what the fake returns).
    const embedCalls: string[] = [];
    const extractCalls: string[] = [];
    const deps = {
      embed: (text: string) => {
        embedCalls.push(text);
        return Promise.resolve([...ONE_VECTOR]);
      },
      extractMetadata: (text: string) => {
        extractCalls.push(text);
        return Promise.resolve({
          metadata: { type: "observation" },
          classifier: { schema_version: 1 as const, endpoint: "stub" as const },
          degradation_events: [],
        });
      },
    };
    const auth = { door: "tailnet" as const, sub: null, tokenLabel: null };
    const held = await adminPool.connect();
    try {
      await held.queryArray("BEGIN");
      await held.queryArray(
        `SELECT set_config('openbrain.workspace_id', 'default', true),
                set_config('openbrain.project_id', '', true),
                set_config('openbrain.principal', '', true),
                set_config('openbrain.visibilities', 'workspace', true)`,
      );
      // The competitor is the production update path on another connection.
      await held.queryArray(
        `SELECT id FROM public.thoughts WHERE id = $1 FOR UPDATE`,
        [ids.probeHead],
      );
      await held.queryArray(
        `INSERT INTO public.thought_revisions (
           thought_id, revision, change_kind, prior_content, prior_metadata,
           prior_workspace_id, prior_project_id, prior_visibility,
           prior_owner_subject, changed_by_subject, changed_by_door
         ) VALUES ($1, 1, 'content', 'db smoke: probe head original', '{}',
                   'default', NULL, 'workspace', NULL, NULL, 'tailnet')`,
        [ids.probeHead],
      );
      await held.queryArray(
        `UPDATE public.thoughts SET content = 'db smoke: probe head competitor',
           content_fingerprint = ${CANONICAL_FINGERPRINT_SQL}
         WHERE id = $2`,
        ["db smoke: probe head competitor", ids.probeHead],
      );
      const started = performance.now();
      const racing = updateThoughtInScope(
        appPool,
        { id: ids.probeHead, content: "db smoke: probe head competitor", auth },
        deps,
      );
      await sleep(HOLD_MS);
      await held.queryArray("COMMIT");
      const outcome = await racing;
      const elapsed = performance.now() - started;
      assert(outcome);
      assertEquals(outcome.outcome, "unchanged");
      assertEquals(outcome.content, "db smoke: probe head competitor");
      assertEquals(
        outcome.revision,
        1,
        "history depth must match the head returned",
      );
      assert(
        elapsed >= HOLD_MS * 0.9,
        `no-op probe must have waited on the row lock (${
          elapsed.toFixed(0)
        }ms)`,
      );
      assertEquals(embedCalls, [], "a no-op must not embed");
      assertEquals(extractCalls, [], "a no-op must not classify");
    } finally {
      held.release();
    }
    const restored = await updateThoughtInScope(
      appPool,
      { id: ids.probeHead, content: "db smoke: probe head original", auth },
      deps,
    );
    assert(restored);
    assertEquals(restored.outcome, "updated");
    assertEquals(restored.revision, 2);
    assertEquals(embedCalls, ["db smoke: probe head original"]);
    assertEquals(extractCalls, ["db smoke: probe head original"]);
  }

  // ---- a unique violation that is NOT a dedupe collision is rethrown -----
  // Misalign the history identity sequence so the revision insert collides on
  // thought_revisions_pkey: the savepoint rolls back, the re-probe finds no
  // colliding thought, and the ORIGINAL database error must surface — not a
  // fabricated content conflict. The head stays untouched.
  {
    const seq = await withAdmin(async (client) => {
      const r = await client.queryObject<{ seq: string; max_id: bigint }>(
        `SELECT pg_get_serial_sequence('public.thought_revisions', 'id') AS seq,
                max(id) AS max_id
         FROM public.thought_revisions`,
      );
      const { seq, max_id } = r.rows[0];
      assert(seq && max_id !== null);
      await client.queryArray(`SELECT setval($1, $2::bigint - 1, true)`, [
        seq,
        max_id,
      ]);
      return { seq, maxId: max_id };
    });
    try {
      const err = await assertRejects(() =>
        updateThoughtContent(appPool, {
          id: ids.dense,
          content: "db smoke: dense revisions head after pkey clash",
          embedding: ONE_VECTOR,
          freshMetadata: {},
          degradationEvents: [],
          actor: actor(ALICE),
          scope: defaultAlice,
        })
      );
      assert(
        !(err instanceof ConflictError),
        "an unattributable unique violation must not become a content conflict",
      );
      assert(
        String((err as Error).message).includes("thought_revisions_pkey"),
        (err as Error).message,
      );
    } finally {
      await withAdmin(async (client) => {
        await client.queryArray(`SELECT setval($1, $2::bigint, true)`, [
          seq.seq,
          seq.maxId,
        ]);
      });
    }
    await withAdmin(async (client) => {
      const r = await client.queryObject<{ content: string; n: bigint }>(
        `SELECT content,
                (SELECT count(*) FROM public.thought_revisions WHERE thought_id = t.id) AS n
         FROM public.thoughts t WHERE id = $1`,
        [ids.dense],
      );
      assertEquals(
        r.rows[0].content.startsWith("db smoke: dense revisions head v"),
        true,
      );
      assertEquals(
        Number(r.rows[0].n),
        N,
        "the failed write must leave history intact",
      );
    });
    // The pool connection is healthy afterwards.
    const after = await updateThoughtContent(appPool, {
      id: ids.dense,
      content: "db smoke: dense revisions head after recovery",
      embedding: ONE_VECTOR,
      freshMetadata: {},
      degradationEvents: [],
      actor: actor(ALICE),
      scope: defaultAlice,
    });
    assertEquals(after?.outcome, "updated");
    assertEquals(after?.revision, N + 1);
  }

  console.log(
    "thought mutation query path: invisible→null, unchanged, conflict, update (re-embed, fingerprint, tsvector, stamps kept, history), move (owner-stamped, history follows head, dedupe conflict, explicit widening), legacy NULL fingerprint (source: conflict + heal; target: conflict on both paths), dense concurrent revisions, race-to-conflict on both paths, locked service no-op probe, and unattributable unique-violation rethrow passed",
  );
} finally {
  await cleanFixture();
  await appPool.end();
  await adminPool.end();
}
