// Hermetic tests for the maintenance-only metadata reclassifier. A scripted
// FakeClient models just enough of public.thoughts to drive the tool's SQL
// sequence; db-init's metadata_reclassify_db_smoke.ts proves the same
// statements against PostgreSQL. No network: the classifier is injected.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { PoolClient } from "postgres";
import { FakeClient, withEnv } from "./api_test_support.ts";
import type { PrimaryClassification } from "./metadata.ts";

const ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  METADATA_FALLBACK_POLICY: "off",
};

// The injected destination; the CLI's default is proven fresh-process in
// metadata_config_test.ts.
const PRIMARY = { base_url: "http://primary.invalid/v1", model: "test-model" };

// Migration 17's CHECK as PostgreSQL prints it, pinned independently of the
// tool's own copy.
const CHANGE_KIND_CHECK =
  "CHECK ((change_kind = ANY (ARRAY['content'::text, 'scope'::text, 'metadata'::text, 'forget'::text, 'restore'::text])))";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";
const ID_C = "00000000-0000-4000-8000-00000000000c";
const ID_D = "00000000-0000-4000-8000-00000000000d";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

type FakeThought = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
};

const CAPTURE_STAMPS = {
  source: "mcp",
  door: "funnel",
  sub: "subject-a",
  token_label: null,
  provenance: { schema_version: 1, caller_asserted: { agent: "fixture" } },
};

// A: legacy unstamped; B: stub; C: primary-stamped; D: fallback-stamped.
function corpus(): FakeThought[] {
  return [
    {
      id: ID_A,
      content: "reclassify fixture: wrote the quarterly report (2026-01-02)",
      metadata: {
        type: "task",
        topics: ["report"],
        legacy_extra: "dropped by the rewrite",
        ...CAPTURE_STAMPS,
      },
    },
    {
      id: ID_B,
      content: "reclassify fixture: stub row",
      metadata: {
        type: "observation",
        topics: ["uncategorized"],
        metadata_extraction: { schema_version: 1, endpoint: "stub" },
      },
    },
    {
      id: ID_C,
      content: "reclassify fixture: already classified",
      metadata: {
        type: "idea",
        topics: ["kept"],
        metadata_extraction: {
          schema_version: 1,
          endpoint: "primary",
          model: "m",
        },
      },
    },
    {
      id: ID_D,
      content: "reclassify fixture: fallback classified",
      metadata: {
        type: "reference",
        topics: ["kept"],
        metadata_extraction: {
          schema_version: 1,
          endpoint: "fallback",
          model: "m",
        },
      },
    },
  ];
}

function isCandidate(thought: FakeThought): boolean {
  const stamp = thought.metadata.metadata_extraction as
    | { endpoint?: unknown }
    | undefined;
  return stamp === undefined || stamp.endpoint === "stub";
}

const PRESERVED = ["provenance", "source", "door", "sub", "token_label"];

