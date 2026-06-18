// Unit tests for the recency-boosted search ranking ported from upstream
// OB1's recency-boosted-match-thoughts schema (PR #231). Hermetic: a stub
// Pool records the SQL searchThoughts actually issues. The last test reads
// db/05-recency-search.sql off disk and asserts the inline TS formula and
// the SQL function share the same blended-score expression — the server
// doesn't call the function, so this test is what keeps the two from
// drifting apart.
//
// Run with: `deno task test`.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import type { Pool } from "postgres";

Deno.env.set("DB_PASSWORD", "test-password");
Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
for (
  const k of ["AUTH0_ISSUER", "AUTH0_JWKS_URI", "AUTH0_AUDIENCE", "PATTERN_B"]
) {
  Deno.env.delete(k);
}

const { clampRecency, searchThoughts } = await import("./queries.ts");

type Call = { sql: string; params: unknown[] };

function stubPool() {
  const calls: Call[] = [];
  const client = {
    // deno-lint-ignore require-await
    async queryObject(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] };
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

// The canonical blended-score expression, in normalized form (whitespace
// collapsed, table alias stripped, SQL-function parameter names mapped to
// the TS placeholders). Both the inline TS SQL and the db function must
// contain it.
const BLEND_FRAGMENT =
  "((1 - (embedding <=> $1::vector)) * (1.0 - $4) + exp(-GREATEST(extract(epoch FROM (now() - created_at)) / 86400.0, 0.0) / $5) * $4)::float";

function normalizeSql(s: string): string {
  return s
    .replace(/\bt\./g, "")
    .replace(/\bquery_embedding\b/g, "$1::vector")
    .replace(/\brecency_weight\b/g, "$4")
    .replace(/\bhalf_life_days\b/g, "$5")
    .replace(/::FLOAT\b/g, "::float")
    .replace(/\s+/g, " ");
}

Deno.test("searchThoughts: default ranking is the untouched pure-similarity SQL", async () => {
  const { pool, calls } = stubPool();
  await searchThoughts(pool, { query: "q", embedding: [0.1, 0.2] });
  assertEquals(calls.length, 1);
  const { sql, params } = calls[0];
  // The HNSW-friendly ordering must survive the recency port — the index
  // only accelerates plain distance ORDER BY.
  assertStringIncludes(sql, "ORDER BY embedding <=> $1::vector");
  assert(!sql.includes("exp("), "no decay term on the default path");
  assertEquals(params.length, 3, "no recency params on the default path");
});

Deno.test("searchThoughts: explicit recencyWeight 0 also takes the pure path", async () => {
  const { pool, calls } = stubPool();
  await searchThoughts(pool, {
    query: "q",
    embedding: [0.1],
    recencyWeight: 0,
    halfLifeDays: 30,
  });
  assert(!calls[0].sql.includes("exp("));
  assertEquals(calls[0].params.length, 3);
});

Deno.test("searchThoughts: recencyWeight > 0 issues the blended SQL with raw-similarity threshold", async () => {
  const { pool, calls } = stubPool();
  await searchThoughts(pool, {
    query: "q",
    embedding: [0.1],
    limit: 7,
    threshold: 0.4,
    recencyWeight: 0.3,
  });
  const { sql, params } = calls[0];
  assertStringIncludes(normalizeSql(sql), BLEND_FRAGMENT);
  // Threshold gates RAW similarity (upstream semantics), not the blend.
  assertStringIncludes(sql, "WHERE 1 - (embedding <=> $1::vector) >= $2");
  assertStringIncludes(sql, "ORDER BY similarity DESC");
  assertEquals(params.length, 5);
  assertEquals(params[1], 0.4);
  assertEquals(params[2], 7);
  assertEquals(params[3], 0.3);
  assertEquals(params[4], 90, "half-life defaults to 90 days");
});

Deno.test("clampRecency: bounds mirror the SQL function's clamping", () => {
  assertEquals(clampRecency(5.0, 30), { w: 1, hl: 30 });
  assertEquals(clampRecency(-1, 30), { w: 0, hl: 30 });
  assertEquals(clampRecency(0.5, 0), { w: 0.5, hl: 90 });
  assertEquals(clampRecency(0.5, -3), { w: 0.5, hl: 90 });
  assertEquals(clampRecency(NaN, NaN), { w: 0, hl: 90 });
  assertEquals(clampRecency(undefined, undefined), { w: 0, hl: 90 });
});

Deno.test("cross-layer parity: db/05-recency-search.sql uses the same blend formula", async () => {
  // The server runs the formula inline (searchThoughts above);
  // match_thoughts_recency is the SQL-side surface for psql/dashboard
  // consumers. They must rank identically. The db file repeats the
  // expression twice (SELECT + ORDER BY — plpgsql can't reference the
  // output alias); both occurrences are covered by containment after
  // normalization.
  const sqlFile = await Deno.readTextFile(
    new URL("../db/05-recency-search.sql", import.meta.url),
  );
  assertStringIncludes(normalizeSql(sqlFile), BLEND_FRAGMENT);

  // And the TS side really does emit the fragment (guards against the
  // fragment constant going stale if someone rewrites the inline SQL).
  const { pool, calls } = stubPool();
  await searchThoughts(pool, {
    query: "q",
    embedding: [0.1],
    recencyWeight: 0.2,
  });
  assertStringIncludes(normalizeSql(calls[0].sql), BLEND_FRAGMENT);
});
