// Pure SQL business logic. No HTTP concerns. A future REST gateway, CLI, or
// scheduled job can call these same functions without touching the MCP layer.

import { Pool } from "postgres";
import { getClient } from "./db_pool.ts";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { toVectorLiteral } from "./embeddings.ts";
import { withScopeClient } from "./scoped_db.ts";
import {
  THOUGHT_PROVENANCE_FIELDS,
  type ThoughtProvenanceClaims,
  type ThoughtSearchFilter,
} from "./schemas.ts";
import type {
  ResolvedReadScope,
  ResolvedWriteScope,
} from "./scope_contract.ts";

export type SearchOptions = {
  query: string;
  embedding: number[];
  limit?: number;
  threshold?: number;
  filter?: ThoughtSearchFilter;
  scope: ResolvedReadScope;
};

// RRF is intentionally rank-only: vector cosine and ts_rank_cd use unrelated
// scales, while rank positions can be combined without normalization. k=60 is
// the conventional conservative default; at least 50 candidates per leg keeps
// exact lexical hits available without turning final LIMIT into an unbounded
// scan. Requests above 50 raise the per-leg depth to preserve their limit.
export const DEFAULT_RRF_K = 60;
export const MIN_HYBRID_CANDIDATES_PER_LEG = 50;

export type HybridCandidate = Omit<ThoughtMatch, "similarity" | "rrf_score"> & {
  similarity: string | number | null;
  vector_rank: string | number | bigint | null;
  lexical_rank: string | number | bigint | null;
  lexical_source_priority: string | number | null;
};