// Scripts the tool's statements over an in-memory corpus. Keyed on stable SQL
// fragments; anything unscripted rejects (FakeClient default), so a new
// statement cannot slip past these tests unnoticed.
function fakeDatabase(
  thoughts: FakeThought[],
  options: {
    superuser?: boolean;
    migrated?: boolean;
    narrowing?: string[];
    failOn?: (sql: string) => Error | undefined;
  } = {},
) {
  const revisions: { thoughtId: string; door: unknown }[] = [];
  const find = (id: unknown) => thoughts.find((t) => t.id === id);
  const client = new FakeClient((sql, params) => {
    const failure = options.failOn?.(sql);
    if (failure) throw failure;
    if (sql.includes("rolsuper AS owner")) {
      return { rows: [{ owner: options.superuser ?? true }] };
    }
    if (sql.includes("pg_get_constraintdef")) {
      return {
        rows: [{
          ready: (options.migrated ?? true) && params[0] === CHANGE_KIND_CHECK,
          narrowing: options.narrowing ?? [],
        }],
      };
    }
    if (sql.includes("ORDER BY t.created_at, t.id")) {
      const ids = params[0] as string[] | null;
      return {
        rows: thoughts
          .filter((t) => isCandidate(t) && (ids === null || ids.includes(t.id)))
          .map((t) => ({
            id: t.id,
            type: t.metadata.type ?? null,
            topics: t.metadata.topics ?? null,
          })),
      };
    }
    if (sql.includes("t.metadata::text AS metadata")) {
      const thought = find(params[0]);
      return {
        rows: thought && isCandidate(thought)
          ? [{
            content: thought.content,
            metadata: JSON.stringify(thought.metadata),
          }]
          : [],
      };
    }
    if (sql.includes("AS unchanged")) {
      const thought = find(params[0]);
      return {
        rows: thought
          ? [{
            unchanged: thought.content === params[1] &&
              JSON.stringify(thought.metadata) === params[2],
          }]
          : [],
      };
    }
    if (sql.includes("INSERT INTO public.thought_revisions")) {
      revisions.push({ thoughtId: params[0] as string, door: params[1] });
      return { rows: [] };
    }
    if (sql.includes("UPDATE public.thoughts AS t")) {
      const thought = find(params[0])!;
      const keys = params[2] as string[];
      const preserved = Object.fromEntries(
        Object.entries(thought.metadata).filter(([key]) => keys.includes(key)),
      );
      thought.metadata = { ...JSON.parse(params[1] as string), ...preserved };
      return {
        rows: [{
          type: thought.metadata.type,
          topics: thought.metadata.topics,
        }],
      };
    }
  });
  return { client, revisions };
}

function classifier(
  respond: (text: string) => PrimaryClassification,
) {
  const texts: string[] = [];
  return {
    texts,
    classify: (text: string) => {
      texts.push(text);
      return Promise.resolve(respond(text));
    },
  };
}

function ok(
  metadata: Record<string, unknown>,
  model = "local-model",
): PrimaryClassification {
  return {
    ok: true,
    metadata: metadata as Extract<
      PrimaryClassification,
      { ok: true }
    >["metadata"],
    classifier: { schema_version: 1, endpoint: "primary", model },
  };
}

const OBSERVATION = {
  type: "observation",
  topics: ["report", "history"],
  people: ["Fixture Person"],
  action_items: ["fixture action item"],
  dates_mentioned: ["2026-01-02"],
};

const sqlOf = (client: FakeClient) =>
  [...client.queryArrayCalls, ...client.queryObjectCalls].map((c) => c.sql);

const writes = (client: FakeClient) =>
  sqlOf(client).filter((sql) =>
    sql === "BEGIN" || sql.includes("INSERT INTO") ||
    sql.includes("UPDATE public.thoughts") ||
    sql.includes("metadata_degradation")
  );

Deno.test(
  "metadata reclassify arguments",
  withEnv([], ENV, async () => {
    const { parseReclassifyArgs } = await import("./metadata_reclassify.ts");
    assertEquals(parseReclassifyArgs([]), {
      apply: false,
      ids: undefined,
      limit: undefined,
    });
    assertEquals(
      parseReclassifyArgs([
        "--id",
        ID_A.toUpperCase(),
        "--limit",
        "5",
        "--id",
        ID_B,
        "--apply",
      ]),
      { apply: true, ids: [ID_A, ID_B], limit: 5 },
    );
    for (
      const bad of [
        ["--apply", "--apply"],
        ["--id"],
        ["--id", "not-a-uuid"],
        ["--id", `${ID_A}x`],
        ["--id", ID_A, "--id", ID_A.toUpperCase()],
        ["--id", "--apply"],
        [`--id=${ID_A}`],
        ["--limit"],
        ["--limit", "0"],
        ["--limit", "-1"],
        ["--limit", "+3"],
        ["--limit", "01"],
        ["--limit", "1.5"],
        ["--limit", "1e3"],
        ["--limit", "99999999999999999999"],
        ["--limit", "2", "--limit", "3"],
        ["--limit", "--apply"],
        ["--rebuild"],
        ["apply"],
      ]
    ) {
      assertThrows(
        () => parseReclassifyArgs(bad),
        Error,
        "usage: metadata_reclassify.ts",
        bad.join(" "),
      );
    }
  }),
);

