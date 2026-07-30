// Hermetic tests for the production hybrid-search query and RRF fusion.

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { asPool, FAKE_VECTOR, FakePool } from "./api_test_support.ts";
import type { HybridCandidate } from "./queries.ts";
import type { ResolvedReadScope } from "./scope_contract.ts";

// queries.ts imports embeddings.ts, whose configuration validates at module
// load. Set the one required value before the dynamic import, matching the
// existing service/API test pattern.
Deno.env.set("DB_PASSWORD", "test-password");
Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
Deno.env.set("METADATA_FALLBACK_POLICY", "off");

const {
  DEFAULT_RRF_K,
  escapeLike,
  fuseHybridCandidates,
  hasIndexableLiteralTrigram,
  MIN_HYBRID_CANDIDATES_PER_LEG,
  searchThoughts,
} = await import("./queries.ts");

const DEFAULT_SCOPE: ResolvedReadScope = {
  workspaceId: "default",
  projectId: null,
  visibilities: ["workspace"],
  principal: null,
};

function candidate(
  id: string,
  vectorRank: number | null,
  lexicalRank: number | null,
  similarity: string | number | null = 0.5,
  lexicalSourcePriority: number | null = lexicalRank === null ? null : 1,
): HybridCandidate {
  return {
    id,
    content: `thought ${id}`,
    metadata: {},
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
    created_at: "2026-07-25T00:00:00Z",
    similarity,
    vector_rank: vectorRank,
    lexical_rank: lexicalRank,
    lexical_source_priority: lexicalSourcePriority,
  };
}

Deno.test("RRF fusion: cross-leg consensus ties A and C at the top", () => {
  const fused = fuseHybridCandidates([
    candidate("D", null, 2),
    candidate("B", 2, null),
    candidate("C", 3, 1),
    candidate("A", 1, 3, "0.91"),
  ], 4);

  assertEquals(fused.map((row) => row.id), ["A", "C", "B", "D"]);
  const expectedConsensus = 1 / (DEFAULT_RRF_K + 1) +
    1 / (DEFAULT_RRF_K + 3);
  assertAlmostEquals(fused[0].rrf_score, expectedConsensus);
  assertAlmostEquals(fused[1].rrf_score, expectedConsensus);
  assert(fused[0].rrf_score > fused[2].rrf_score);
  assertEquals(fused[0].similarity, 0.91);
  assertEquals("vector_rank" in fused[0], false);
  assertEquals("lexical_rank" in fused[0], false);
  assertEquals("lexical_source_priority" in fused[0], false);
});

Deno.test("RRF fusion: a true full-text hit wins an equal cross-leg rank", () => {
  const fused = fuseHybridCandidates([
    candidate("a-vector", 1, null),
    candidate("z-full-text", null, 1, 0.1, 0),
  ], 2);

  assertEquals(fused.map((row) => row.id), ["z-full-text", "a-vector"]);
  assertAlmostEquals(fused[0].rrf_score, fused[1].rrf_score);
});

Deno.test("RRF fusion: final limit and invalid numeric values are bounded", () => {
  const fused = fuseHybridCandidates(
    [
      candidate("B", 2, null, Number.NaN),
      candidate("A", 1, null, null),
    ],
    1,
    Number.NaN,
  );
  assertEquals(fused.length, 1);
  assertEquals(fused[0].id, "A");
  assertEquals(fused[0].similarity, 0);
  assertAlmostEquals(fused[0].rrf_score, 1 / (DEFAULT_RRF_K + 1));
});

Deno.test("escapeLike: trigram fallback treats wildcard characters literally", () => {
  assertEquals(
    escapeLike("OPS-275_search%\\path"),
    "OPS-275\\_search\\%\\\\path",
  );
});

