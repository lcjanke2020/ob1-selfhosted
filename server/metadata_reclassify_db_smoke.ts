// Explicit PostgreSQL regression for the maintenance-only metadata
// reclassifier (metadata_reclassify.ts) against db/16-thought-metadata-
// revisions.sql. Not named *_test.ts: the hermetic suite has no PostgreSQL;
// db-init.yml runs this against its disposable, fully initialized pgvector
// container.
//
// It proves the tool's exact statements as a real superuser across three
// audiences (default/workspace, default/personal, sensitive/personal):
// candidate selection (unstamped and stub only), a read-only plan, the
// locked write with its 'metadata' revision and SQL stamp merge, refusal for
// a non-superuser, for a pre-16 or contradicting named CHECK, and for another
// CHECK on change_kind, a concurrent edit between classify and write, the
// re-read and lock guards against rows stamped or edited after the listing, a
// primary failure, app-role visibility afterwards, and an idempotent rerun.
// The classifier is a fake; no endpoint is contacted.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
import type { PoolClient } from "postgres";
import type { ResolvedReadScope } from "./scope_contract.ts";
import type { PrimaryClassification } from "./metadata.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");

// The tool imports the production config graph. Install the same minimum
// runtime values as the shipped server before loading that graph.
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("MCP_ACCESS_KEY", "metadata-reclassify-smoke-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");

const { reclassifyExitCode, reclassifyMetadata } = await import(
  "./metadata_reclassify.ts"
);
const { fetchThought } = await import("./queries.ts");
const { withScopeClient } = await import("./scoped_db.ts");

const database = "openbrain";
const PREFIX = "reclassify smoke:";
const OWNER = "auth0|reclassify-smoke-owner";
const OTHER = "auth0|reclassify-smoke-other";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const MODEL = "smoke-primary-model";
const PRIMARY = { base_url: "http://primary.invalid/v1", model: MODEL };

// One pool for fixtures and the "concurrent writer", one connection for the
// tool itself (the CLI also runs on a single superuser connection).
const adminPool = new Pool(
  { hostname: host, port, database, user: "postgres", password: adminPassword },
  1,
);
const toolPool = new Pool(
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
  2,
);

async function withPool<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}
const withAdmin = <T>(operation: (client: PoolClient) => Promise<T>) =>
  withPool(adminPool, operation);

async function cleanFixture(): Promise<void> {
  // Revisions cascade with their heads.
  await withAdmin((client) =>
    client.queryArray("DELETE FROM public.thoughts WHERE content LIKE $1", [
      `${PREFIX}%`,
    ])
  );
}

type Audience = {
  workspaceId: string;
  visibility: "personal" | "workspace";
  ownerSubject: string | null;
};
const DEFAULT_WORKSPACE: Audience = {
  workspaceId: "default",
  visibility: "workspace",
  ownerSubject: null,
};
const DEFAULT_PERSONAL: Audience = {
  workspaceId: "default",
  visibility: "personal",
  ownerSubject: OWNER,
};
const SENSITIVE_PERSONAL: Audience = {
  workspaceId: "sensitive",
  visibility: "personal",
  ownerSubject: OWNER,
};

async function insertThought(
  client: PoolClient,
  content: string,
  audience: Audience,
  metadata: Record<string, unknown>,
  minutesAgo: number,
): Promise<string> {
  const result = await client.queryObject<{ id: string }>(
    `INSERT INTO public.thoughts (
       content, metadata, content_fingerprint,
       workspace_id, project_id, visibility, owner_subject, created_at
     ) VALUES (
       $1, $2::jsonb,
       encode(sha256(convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')), 'hex'),
       $3, NULL, $4::memory_scope.visibility, $5,
       now() - make_interval(mins => $6::int)
     ) RETURNING id::text AS id`,
    [
      `${PREFIX} ${content}`,
      JSON.stringify(metadata),
      audience.workspaceId,
      audience.visibility,
      audience.ownerSubject,
      minutesAgo,
    ],
  );
  return result.rows[0].id;
}