Deno.test(
  "metadata reclassify refuses before reading or classifying any content",
  withEnv([], ENV, async (t) => {
    const { reclassifyMetadata } = await import("./metadata_reclassify.ts");
    const cases: [
      string,
      Parameters<typeof fakeDatabase>[1],
      boolean,
      string,
    ][] = [
      [
        "non-superuser",
        { superuser: false },
        true,
        "requires a PostgreSQL superuser (rolsuper)",
      ],
      ["primary disabled", {}, false, "ENABLE_PRIMARY_EXTRACTION=true"],
      [
        "migration 16/17 missing",
        { migrated: false },
        true,
        "apply db/16-thought-metadata-revisions.sql and db/17-forget-thoughts.sql",
      ],
      [
        "another CHECK reads change_kind",
        { narrowing: ["drift_a", "drift_b"] },
        true,
        "constrained only by thought_revisions_change_kind; drop drift_a, drift_b",
      ],
    ];
    for (const [label, database, primaryEnabled, message] of cases) {
      for (const apply of [false, true]) {
        await t.step(`${label} (${apply ? "apply" : "plan"})`, async () => {
          const { client } = fakeDatabase(corpus(), database);
          const emitted: unknown[] = [];
          const { texts, classify } = classifier(() => ok(OBSERVATION));
          await assertRejects(
            () =>
              reclassifyMetadata(
                client as unknown as PoolClient,
                { apply },
                {
                  primaryEnabled,
                  primary: PRIMARY,
                  classify,
                  emit: (record) => emitted.push(record),
                },
              ),
            Error,
            message,
          );
          assertEquals(texts, [], "nothing may reach the classifier");
          assertEquals(emitted, []);
          assertEquals(
            sqlOf(client).some((sql) => sql.includes("FROM public.thoughts")),
            false,
            "no thought may be read before every refusal check passes",
          );
        });
      }
    }
  }),
);