Deno.test("literal fallback: only indexable trigram patterns are admitted", () => {
  assert(hasIndexableLiteralTrigram("OPS-275"));
  assert(hasIndexableLiteralTrigram("search_thoughts_v2"));
  assert(hasIndexableLiteralTrigram("猫猫猫"));
  assertEquals(hasIndexableLiteralTrigram("ab"), false);
  assertEquals(hasIndexableLiteralTrigram("a-b"), false);
  assertEquals(hasIndexableLiteralTrigram("---"), false);
});

Deno.test("searchThoughts: emits bounded vector and lexical candidate legs", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const statements: string[] = [];
  const pool = new FakePool((sql, params) => {
    statements.push(sql.trim());
    if (!sql.includes("search_thought_candidates")) return undefined;
    capturedSql = sql;
    capturedParams = params;
    return {
      rows: [
        candidate("lexical", null, 1, "0.12"),
        candidate("consensus", 1, 2, "0.88"),
      ],
    };
  });

  const query = "OPS-275_search%\\path";
  const rows = await searchThoughts(asPool(pool), {
    query,
    embedding: FAKE_VECTOR,
    limit: 3,
    threshold: 0.7,
    scope: DEFAULT_SCOPE,
  });

  assertEquals(capturedParams, [
    `[${FAKE_VECTOR.join(",")}]`,
    0.7,
    query,
    "OPS-275\\_search\\%\\\\path",
    true,
    null,
    "[]",
    MIN_HYBRID_CANDIDATES_PER_LEG,
  ]);
  assertEquals(statements.includes("BEGIN"), true);
  assertEquals(
    statements.includes(
      "SELECT set_config('hnsw.ef_search', $1::text, true)",
    ),
    true,
  );
  assertEquals(statements[statements.length - 1], "COMMIT");
  assertStringIncludes(capturedSql, "memory_scope.search_thought_candidates(");
  assertStringIncludes(capturedSql, "$6::jsonb");
  assertStringIncludes(capturedSql, "$7::jsonb");
  assertStringIncludes(capturedSql, "$8::int");
  assertStringIncludes(
    capturedSql,
    "JOIN thoughts ON thoughts.id = candidates.candidate_id",
  );
  assertEquals(rows.map((row) => row.id), ["consensus", "lexical"]);
  assertEquals(rows[1].similarity, 0.12);
  assert(rows[1].rrf_score > 0, "lexical-only hit must survive fusion");
});

Deno.test("searchThoughts: one bound provenance predicate is applied to both legs", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  const statements: string[] = [];
  const pool = new FakePool((sql, params) => {
    statements.push(sql.trim());
    if (sql.includes("search_thought_candidates")) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
    return undefined;
  });

  await searchThoughts(asPool(pool), {
    query: "release checklist",
    embedding: FAKE_VECTOR,
    limit: 75,
    filter: {
      include: { repo: "example/open-brain" },
      exclude: { author: "release engineering" },
    },
    scope: DEFAULT_SCOPE,
  });

  assertEquals(statements.includes("BEGIN"), true);
  assertEquals(
    statements.includes(
      "SELECT set_config('hnsw.ef_search', $1::text, true)",
    ),
    true,
  );
  assertEquals(
    statements.includes("SET LOCAL hnsw.iterative_scan = strict_order"),
    true,
  );
  assertEquals(statements[statements.length - 1], "COMMIT");
  assertEquals(capturedParams, [
    `[${FAKE_VECTOR.join(",")}]`,
    0.5,
    "release checklist",
    "release checklist",
    true,
    JSON.stringify({
      provenance: { caller_asserted: { repo: "example/open-brain" } },
    }),
    JSON.stringify([{
      provenance: { caller_asserted: { author: "release engineering" } },
    }]),
    75,
  ]);
  assertStringIncludes(capturedSql, "memory_scope.search_thought_candidates(");
  assertStringIncludes(capturedSql, "$6::jsonb");
  assertStringIncludes(capturedSql, "$7::jsonb");
  assertStringIncludes(capturedSql, "$8::int");
});
