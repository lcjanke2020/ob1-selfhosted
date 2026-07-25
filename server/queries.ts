// Pure SQL business logic. No HTTP concerns. A future REST gateway, CLI, or
// scheduled job can call these same functions without touching the MCP layer.

import { Pool } from "postgres";
import { getClient } from "./db_pool.ts";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { toVectorLiteral } from "./embeddings.ts";
import {
  THOUGHT_PROVENANCE_FIELDS,
  type ThoughtProvenanceClaims,
  type ThoughtSearchFilter,
} from "./schemas.ts";

export type SearchOptions = {
  query: string;
  embedding: number[];
  limit?: number;
  threshold?: number;
  filter?: ThoughtSearchFilter;
};

function provenanceMetadataFragment(
  claims: ThoughtProvenanceClaims,
): string {
  return JSON.stringify({
    provenance: { caller_asserted: claims },
  });
}

// Shared predicate builder for every thought-retrieval leg. A future vector +
// FTS query can call this once per leg so filtering happens before ranking and
// fusion without re-specifying its boolean or placeholder semantics.
function appendThoughtSearchFilter(
  conditions: string[],
  params: unknown[],
  filter: ThoughtSearchFilter | undefined,
): void {
  // Keep the positive terms in one top-level JSONB containment predicate.
  // PostgreSQL's default jsonb GIN operator class supports @>, so selective
  // includes can use idx_thoughts_metadata. Omit the predicate entirely for
  // unfiltered callers instead of hiding it behind a parameterized OR.
  if (filter?.include) {
    params.push(provenanceMetadataFragment(filter.include));
    conditions.push(`metadata @> $${params.length}::jsonb`);
  }

  // Exclusions are any-match deny terms. One NOT-containment predicate per
  // canonical field makes the boolean rule explicit: matching any supplied
  // value rejects the row. A missing claim yields @> false and therefore
  // survives, which keeps legacy/unclaimed rows in exclude-only searches.
  if (filter?.exclude) {
    for (const field of THOUGHT_PROVENANCE_FIELDS) {
      const value = filter.exclude[field];
      if (value === undefined) continue;
      params.push(provenanceMetadataFragment({ [field]: value }));
      conditions.push(`NOT (metadata @> $${params.length}::jsonb)`);
    }
  }
}

export async function searchThoughts(
  pool: Pool,
  opts: SearchOptions,
): Promise<ThoughtMatch[]> {
  const { embedding, limit = 10, threshold = 0.5, filter } = opts;
  const embStr = toVectorLiteral(embedding);
  const conditions = [`1 - (embedding <=> $1::vector) >= $2`];
  const params: unknown[] = [embStr, threshold];
  appendThoughtSearchFilter(conditions, params, filter);

  params.push(limit);
  const limitParam = params.length;
  const client = await getClient(pool);
  let transactionOpen = false;
  try {
    if (filter !== undefined) {
      // pgvector applies WHERE predicates after an approximate HNSW candidate
      // scan. Without an iterative scan, a metadata filter can discard the
      // initial candidate batch and return fewer than LIMIT even when eligible
      // rows remain. SET LOCAL keeps the fix scoped to this transaction so a
      // pooled connection cannot leak it into later unfiltered searches.
      await client.queryArray("BEGIN");
      transactionOpen = true;
      await client.queryArray(
        "SET LOCAL hnsw.iterative_scan = strict_order",
      );
    }

    // The distance expression decodes as text (same driver behavior
    // session_queries.ts narrows `score` for); type it honestly and expose a
    // JS number so JSON consumers don't receive `similarity` as a string.
    const result = await client.queryObject<
      Omit<ThoughtMatch, "similarity"> & { similarity: string | number }
    >(
      `SELECT id, content, metadata, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM thoughts
       WHERE ${conditions.join("\n         AND ")}
       ORDER BY embedding <=> $1::vector
       LIMIT $${limitParam}`,
      params,
    );
    if (transactionOpen) {
      await client.queryArray("COMMIT");
      transactionOpen = false;
    }
    return result.rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity),
    }));
  } catch (e) {
    if (transactionOpen) {
      try {
        await client.queryArray("ROLLBACK");
      } catch { /* surface the original query/transaction error */ }
    }
    throw e;
  } finally {
    client.release();
  }
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

  const client = await getClient(pool);
  try {
    const result = await client.queryObject<ThoughtRecord>(
      `SELECT id, content, metadata, created_at, updated_at
       FROM thoughts
       ${where}
       ORDER BY created_at DESC
       LIMIT $${p}`,
      [...params, limit],
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function fetchThought(
  pool: Pool,
  id: string,
): Promise<ThoughtRecord | null> {
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<ThoughtRecord>(
      `SELECT id, content, metadata, created_at, updated_at
       FROM thoughts WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

export type CaptureInput = {
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
};

export type CaptureOutcome = {
  id: string;
  metadata: Record<string, unknown>;
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
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<CaptureOutcome>(
      `INSERT INTO thoughts (content, embedding, metadata, content_fingerprint)
       VALUES (
         $1,
         $2::vector,
         $3::jsonb,
         encode(
           sha256(
             convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')
           ),
           'hex'
         )
       )
       ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL
       DO UPDATE SET
         embedding = EXCLUDED.embedding,
         metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
         updated_at = now()
       RETURNING id, metadata`,
      [input.content, embStr, JSON.stringify(input.metadata)],
    );
    return result.rows[0];
  } finally {
    client.release();
  }
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
export async function getStats(pool: Pool): Promise<Stats> {
  const client = await getClient(pool);
  try {
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
  } finally {
    client.release();
  }
}

export async function pingDb(pool: Pool): Promise<boolean> {
  // getClient() validates the borrow with its own SELECT 1, so a successful
  // borrow already proves liveness — no second round-trip needed.
  const client = await getClient(pool);
  client.release();
  return true;
}