const scope = (
  workspaceId: string,
  principal: string | null,
  visibilities: ResolvedReadScope["visibilities"],
): ResolvedReadScope => ({
  workspaceId,
  projectId: null,
  principal,
  visibilities,
});

type Snapshot = {
  id: string;
  content: string;
  metadata: string;
  fingerprint: string | null;
  updated_at: string;
  revisions: number;
};

async function snapshot(ids: string[]): Promise<Map<string, Snapshot>> {
  return await withAdmin(async (client) => {
    const result = await client.queryObject<Snapshot>(
      `SELECT t.id::text AS id, t.content, t.metadata::text AS metadata,
              t.content_fingerprint AS fingerprint,
              t.updated_at::text AS updated_at,
              (SELECT count(*)::int FROM public.thought_revisions AS r
               WHERE r.thought_id = t.id) AS revisions
       FROM public.thoughts AS t WHERE t.id = ANY ($1::uuid[])`,
      [ids],
    );
    return new Map(result.rows.map((row) => [row.id, row]));
  });
}

// Whole-corpus digest: a plan run must leave every thought and every revision
// exactly as it was, not just the fixtures.
async function corpusDigest(): Promise<string> {
  return await withAdmin(async (client) => {
    const result = await client.queryObject<{ digest: string }>(
      `SELECT concat_ws('|',
         (SELECT count(*) FROM public.thoughts),
         (SELECT md5(coalesce(string_agg(
            t.id::text || t.metadata::text || t.updated_at::text, ','
            ORDER BY t.id), '')) FROM public.thoughts AS t),
         (SELECT count(*) FROM public.thought_revisions),
         (SELECT count(*) FROM public.metadata_degradation_events)
       ) AS digest`,
    );
    return result.rows[0].digest;
  });
}

type Emitted = Record<string, unknown>;

async function runTool(
  options: { apply?: boolean; ids?: string[]; limit?: number },
  classify: (text: string) => Promise<PrimaryClassification>,
) {
  const emitted: Emitted[] = [];
  const summary = await withPool(
    toolPool,
    (client) =>
      reclassifyMetadata(client, options, {
        primaryEnabled: true,
        primary: PRIMARY,
        classify,
        emit: (record) => emitted.push(record),
      }),
  );
  return { emitted, summary, exit: reclassifyExitCode(summary) };
}

const neverClassify = () =>
  Promise.reject(new Error("plan and idempotent runs must not classify"));

const classified = (
  metadata: Record<string, unknown>,
): PrimaryClassification => ({
  ok: true,
  metadata: metadata as Extract<
    PrimaryClassification,
    { ok: true }
  >["metadata"],
  classifier: { schema_version: 1, endpoint: "primary", model: MODEL },
});

const metadataFor = (type: string, topic: string) => ({
  type,
  topics: [topic],
  people: ["Fixture Person"],
  action_items: type === "task" ? ["fixture follow-up"] : [],
  dates_mentioned: ["2026-01-02"],
});

const CAPTURE_STAMPS = {
  source: "mcp",
  door: "funnel",
  sub: "auth0|reclassify-smoke-capturer",
  token_label: null,
  provenance: {
    schema_version: 1,
    caller_asserted: { agent: "fixture-agent" },
  },
};

