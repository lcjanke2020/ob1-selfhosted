// Unit tests for the content_contains lexical fallback on listThoughts
// (idea ported from upstream OB1's text-search-trgm schema, PR #206 —
// the trigram index itself lives in db/06-text-search.sql). Hermetic:
// a stub Pool records the SQL listThoughts issues.
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

const { escapeLike, listThoughts } = await import("./queries.ts");

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

Deno.test("escapeLike: wildcards and the escape character match literally", () => {
  assertEquals(escapeLike("50%_off"), "50\\%\\_off");
  assertEquals(escapeLike("a\\b"), "a\\\\b");
  assertEquals(escapeLike("plain words"), "plain words");
  // A token that mixes all three specials.
  assertEquals(escapeLike("\\%_"), "\\\\\\%\\_");
});

Deno.test("listThoughts: content_contains compiles to a literal ILIKE filter", async () => {
  const { pool, calls } = stubPool();
  await listThoughts(pool, { contentContains: "ob1-smoke_50%" });
  const { sql, params } = calls[0];
  assertStringIncludes(sql, "content ILIKE '%' || $1 || '%' ESCAPE '\\'");
  assertEquals(params[0], "ob1-smoke\\_50\\%", "wildcards arrive escaped");
  assertEquals(params[1], 10, "default limit follows the filter params");
});

Deno.test("listThoughts: content_contains composes with the structured filters", async () => {
  const { pool, calls } = stubPool();
  await listThoughts(pool, {
    type: "task",
    contentContains: "deploy",
    limit: 25,
  });
  const { sql, params } = calls[0];
  assertStringIncludes(sql, "metadata->>'type' = $1");
  assertStringIncludes(sql, "content ILIKE '%' || $2 || '%' ESCAPE '\\'");
  assertStringIncludes(sql, "LIMIT $3");
  assertEquals(params, ["task", "deploy", 25]);
});

Deno.test("listThoughts: omitted content_contains leaves the SQL untouched", async () => {
  const { pool, calls } = stubPool();
  await listThoughts(pool, {});
  const { sql, params } = calls[0];
  assert(!sql.includes("ILIKE"), "no lexical filter on the default path");
  assert(!sql.includes("WHERE"), "no WHERE clause without filters");
  assertStringIncludes(sql, "LIMIT $1");
  assertEquals(params, [10]);
});