Deno.test(
  "metadata reclassify plan selects only unstamped and stub rows and writes nothing",
  withEnv([], ENV, async () => {
    const { reclassifyExitCode, reclassifyMetadata } = await import(
      "./metadata_reclassify.ts"
    );
    const run = async (options: Record<string, unknown>) => {
      const { client } = fakeDatabase(corpus());
      const emitted: Record<string, unknown>[] = [];
      const { texts, classify } = classifier(() => ok(OBSERVATION));
      const summary = await reclassifyMetadata(
        client as unknown as PoolClient,
        options,
        {
          primaryEnabled: true,
          primary: PRIMARY,
          classify,
          emit: (r) => emitted.push(r),
        },
      );
      assertEquals(texts, [], "plan never contacts the classifier");
      assertEquals(writes(client), [], "plan never writes");
      return { client, emitted, summary, exit: reclassifyExitCode(summary) };
    };

    const all = await run({});
    const listing = all.client.queryObjectCalls.find((c) =>
      c.sql.includes("ORDER BY t.created_at, t.id")
    );
    assert(listing);
    // Forgotten thoughts are never sent to the classifier.
    assert(listing.sql.includes("t.forgotten_at IS NULL"));
    assert(listing.sql.includes("NOT (t.metadata ? 'metadata_extraction')"));
    assert(
      listing.sql.includes(
        "t.metadata->'metadata_extraction'->>'endpoint' = 'stub'",
      ),
    );
    assertEquals(listing.params, [null]);
    assertEquals(all.emitted, [
      {
        id: ID_A,
        outcome: "would_reclassify",
        before: { type: "task", topics: ["report"] },
      },
      {
        id: ID_B,
        outcome: "would_reclassify",
        before: { type: "observation", topics: ["uncategorized"] },
      },
      {
        summary: {
          mode: "plan",
          primary: PRIMARY,
          candidates: 2,
          selected: 2,
          would_reclassify: 2,
          reclassified: 0,
          primary_failed: 0,
          changed_concurrently: 0,
          not_candidate: 0,
        },
      },
    ]);
    assertEquals(all.exit, 0);

    // Programmatic ids are compared the way PostgreSQL prints uuids.
    const restricted = await run({
      ids: [ID_C, ID_A.toUpperCase(), UNKNOWN, ID_D],
    });
    assertEquals(
      restricted.client.queryObjectCalls.find((c) =>
        c.sql.includes("ORDER BY t.created_at, t.id")
      )?.params,
      [[ID_C, ID_A, UNKNOWN, ID_D]],
    );
    assertEquals(
      restricted.emitted.slice(0, -1).map((r) => [r.id, r.outcome]),
      [
        [ID_C, "not_candidate"],
        [UNKNOWN, "not_candidate"],
        [ID_D, "not_candidate"],
        [ID_A, "would_reclassify"],
      ],
    );
    assertEquals(restricted.summary.not_candidate, 3);
    assertEquals(restricted.exit, 0, "not_candidate is informational");

    const limited = await run({ limit: 1 });
    assertEquals(limited.emitted.slice(0, -1).map((r) => r.id), [ID_A]);
    assertEquals(
      [limited.summary.candidates, limited.summary.selected],
      [2, 1],
    );
  }),
);

Deno.test(
  "metadata reclassify apply replaces classifier fields, keeps capture stamps, and records a 'metadata' revision",
  withEnv([], ENV, async () => {
    const { reclassifyExitCode, reclassifyMetadata } = await import(
      "./metadata_reclassify.ts"
    );
    const thoughts = corpus();
    const original = structuredClone(thoughts[0]);
    const { client, revisions } = fakeDatabase(thoughts);
    const emitted: Record<string, unknown>[] = [];
    // An injected classifier that tries to impersonate server-owned keys.
    const { texts, classify } = classifier(() =>
      ok({
        ...OBSERVATION,
        source: "forged",
        door: "forged",
        sub: "forged",
        token_label: "forged",
        provenance: { forged: true },
        metadata_extraction: { schema_version: 1, endpoint: "fallback" },
      })
    );
    const summary = await reclassifyMetadata(
      client as unknown as PoolClient,
      { apply: true, ids: [ID_A] },
      {
        primaryEnabled: true,
        primary: PRIMARY,
        classify,
        emit: (r) => emitted.push(r),
      },
    );
    assertEquals(texts, [original.content]);
    assertEquals(reclassifyExitCode(summary), 0);
    assertEquals(summary.reclassified, 1);

    assertEquals(
      client.queryArrayCalls.map((c) => c.sql).filter((sql) =>
        ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
      ),
      ["BEGIN", "COMMIT"],
    );
    const lock = client.queryObjectCalls.find((c) =>
      c.sql.includes("AS unchanged")
    );
    assert(lock);
    assert(lock.sql.includes("FOR UPDATE"));
    // A thought forgotten after the re-read is not written.
    assert(lock.sql.includes("t.forgotten_at IS NULL"));
    assertEquals(lock.params, [
      ID_A,
      original.content,
      JSON.stringify(original.metadata),
    ]);

    const insert = client.queryArrayCalls.find((c) =>
      c.sql.includes("INSERT INTO public.thought_revisions")
    );
    assert(insert);
    assert(insert.sql.includes("'metadata'"));
    assert(insert.sql.includes("COALESCE(max(r.revision), 0) + 1"));
    assertEquals(insert.params, [ID_A, "maintenance"]);
    assertEquals(revisions, [{ thoughtId: ID_A, door: "maintenance" }]);

    const update = client.queryObjectCalls.find((c) =>
      c.sql.includes("UPDATE public.thoughts AS t")
    );
    assert(update);
    assertEquals(JSON.parse(update.params[1] as string), {
      ...OBSERVATION,
      metadata_extraction: {
        schema_version: 1,
        endpoint: "primary",
        model: "local-model",
      },
    });
    assertEquals(update.params[2], PRESERVED);

    // The fake applies the same merge the SQL performs.
    assertEquals(thoughts[0].metadata, {
      ...OBSERVATION,
      metadata_extraction: {
        schema_version: 1,
        endpoint: "primary",
        model: "local-model",
      },
      ...CAPTURE_STAMPS,
    });
    assertEquals(emitted, [
      {
        id: ID_A,
        outcome: "reclassified",
        before: { type: "task", topics: ["report"] },
        after: { type: "observation", topics: ["report", "history"] },
      },
      {
        summary: {
          mode: "apply",
          primary: PRIMARY,
          candidates: 1,
          selected: 1,
          would_reclassify: 0,
          reclassified: 1,
          primary_failed: 0,
          changed_concurrently: 0,
          not_candidate: 0,
        },
      },
    ]);

    // Privacy: output names the change, never the thought or its details.
    const printed = JSON.stringify(emitted);
    for (
      const secret of [
        original.content,
        "Fixture Person",
        "fixture action item",
        "2026-01-02",
        "subject-a",
      ]
    ) {
      assertEquals(printed.includes(secret), false, secret);
    }
    assertEquals(
      sqlOf(client).some((sql) => sql.includes("metadata_degradation")),
      false,
      "the capture-path degradation ledger is not written",
    );
  }),
);