await cleanFixture();
try {
  const fixtures = await withAdmin(async (client) => ({
    // Completed work captured before the stamp and mis-typed as a task.
    legacy: await insertThought(
      client,
      "wrote the setup notes",
      DEFAULT_WORKSPACE,
      {
        type: "task",
        topics: ["setup"],
        action_items: ["write the setup notes"],
        legacy_extra: "replaced like any classifier field",
        ...CAPTURE_STAMPS,
      },
      70,
    ),
    personal: await insertThought(
      client,
      "personal unstamped",
      DEFAULT_PERSONAL,
      {
        type: "observation",
        topics: ["notes"],
        source: "rest",
        door: "tailnet",
        sub: null,
        token_label: "fixture-token",
      },
      60,
    ),
    sensitive: await insertThought(
      client,
      "sensitive stub",
      SENSITIVE_PERSONAL,
      {
        topics: ["uncategorized"],
        type: "observation",
        metadata_extraction: { schema_version: 1, endpoint: "stub" },
        source: "mcp",
        door: "funnel",
        sub: OWNER,
        token_label: null,
      },
      50,
    ),
    primaryStamped: await insertThought(
      client,
      "already primary",
      DEFAULT_WORKSPACE,
      {
        type: "idea",
        topics: ["kept"],
        metadata_extraction: {
          schema_version: 1,
          endpoint: "primary",
          model: "earlier-model",
        },
      },
      40,
    ),
    fallbackStamped: await insertThought(
      client,
      "already fallback",
      DEFAULT_WORKSPACE,
      {
        type: "reference",
        topics: ["kept"],
        metadata_extraction: {
          schema_version: 1,
          endpoint: "fallback",
          model: "earlier-model",
        },
      },
      30,
    ),
    race: await insertThought(
      client,
      "edited during classification",
      DEFAULT_WORKSPACE,
      {
        type: "task",
        topics: ["race"],
      },
      20,
    ),
    failing: await insertThought(
      client,
      "primary fails here",
      DEFAULT_PERSONAL,
      {
        type: "task",
        topics: ["retry"],
      },
      10,
    ),
  }));
  const candidateOrder = [
    fixtures.legacy,
    fixtures.personal,
    fixtures.sensitive,
    fixtures.race,
    fixtures.failing,
  ];
  const allIds = Object.values(fixtures);

  // An earlier content revision: the metadata revision must number after it.
  await withAdmin((client) =>
    client.queryArray(
      `INSERT INTO public.thought_revisions (
         thought_id, revision, change_kind, prior_content, prior_metadata,
         prior_workspace_id, prior_project_id, prior_visibility,
         prior_owner_subject, changed_by_subject, changed_by_door,
         changed_by_token_label
       ) VALUES ($1, 1, 'content', $2, '{}'::jsonb, 'default', NULL,
                 'personal', $3, $3, 'funnel', NULL)`,
      [fixtures.personal, `${PREFIX} personal earlier text`, OWNER],
    )
  );

  // ---- refusals against the real catalog --------------------------------
  await withPool(appPool, async (client) => {
    await assertRejects(
      () =>
        reclassifyMetadata(client, {}, {
          primaryEnabled: true,
          primary: PRIMARY,
          classify: neverClassify,
          emit: () => {
            throw new Error("a refused run must emit nothing");
          },
        }),
      Error,
      "requires a PostgreSQL superuser",
    );
  });
  // Catalogs that would reject a 'metadata' revision, each inside a
  // rolled-back transaction on the tool's own connection: the pre-16 CHECK (as
  // migration 10 created it), a named CHECK that mentions 'metadata' but
  // excludes it, and another CHECK on change_kind. PostgreSQL ANDs every
  // CHECK, and a NOT VALID one still binds new rows; a second CHECK is refused
  // even when it would admit 'metadata'. Each refusal precedes any read.
  const drifts: [string, string][] = [
    [
      `DROP CONSTRAINT thought_revisions_change_kind,
       ADD CONSTRAINT thought_revisions_change_kind
         CHECK (change_kind IN ('content', 'scope'))`,
      "apply db/16-thought-metadata-revisions.sql",
    ],
    [
      `DROP CONSTRAINT thought_revisions_change_kind,
       ADD CONSTRAINT thought_revisions_change_kind
         CHECK (change_kind <> 'metadata')`,
      "apply db/16-thought-metadata-revisions.sql",
    ],
    [
      `ADD CONSTRAINT reclassify_smoke_no_metadata
         CHECK (change_kind <> 'metadata') NOT VALID`,
      "drop reclassify_smoke_no_metadata as a PostgreSQL superuser",
    ],
    [
      `ADD CONSTRAINT reclassify_smoke_widened
         CHECK (change_kind IN ('content', 'scope', 'metadata', 'other'))`,
      "drop reclassify_smoke_widened as a PostgreSQL superuser",
    ],
  ];
  for (const [drift, message] of drifts) {
    await withPool(toolPool, async (client) => {
      await client.queryArray("BEGIN");
      try {
        await client.queryArray(
          `ALTER TABLE public.thought_revisions ${drift}`,
        );
        await assertRejects(
          () =>
            reclassifyMetadata(client, { apply: true }, {
              primaryEnabled: true,
              primary: PRIMARY,
              classify: neverClassify,
              emit: () => {
                throw new Error("a refused run must emit nothing");
              },
            }),
          Error,
          message,
        );
      } finally {
        await client.queryArray("ROLLBACK");
      }
    });
  }

  // ---- plan: candidates only, zero writes --------------------------------
  const beforePlan = await corpusDigest();
  const plan = await runTool({}, neverClassify);
  assertEquals(await corpusDigest(), beforePlan, "plan must write nothing");
  assertEquals(plan.exit, 0);
  const planned = plan.emitted
    .filter((r) => r.outcome === "would_reclassify")
    .map((r) => r.id as string);
  assertEquals(
    planned.filter((id) => allIds.includes(id)),
    candidateOrder,
    "unstamped and stub rows, ordered by created_at; stamped rows ignored",
  );

  const restricted = await runTool(
    { ids: [...allIds, UNKNOWN], limit: 2 },
    neverClassify,
  );
  assertEquals(
    restricted.emitted.slice(0, -1).map((r) => [r.id, r.outcome]),
    [
      [fixtures.primaryStamped, "not_candidate"],
      [fixtures.fallbackStamped, "not_candidate"],
      [UNKNOWN, "not_candidate"],
      [fixtures.legacy, "would_reclassify"],
      [fixtures.personal, "would_reclassify"],
    ],
  );
  assertEquals(restricted.summary.candidates, 5);
  assertEquals(restricted.summary.selected, 2);
  assertEquals(await corpusDigest(), beforePlan, "plan must write nothing");

  // ---- apply ---------------------------------------------------------------
  const before = await snapshot(allIds);
  const responses = new Map<string, () => Promise<PrimaryClassification>>([
    [
      fixtures.legacy,
      () =>
        Promise.resolve(classified({
          ...metadataFor("observation", "setup"),
          // Server-owned keys from a misbehaving classifier are discarded.
          source: "forged",
          sub: "forged",
          provenance: { forged: true },
          metadata_extraction: { schema_version: 1, endpoint: "fallback" },
        })),
    ],
    [
      fixtures.personal,
      () => Promise.resolve(classified(metadataFor("reference", "notes"))),
    ],
    [
      fixtures.sensitive,
      () => Promise.resolve(classified(metadataFor("person_note", "health"))),
    ],
    [
      fixtures.race,
      async () => {
        // A concurrent update commits while the classifier runs.
        await withAdmin((client) =>
          client.queryArray(
            `UPDATE public.thoughts
             SET metadata = metadata || '{"type":"reference"}'::jsonb
             WHERE id = $1`,
            [fixtures.race],
          )
        );
        return classified(metadataFor("observation", "race"));
      },
    ],
    [
      fixtures.failing,
      () =>
        Promise.resolve(
          { ok: false, reason: "non_2xx", status: 503 } as const,
        ),
    ],
  ]);
  const contentToId = new Map(
    [...before.values()].map((row) => [row.content, row.id]),
  );
  const classifiedIds: string[] = [];
  const applied = await runTool({ apply: true, ids: allIds }, (text) => {
    const id = contentToId.get(text);
    assert(id, "only fixture content may reach the classifier");
    classifiedIds.push(id);
    return responses.get(id)!();
  });
  assertEquals(classifiedIds, candidateOrder);
  assertEquals(applied.summary, {
    mode: "apply",
    primary: PRIMARY,
    candidates: 5,
    selected: 5,
    would_reclassify: 0,
    reclassified: 3,
    primary_failed: 1,
    changed_concurrently: 1,
    not_candidate: 2,
  });
  assertEquals(applied.exit, 2, "a failed or raced row exits 2");
  const outcomes = new Map(
    applied.emitted.filter((r) => r.id).map((r) => [r.id as string, r]),
  );
  assertEquals(outcomes.get(fixtures.legacy), {
    id: fixtures.legacy,
    outcome: "reclassified",
    before: { type: "task", topics: ["setup"] },
    after: { type: "observation", topics: ["setup"] },
  });
  assertEquals(outcomes.get(fixtures.failing), {
    id: fixtures.failing,
    outcome: "primary_failed",
    reason: "non_2xx",
    http_status: 503,
    before: { type: "task", topics: ["retry"] },
  });
  assertEquals(outcomes.get(fixtures.race)?.outcome, "changed_concurrently");
  // Privacy: no content or extracted detail is printed.
  const printed = JSON.stringify(applied.emitted);
  for (
    const secret of [
      PREFIX,
      "Fixture Person",
      "fixture follow-up",
      "2026-01-02",
    ]
  ) {
    assertEquals(printed.includes(secret), false, secret);
  }

  const after = await snapshot(allIds);
  const stamp = { schema_version: 1, endpoint: "primary", model: MODEL };
  const headOf = async (id: string) =>
    await withAdmin(async (client) => {
      const result = await client.queryObject<
        { metadata: Record<string, unknown> }
      >("SELECT metadata FROM public.thoughts WHERE id = $1", [id]);
      return result.rows[0].metadata;
    });
  // Classifier fields replaced (legacy_extra and the forged keys gone), the
  // fresh stamp set, original capture stamps preserved from the locked row.
  assertEquals(await headOf(fixtures.legacy), {
    ...metadataFor("observation", "setup"),
    metadata_extraction: stamp,
    ...CAPTURE_STAMPS,
  });
  assertEquals(await headOf(fixtures.personal), {
    ...metadataFor("reference", "notes"),
    metadata_extraction: stamp,
    source: "rest",
    door: "tailnet",
    sub: null,
    token_label: "fixture-token",
  });
  assertEquals(await headOf(fixtures.sensitive), {
    ...metadataFor("person_note", "health"),
    metadata_extraction: stamp,
    source: "mcp",
    door: "funnel",
    sub: OWNER,
    token_label: null,
  });
  for (const id of [fixtures.legacy, fixtures.personal, fixtures.sensitive]) {
    const was = before.get(id)!;
    const now = after.get(id)!;
    assertEquals(now.content, was.content, "content is never rewritten");
    assertEquals(now.fingerprint, was.fingerprint);
    assert(now.updated_at > was.updated_at, "updated_at must advance");
    assertEquals(now.revisions, was.revisions + 1);
  }
  for (
    const id of [
      fixtures.primaryStamped,
      fixtures.fallbackStamped,
      fixtures.failing,
    ]
  ) {
    assertEquals(
      after.get(id),
      before.get(id),
      "ignored/failed rows untouched",
    );
  }
  // The concurrent writer's change stands; the tool wrote nothing over it.
  assertEquals(after.get(fixtures.race)?.revisions, 0);
  assertEquals(
    JSON.parse(after.get(fixtures.race)!.metadata),
    { type: "reference", topics: ["race"] },
  );

  // One 'metadata' revision per rewritten head, snapshotting the locked state.
  type Revision = {
    thought_id: string;
    revision: number;
    change_kind: string;
    prior_content: string;
    prior_metadata_matches: boolean;
    prior_workspace_id: string;
    prior_project_id: string | null;
    prior_visibility: string;
    prior_owner_subject: string | null;
    changed_by_subject: string | null;
    changed_by_door: string;
    changed_by_token_label: string | null;
  };
  const revisions = await withAdmin(async (client) => {
    const result = await client.queryObject<Revision>(
      `SELECT r.thought_id::text AS thought_id, r.revision, r.change_kind,
              r.prior_content,
              r.prior_metadata = (s.before ->> r.thought_id::text)::jsonb
                AS prior_metadata_matches,
              r.prior_workspace_id, r.prior_project_id,
              r.prior_visibility::text AS prior_visibility,
              r.prior_owner_subject, r.changed_by_subject, r.changed_by_door,
              r.changed_by_token_label
       FROM public.thought_revisions AS r
       CROSS JOIN (SELECT $2::jsonb AS before) AS s
       WHERE r.thought_id = ANY ($1::uuid[]) AND r.change_kind = 'metadata'
       ORDER BY r.thought_id, r.revision`,
      [
        allIds,
        JSON.stringify(
          Object.fromEntries(
            [...before.values()].map((row) => [row.id, row.metadata]),
          ),
        ),
      ],
    );
    return new Map(result.rows.map((row) => [row.thought_id, row]));
  });
  assertEquals(revisions.size, 3);
  for (
    const [id, audience, number] of [
      [fixtures.legacy, DEFAULT_WORKSPACE, 1],
      [fixtures.personal, DEFAULT_PERSONAL, 2],
      [fixtures.sensitive, SENSITIVE_PERSONAL, 1],
    ] as const
  ) {
    assertEquals(revisions.get(id), {
      thought_id: id,
      revision: number,
      change_kind: "metadata",
      prior_content: before.get(id)!.content,
      prior_metadata_matches: true,
      prior_workspace_id: audience.workspaceId,
      prior_project_id: null,
      prior_visibility: audience.visibility,
      prior_owner_subject: audience.ownerSubject,
      changed_by_subject: null,
      changed_by_door: "maintenance",
      changed_by_token_label: null,
    });
  }
  // Operator runs do not write the capture-path degradation ledger.
  await withAdmin(async (client) => {
    const result = await client.queryObject<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.metadata_degradation_events
       WHERE thought_id = ANY ($1::uuid[])`,
      [allIds],
    );
    assertEquals(result.rows[0].n, 0);
  });

  // ---- app-role readers keep reading the rows in their own audiences ------
  const workspaceRead = await fetchThought(
    appPool,
    fixtures.legacy,
    scope("default", null, ["workspace"]),
  );
  assertEquals(workspaceRead?.metadata.type, "observation");
  assertEquals(workspaceRead?.metadata.metadata_extraction, stamp);
  const personalRead = await fetchThought(
    appPool,
    fixtures.personal,
    scope("default", OWNER, ["personal", "workspace"]),
  );
  assertEquals(personalRead?.metadata.type, "reference");
  const sensitiveRead = await fetchThought(
    appPool,
    fixtures.sensitive,
    scope("sensitive", OWNER, ["personal"]),
  );
  assertEquals(sensitiveRead?.metadata.type, "person_note");
  assertEquals(
    await fetchThought(
      appPool,
      fixtures.sensitive,
      scope("sensitive", OTHER, ["personal"]),
    ),
    null,
    "another principal still cannot read the sensitive row",
  );
  assertEquals(
    await fetchThought(
      appPool,
      fixtures.personal,
      scope("default", null, ["workspace"]),
    ),
    null,
    "the workspace audience still cannot read the personal row",
  );
  const visibleRevisions = (readScope: ResolvedReadScope, id: string) =>
    withScopeClient(appPool, readScope, async (client) => {
      const result = await client.queryObject<{ n: number }>(
        `SELECT count(*)::int AS n FROM thought_revisions
         WHERE thought_id = $1 AND change_kind = 'metadata'`,
        [id],
      );
      return result.rows[0].n;
    });
  assertEquals(
    await visibleRevisions(
      scope("sensitive", OWNER, ["personal"]),
      fixtures.sensitive,
    ),
    1,
  );
  assertEquals(
    await visibleRevisions(
      scope("sensitive", OTHER, ["personal"]),
      fixtures.sensitive,
    ),
    0,
    "history stays exactly as protected as its head",
  );

  // ---- rerun: the raced and failed rows, then nothing ----------------------
  const retried = await runTool(
    { apply: true, ids: allIds },
    () => Promise.resolve(classified(metadataFor("observation", "retried"))),
  );
  assertEquals(retried.exit, 0);
  assertEquals(
    retried.emitted
      .filter((r) => r.outcome === "reclassified")
      .map((r) => r.id),
    [fixtures.race, fixtures.failing],
  );
  await withAdmin(async (client) => {
    const result = await client.queryObject<{ prior_type: string }>(
      `SELECT prior_metadata->>'type' AS prior_type
       FROM public.thought_revisions
       WHERE thought_id = $1 AND change_kind = 'metadata'`,
      [fixtures.race],
    );
    assertEquals(
      result.rows.map((row) => row.prior_type),
      ["reference"],
      "the retry snapshots the concurrent writer's state",
    );
  });

  const settled = await corpusDigest();
  const idempotent = await runTool({ apply: true, ids: allIds }, neverClassify);
  assertEquals(idempotent.summary.candidates, 0);
  assertEquals(idempotent.summary.not_candidate, allIds.length);
  assertEquals(idempotent.exit, 0);
  assertEquals(
    await corpusDigest(),
    settled,
    "an idempotent rerun writes nothing",
  );
  const replan = await runTool({}, neverClassify);
  assertEquals(
    replan.emitted.filter((r) => allIds.includes(r.id as string)),
    [],
    "no fixture remains a candidate",
  );

  // ---- SQL guards the hermetic fake re-implements ---------------------------
  // Only this smoke executes the real statements. A row stamped elsewhere
  // after the listing must not be classified, and a content-only edit during
  // classification must not receive metadata derived from the old text.
  const late = await withAdmin(async (client) => ({
    first: await insertThought(
      client,
      "guard first",
      DEFAULT_WORKSPACE,
      { type: "task", topics: ["guard"] },
      3,
    ),
    stamped: await insertThought(
      client,
      "guard stamped after listing",
      DEFAULT_WORKSPACE,
      { type: "task", topics: ["guard"] },
      2,
    ),
    edited: await insertThought(
      client,
      "guard edited during classification",
      DEFAULT_WORKSPACE,
      { type: "task", topics: ["guard"] },
      1,
    ),
  }));
  const guarded = await runTool(
    { apply: true, ids: [late.first, late.stamped, late.edited] },
    async (text) => {
      if (text.endsWith("guard first")) {
        await withAdmin((client) =>
          client.queryArray(
            `UPDATE public.thoughts
             SET metadata = metadata || '{"metadata_extraction":{"schema_version":1,"endpoint":"fallback","model":"elsewhere"}}'::jsonb
             WHERE id = $1`,
            [late.stamped],
          )
        );
      } else if (text.endsWith("guard edited during classification")) {
        await withAdmin((client) =>
          client.queryArray(
            `UPDATE public.thoughts SET content = content || ' (edited)'
             WHERE id = $1`,
            [late.edited],
          )
        );
      } else {
        throw new Error("a row stamped after the listing was classified");
      }
      return classified(metadataFor("observation", "guard"));
    },
  );
  assertEquals(guarded.emitted.slice(0, -1).map((r) => [r.id, r.outcome]), [
    [late.first, "reclassified"],
    [late.stamped, "changed_concurrently"],
    [late.edited, "changed_concurrently"],
  ]);
  const guardHeads = await snapshot([late.stamped, late.edited]);
  assertEquals(guardHeads.get(late.stamped)?.revisions, 0);
  assertEquals(guardHeads.get(late.edited)?.revisions, 0);
  assertEquals(JSON.parse(guardHeads.get(late.edited)!.metadata).type, "task");

  console.log(
    "metadata reclassify: superuser, migration-16 and change_kind-drift refusals, read-only plan, unstamped/stub selection across workspace/personal/sensitive audiences, locked 'metadata' revisions with SQL stamp merge, concurrent-change and primary-failure no-writes, app-role visibility, idempotent rerun, and the re-read and lock guards passed",
  );
} finally {
  await cleanFixture();
  await appPool.end();
  await toolPool.end();
  await adminPool.end();
}
