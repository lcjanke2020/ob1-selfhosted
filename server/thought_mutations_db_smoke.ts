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
const appPool = new Pool(
  {
    hostname: host,
    port,
    database,
    user: "openbrain_app",
    password: appPassword,
  },
  1,
);

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
  },
): Promise<string> {
  const result = await client.queryObject<{ id: string }>(
    `INSERT INTO public.thoughts (
       content, embedding, metadata, content_fingerprint,
       workspace_id, project_id, visibility, owner_subject
     ) VALUES (
       $1, $2::vector, $3::jsonb,
       encode(sha256(convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')), 'hex'),
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

  console.log(
    "thought mutation query path: invisible→null, unchanged, conflict, update (re-embed, fingerprint, tsvector, stamps kept, history), move (owner-stamped, history follows head, dedupe conflict, explicit widening) passed",
  );
} finally {
  await cleanFixture();
  await appPool.end();
  await adminPool.end();
}