Deno.test(
  "metadata reclassify leaves the row untouched when the primary fails",
  withEnv([], ENV, async () => {
    const { reclassifyExitCode, reclassifyMetadata } = await import(
      "./metadata_reclassify.ts"
    );
    const thoughts = corpus();
    const before = structuredClone(thoughts);
    const { client } = fakeDatabase(thoughts);
    const emitted: Record<string, unknown>[] = [];
    const { texts, classify } = classifier((text) =>
      text === thoughts[0].content
        ? { ok: false, reason: "transport_or_timeout" }
        : text === thoughts[1].content
        ? { ok: false, reason: "non_2xx", status: 401 }
        : ok(OBSERVATION)
    );
    const summary = await reclassifyMetadata(
      client as unknown as PoolClient,
      { apply: true, ids: [ID_A, ID_B] },
      {
        primaryEnabled: true,
        primary: PRIMARY,
        classify,
        emit: (r) => emitted.push(r),
      },
    );
    assertEquals(texts.length, 2);
    assertEquals(emitted.slice(0, 2), [
      {
        id: ID_A,
        outcome: "primary_failed",
        reason: "transport_or_timeout",
        before: { type: "task", topics: ["report"] },
      },
      {
        // The status tells a bad key or base path from an overloaded primary.
        id: ID_B,
        outcome: "primary_failed",
        reason: "non_2xx",
        http_status: 401,
        before: { type: "observation", topics: ["uncategorized"] },
      },
    ]);
    assertEquals(summary.primary_failed, 2);
    assertEquals(reclassifyExitCode(summary), 2);
    assertEquals(writes(client), [], "a failed row opens no transaction");
    assertEquals(thoughts, before);
  }),
);

