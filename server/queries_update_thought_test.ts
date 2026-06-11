// Unit tests for queries.ts/updateThought — the optimistic-concurrency CAS
// ported from upstream OB1's update-thought-mcp (PR #228). Hermetic: a stub
// Pool records SQL + params and plays back scripted responses, so the tests
// exercise the real outcome-mapping logic without a live postgres.
//
// queries.ts transitively imports config.ts (via embeddings.ts), which
// fail-fast validates env at module load — so the required env is set BEFORE
// the dynamic import below, following the config_pattern_b_test.ts idiom.
//
// Run with: `deno task test`.

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import type { Pool } from "postgres";

Deno.env.set("DB_PASSWORD", "test-password");
Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
// Ensure a host shell with OAuth vars exported can't trip the Pattern B
// fail-fast during the config.ts module load.
for (
  const k of ["AUTH0_ISSUER", "AUTH0_JWKS_URI", "AUTH0_AUDIENCE", "PATTERN_B"]
) {
  Deno.env.delete(k);
}

const { captureThought, fingerprintSqlExpr, updateThought } = await import(
  "./queries.ts"
);

type Call = { sql: string; params: unknown[] };

// Minimal stand-in for the deno-postgres Pool surface queries.ts touches:
// connect() → { queryObject, release }. Each queryObject call is answered by
// the next scripted entry — an array of rows, or a value to `throw`.
function stubPool(script: Array<unknown[] | { throw: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const client = {
    // deno-lint-ignore require-await
    async queryObject(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const step = script[i++];
      if (step === undefined) {
        throw new Error(`stubPool: unscripted call #${i}: ${sql}`);
      }
      if (typeof step === "object" && step !== null && "throw" in step) {
        throw (step as { throw: unknown }).throw;
      }
      return { rows: step };
    },
    release() {},
  };
  const pool = {
    // deno-lint-ignore require-await
    async connect() {
      return client;
    },
  } as unknown as Pool;
  return { pool, calls };
}

Deno.test("updateThought: full update maps to 'updated' and issues the CAS SQL", async () => {
  const { pool, calls } = stubPool([
    [{ id: "11111111-1111-4111-8111-111111111111", updated_at: "2026-06-11T00:00:00.000Z" }],
  ]);
  const out = await updateThought(pool, {
    id: "11111111-1111-4111-8111-111111111111",
    content: "new text",
    embedding: [0.25, 0.5],
    metadataPatch: { door: "tailnet", sub: null },
    ifUnchangedSince: "2026-06-10T00:00:00Z",
  });
  assertEquals(out, {
    kind: "updated",
    id: "11111111-1111-4111-8111-111111111111",
    updated_at: "2026-06-11T00:00:00.000Z",
  });

  assertEquals(calls.length, 1, "single atomic UPDATE — no read-then-write");
  const { sql, params } = calls[0];
  // The compare-and-set guard: ms-truncated on BOTH sides (JS Date reference
  // is ms-precision, postgres stores µs), null reference = last-write-wins.
  assertStringIncludes(sql, "$5::timestamptz IS NULL");
  assertStringIncludes(sql, "date_trunc('milliseconds', updated_at)");
  assertStringIncludes(sql, "date_trunc('milliseconds', $5::timestamptz)");
  // Shallow metadata merge in SQL.
  assertStringIncludes(sql, "metadata = metadata || $4::jsonb");
  assertEquals(params[0], "11111111-1111-4111-8111-111111111111");
  assertEquals(params[1], "new text");
  assertStringIncludes(String(params[2]), "0.25", "pgvector literal");
  assertEquals(params[3], JSON.stringify({ door: "tailnet", sub: null }));
  assertEquals(params[4], "2026-06-10T00:00:00Z");
});

Deno.test("updateThought: omitted ifUnchangedSince passes null (last-write-wins)", async () => {
  const { pool, calls } = stubPool([
    [{ id: "a", updated_at: "x" }],
  ]);
  await updateThought(pool, {
    id: "a",
    metadataPatch: { door: "funnel", sub: "user-1" },
  });
  const { params } = calls[0];
  assertEquals(params[1], null, "content omitted → COALESCE keeps old text");
  assertEquals(params[2], null, "embedding omitted → COALESCE keeps old vector");
  assertEquals(params[4], null, "no reference timestamp → CAS guard disabled");
});

Deno.test("updateThought: zero rows + existing row maps to 'stale' with current_updated_at", async () => {
  const { pool, calls } = stubPool([
    [], // CAS UPDATE matched nothing
    [{ updated_at: "2026-06-11T09:00:00.000Z" }], // probe finds the row
  ]);
  const out = await updateThought(pool, {
    id: "a",
    metadataPatch: {},
    ifUnchangedSince: "2026-06-01T00:00:00Z",
  });
  assertEquals(out, {
    kind: "stale",
    current_updated_at: "2026-06-11T09:00:00.000Z",
  });
  assertStringIncludes(calls[1].sql, "SELECT updated_at FROM thoughts");
});

Deno.test("updateThought: zero rows + no row maps to 'not_found'", async () => {
  const { pool } = stubPool([
    [], // CAS UPDATE matched nothing
    [], // probe finds nothing either
  ]);
  const out = await updateThought(pool, { id: "a", metadataPatch: {} });
  assertEquals(out, { kind: "not_found" });
});

Deno.test("updateThought: unique violation (23505) recovers the duplicate's id", async () => {
  const { pool, calls } = stubPool([
    { throw: { fields: { code: "23505" } } }, // partial unique index fires
    [{ id: "22222222-2222-4222-8222-222222222222" }],
  ]);
  const out = await updateThought(pool, {
    id: "a",
    content: "text that collides with another row",
    embedding: [0.1],
    metadataPatch: {},
  });
  assertEquals(out, {
    kind: "fingerprint_conflict",
    existing_id: "22222222-2222-4222-8222-222222222222",
  });
  // Recovery lookup must compute the fingerprint with the SAME shared
  // expression the write paths use.
  assertStringIncludes(calls[1].sql, fingerprintSqlExpr("$1"));
});

Deno.test("updateThought: non-unique-violation errors rethrow untouched", async () => {
  const { pool } = stubPool([
    { throw: new Error("connection reset") },
  ]);
  await assertRejects(
    () => updateThought(pool, { id: "a", metadataPatch: {} }),
    Error,
    "connection reset",
  );
});

Deno.test("fingerprint parity: captureThought and updateThought share one SQL expression", async () => {
  // Capture the SQL each write path actually issues, then assert both embed
  // the shared fingerprint expression for their respective content param.
  // Guards against someone re-inlining a divergent copy in either path —
  // a drifted normalization would silently break dedupe between
  // capture-then-update flows.
  const cap = stubPool([[{ id: "x" }]]);
  await captureThought(cap.pool, {
    content: "c",
    embedding: [0.1],
    metadata: {},
  });
  const upd = stubPool([[{ id: "x", updated_at: "y" }]]);
  await updateThought(upd.pool, {
    id: "x",
    content: "c2",
    embedding: [0.1],
    metadataPatch: {},
  });
  assertStringIncludes(cap.calls[0].sql, fingerprintSqlExpr("$1"));
  assertStringIncludes(upd.calls[0].sql, fingerprintSqlExpr("$2"));
});