function positiveRank(value: HybridCandidate["vector_rank"]): number | null {
  if (value === null || value === undefined) return null;
  const rank = Number(value);
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function finiteNumber(value: string | number | null): number {
  if (value === null) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Production fusion is kept pure so the scale-free ranking contract can be
// exercised hermetically. PostgreSQL returns only a bounded union of candidate
// rows and their per-leg ranks; this helper computes RRF, sorts, and applies the
// caller's final limit. A true full-text hit wins a cross-leg rank tie before
// ID supplies the final deterministic ordering; otherwise an unrelated vector
// row at rank N could beat an identifier hit at lexical rank N by UUID alone.
export function fuseHybridCandidates(
  candidates: HybridCandidate[],
  limit: number,
  k = DEFAULT_RRF_K,
): ThoughtMatch[] {
  const safeK = Number.isFinite(k) && k > 0 ? k : DEFAULT_RRF_K;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  return candidates.map((candidate) => {
    const vectorRank = positiveRank(candidate.vector_rank);
    const lexicalRank = positiveRank(candidate.lexical_rank);
    const rrfScore = (vectorRank === null ? 0 : 1 / (safeK + vectorRank)) +
      (lexicalRank === null ? 0 : 1 / (safeK + lexicalRank));
    const fullTextMatch = lexicalRank !== null &&
      candidate.lexical_source_priority !== null &&
      candidate.lexical_source_priority !== undefined &&
      Number(candidate.lexical_source_priority) === 0;
    const {
      vector_rank: _vectorRank,
      lexical_rank: _lexicalRank,
      lexical_source_priority: _lexicalSourcePriority,
      ...thought
    } = candidate;
    return {
      thought: {
        ...thought,
        similarity: finiteNumber(candidate.similarity),
        rrf_score: rrfScore,
      },
      fullTextMatch,
    };
  }).filter(({ thought }) => thought.rrf_score > 0)
    .sort((a, b) =>
      b.thought.rrf_score - a.thought.rrf_score ||
      Number(b.fullTextMatch) - Number(a.fullTextMatch) ||
      a.thought.id.localeCompare(b.thought.id)
    )
    .slice(0, safeLimit)
    .map(({ thought }) => thought);
}

// Escape ILIKE wildcards so the trigram fallback matches the caller's query as
// a literal substring, not a pattern. Backslash is the SQL ESCAPE character.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// A leading-and-trailing-wildcard pg_trgm search needs at least one complete
// alphanumeric trigram. Short word fragments otherwise have no extractable
// trigram and degenerate to a full-index scan. Punctuation splits words in
// pg_trgm, so count a contiguous run rather than total query length.
export function hasIndexableLiteralTrigram(value: string): boolean {
  return /[\p{L}\p{N}]{3}/u.test(value);
}

function provenanceMetadataFilter(
  claims: ThoughtProvenanceClaims,
): Record<string, unknown> {
  return {
    provenance: { caller_asserted: claims },
  };
}

function serializedThoughtSearchFilters(
  filter: ThoughtSearchFilter | undefined,
): { include: string | null; excludes: string } {
  const excludeFilters: Record<string, unknown>[] = [];
  if (filter?.exclude) {
    for (const field of THOUGHT_PROVENANCE_FIELDS) {
      const value = filter.exclude[field];
      if (value === undefined) continue;
      excludeFilters.push(provenanceMetadataFilter({ [field]: value }));
    }
  }
  return {
    include: filter?.include
      ? JSON.stringify(provenanceMetadataFilter(filter.include))
      : null,
    excludes: JSON.stringify(excludeFilters),
  };
}

export async function searchThoughts(
  pool: Pool,
  opts: SearchOptions,
): Promise<ThoughtMatch[]> {
  const { query, embedding, limit = 10, threshold = 0.5, filter, scope } = opts;
  const embStr = toVectorLiteral(embedding);
  const serializedFilters = serializedThoughtSearchFilters(filter);
  const candidateLimit = Math.max(MIN_HYBRID_CANDIDATES_PER_LEG, limit);
  const params: unknown[] = [
    embStr,
    threshold,
    query,
    escapeLike(query),
    hasIndexableLiteralTrigram(query),
    serializedFilters.include,
    serializedFilters.excludes,
    candidateLimit,
  ];
  return await withScopeClient(pool, scope, async (client) => {
    // hnsw.ef_search defaults to 40, which would silently cap an unfiltered
    // vector leg below the documented minimum of 50 candidates. Scope the
    // per-request depth to this transaction; set_config accepts a bound value
    // where SET LOCAL cannot. db/search-filter-plan-smoke.sql exercises the
    // same transaction-local settings against the deployed pgvector version.
    await client.queryArray(
      "SELECT set_config('hnsw.ef_search', $1::text, true)",
      [String(candidateLimit)],
    );

    // RLS audience predicates are residual filters on every request, just like
    // an optional provenance filter. Iterative HNSW scanning is therefore
    // required even for an otherwise-unfiltered default-workspace query.
    await client.queryArray(
      "SET LOCAL hnsw.iterative_scan = strict_order",
    );

    // FORCE RLS keeps every ordinary table path fail-closed, but PostgreSQL
    // deliberately will not push non-leakproof FTS/trigram/JSONB operators
    // ahead of an RLS barrier. The narrow SECURITY DEFINER function applies
    // the same audience predicate internally so those indexes remain usable
    // and returns IDs/ranks only. This outer join rechecks every ID through the
    // RLS-protected table before content can leave PostgreSQL.
    const result = await client.queryObject<HybridCandidate>(
      `SELECT thoughts.id, thoughts.content, thoughts.metadata,
              thoughts.workspace_id, thoughts.project_id, thoughts.visibility,
              thoughts.created_at,
              1 - (thoughts.embedding <=> $1::vector) AS similarity,
              candidates.vector_rank, candidates.lexical_rank,
              candidates.lexical_source_priority
       FROM memory_scope.search_thought_candidates(
         $1::vector,
         $2::double precision,
         $3::text,
         $4::text,
         $5::boolean,
         $6::jsonb,
         $7::jsonb,
         $8::int
       ) AS candidates
       JOIN thoughts ON thoughts.id = candidates.candidate_id`,
      params,
    );
    return fuseHybridCandidates(result.rows, limit);
  });
}

export type ListOptions = {
  limit?: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
};

export async function listThoughts(
  pool: Pool,
  opts: ListOptions,
  scope: ResolvedReadScope,
): Promise<ThoughtRecord[]> {
  const { limit = 10, type, topic, person, days } = opts;
  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (type) {
    conditions.push(`metadata->>'type' = $${p++}`);
    params.push(type);
  }
  if (topic) {
    conditions.push(`metadata->'topics' ? $${p++}`);
    params.push(topic);
  }
  if (person) {
    conditions.push(`metadata->'people' ? $${p++}`);
    params.push(person);
  }
  if (days && Number.isFinite(days)) {
    conditions.push(`created_at >= NOW() - ($${p++}::int * INTERVAL '1 day')`);
    params.push(Math.floor(days));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return await withScopeClient(pool, scope, async (client) => {
    const result = await client.queryObject<ThoughtRecord>(
      `SELECT id, content, metadata, workspace_id, project_id, visibility,
              created_at, updated_at
       FROM thoughts
       ${where}
       ORDER BY created_at DESC
       LIMIT $${p}`,
      [...params, limit],
    );
    return result.rows;
  });
}

export async function fetchThought(
  pool: Pool,
  id: string,
  scope: ResolvedReadScope,
): Promise<ThoughtRecord | null> {
  return await withScopeClient(pool, scope, async (client) => {
    const result = await client.queryObject<ThoughtRecord>(
      `SELECT id, content, metadata, workspace_id, project_id, visibility,
              created_at, updated_at
       FROM thoughts WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  });
}

export type CaptureInput = {
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  scope: ResolvedWriteScope;
};

export type CaptureOutcome = {
  id: string;
  metadata: Record<string, unknown>;
  workspace_id: string;
  project_id: string | null;
  visibility: "personal" | "project" | "workspace";
};

// Upsert by content fingerprint. The fingerprint is a SHA256 of the
// trimmed/lowercased/whitespace-collapsed content, computed inline so dedupe
// happens via the partial unique index on content_fingerprint. On conflict
// we refresh the embedding (in case the model changed) and merge any new
// metadata fields into the existing row's metadata.
export async function captureThought(
  pool: Pool,
  input: CaptureInput,
): Promise<CaptureOutcome> {
  const embStr = toVectorLiteral(input.embedding);
  return await withScopeClient(pool, input.scope, async (client) => {
    const result = await client.queryObject<CaptureOutcome>(
      `INSERT INTO thoughts (
         content, embedding, metadata, content_fingerprint,
         workspace_id, project_id, visibility, owner_subject
       )
       VALUES (
         $1,
         $2::vector,
         $3::jsonb,
         encode(
           sha256(
             convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')
           ),
           'hex'
         ),
         $4, $5, $6::memory_scope.visibility, $7
       )
       ON CONFLICT (
         workspace_id, project_id, visibility, owner_subject,
         content_fingerprint
       ) WHERE content_fingerprint IS NOT NULL
       DO UPDATE SET
         embedding = EXCLUDED.embedding,
         metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
         updated_at = now()
       RETURNING id, metadata, workspace_id, project_id, visibility`,
      [
        input.content,
        embStr,
        JSON.stringify(input.metadata),
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.visibility,
        input.scope.ownerSubject,
      ],
    );
    return result.rows[0];
  });
}

export type Stats = {
  count: number;
  earliest: string | null;
  latest: string | null;
  types: [string, number][];
  topics: [string, number][];
  people: [string, number][];
};

// Aggregation runs entirely in Postgres so memory cost stays constant as the
// thoughts table grows — previously this pulled every row to JS.
export async function getStats(
  pool: Pool,
  scope: ResolvedReadScope,
): Promise<Stats> {
  return await withScopeClient(pool, scope, async (client) => {
    const summaryRes = await client.queryObject<{
      count: number;
      earliest: string | null;
      latest: string | null;
    }>(
      `SELECT COUNT(*)::int AS count,
              MIN(created_at) AS earliest,
              MAX(created_at) AS latest
       FROM thoughts`,
    );

    const typesRes = await client.queryObject<{ k: string; c: number }>(
      `SELECT metadata->>'type' AS k, COUNT(*)::int AS c
       FROM thoughts
       WHERE metadata ? 'type'
       GROUP BY metadata->>'type'
       ORDER BY c DESC
       LIMIT 10`,
    );

    // The CASE expression replaces non-array values with an empty array
    // BEFORE jsonb_array_elements_text() runs. A separate WHERE-clause
    // guard isn't sufficient: in a LATERAL join the planner is free to
    // evaluate the SRF before applying the filter, which would still raise
    // "cannot extract elements from a scalar" on a malformed row. Wrapping
    // the SRF input in CASE makes correctness independent of plan choice.
    const topicsRes = await client.queryObject<{ k: string; c: number }>(
      `SELECT topic AS k, COUNT(*)::int AS c
       FROM thoughts,
            jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(metadata->'topics') = 'array'
                   THEN metadata->'topics'
                   ELSE '[]'::jsonb
              END
            ) AS topic
       GROUP BY topic
       ORDER BY c DESC
       LIMIT 10`,
    );

    const peopleRes = await client.queryObject<{ k: string; c: number }>(
      `SELECT person AS k, COUNT(*)::int AS c
       FROM thoughts,
            jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(metadata->'people') = 'array'
                   THEN metadata->'people'
                   ELSE '[]'::jsonb
              END
            ) AS person
       GROUP BY person
       ORDER BY c DESC
       LIMIT 10`,
    );

    const s = summaryRes.rows[0];
    return {
      count: s?.count ?? 0,
      earliest: s?.earliest ?? null,
      latest: s?.latest ?? null,
      types: typesRes.rows.map((r) => [r.k, r.c]),
      topics: topicsRes.rows.map((r) => [r.k, r.c]),
      people: peopleRes.rows.map((r) => [r.k, r.c]),
    };
  });
}

export async function pingDb(pool: Pool): Promise<boolean> {
  // getClient() validates the borrow with its own SELECT 1, so a successful
  // borrow already proves liveness — no second round-trip needed.
  const client = await getClient(pool);
  client.release();
  return true;
}