Deno.test(
  "metadata reclassify writes nothing for a row changed after classification",
  withEnv([], ENV, async (t) => {
    const { reclassifyExitCode, reclassifyMetadata } = await import(
      "./metadata_reclassify.ts"
    );
    await t.step("edited between classify and lock", async () => {
      const thoughts = corpus();
      const { client, revisions } = fakeDatabase(thoughts);
      const emitted: Record<string, unknown>[] = [];
      const { classify } = classifier(() => {
        // A concurrent writer (e.g. update_thought) commits while the
        // classifier runs; the row stays a candidate but no longer matches.
        thoughts[0].metadata = { ...thoughts[0].metadata, type: "idea" };
        return ok(OBSERVATION);
      });
      const summary = await reclassifyMetadata(
        client as unknown as PoolClient,
        { apply: true, ids: [ID_A] },
        {
          primaryEnabled: true,
          primary: PRIMARY,
          classify,
          emit: (r) => emitted.push(r),
        },
      );
      assertEquals(emitted[0], {
        id: ID_A,
        outcome: "changed_concurrently",
        before: { type: "task", topics: ["report"] },
      });
      assertEquals(reclassifyExitCode(summary), 2);
      assertEquals(
        client.queryArrayCalls.map((c) => c.sql).filter((sql) =>
          ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
        ),
        ["BEGIN", "ROLLBACK"],
      );
      assertEquals(revisions, []);
      assertEquals(
        sqlOf(client).some((sql) => sql.includes("UPDATE public.thoughts")),
        false,
      );
      assertEquals(thoughts[0].metadata.type, "idea");
    });

    await t.step("no longer a candidate when re-read", async () => {
      const thoughts = corpus();
      const { client, revisions } = fakeDatabase(thoughts);
      const emitted: Record<string, unknown>[] = [];
      const { texts, classify } = classifier(() => {
        // While A is classified, B is reclassified elsewhere.
        thoughts[1].metadata = {
          ...thoughts[1].metadata,
          metadata_extraction: { schema_version: 1, endpoint: "primary" },
        };
        return ok(OBSERVATION);
      });
      const summary = await reclassifyMetadata(
        client as unknown as PoolClient,
        { apply: true },
        {
          primaryEnabled: true,
          primary: PRIMARY,
          classify,
          emit: (r) => emitted.push(r),
        },
      );
      assertEquals(texts, [thoughts[0].content], "B is never classified");
      assertEquals(emitted.slice(0, -1).map((r) => [r.id, r.outcome]), [
        [ID_A, "reclassified"],
        [ID_B, "changed_concurrently"],
      ]);
      assertEquals(revisions.map((r) => r.thoughtId), [ID_A]);
      assertEquals(reclassifyExitCode(summary), 2);
    });
  }),
);

Deno.test(
  "metadata reclassify rolls back a failed write and preserves the first error",
  withEnv([], ENV, async (t) => {
    const { reclassifyMetadata } = await import("./metadata_reclassify.ts");
    for (const rollbackFails of [false, true]) {
      await t.step(
        `rollback ${rollbackFails ? "fails" : "succeeds"}`,
        async () => {
          const original = new Error("revision insert connection reset");
          const { client } = fakeDatabase(corpus(), {
            failOn: (sql) =>
              sql.includes("INSERT INTO public.thought_revisions")
                ? original
                : rollbackFails && sql === "ROLLBACK"
                ? new Error("rollback connection lost")
                : undefined,
          });
          const emitted: unknown[] = [];
          const error = await assertRejects(() =>
            reclassifyMetadata(
              client as unknown as PoolClient,
              { apply: true },
              {
                primaryEnabled: true,
                primary: PRIMARY,
                classify: () => Promise.resolve(ok(OBSERVATION)),
                emit: (r) => emitted.push(r),
              },
            )
          );
          assertStrictEquals(error, original);
          assertEquals(
            client.queryArrayCalls.filter(({ sql }) => sql === "ROLLBACK")
              .length,
            1,
          );
          assertEquals(
            sqlOf(client).some((sql) => sql.includes("UPDATE public.thoughts")),
            false,
          );
          assertEquals(emitted, [], "an aborted run emits no summary");
        },
      );
    }
  }),
);
