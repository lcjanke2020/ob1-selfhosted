// Pure SQL business logic. No HTTP concerns. A future REST gateway, CLI, or
// scheduled job can call these same functions without touching the MCP layer.

import { Pool } from "postgres";
import { getClient } from "./db_pool.ts";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { toVectorLiteral } from "./embeddings.ts";

export type SearchOptions = {
  query: string;
  embedding: number[];
  limit?: number;
  threshold?: number;
};

export async function searchThoughts(
  pool: Pool,
  opts: SearchOptions,
): Promise<ThoughtMatch[]> {
  const { embedding, limit = 10, threshold = 0.5 } = opts;
  const embStr = toVectorLiteral(embedding);
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<ThoughtMatch>(
      `SELECT id, content, metadata, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM thoughts
       WHERE 1 - (embedding <=> $1::vector) >= $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [embStr, threshold, limit],
    );
    return result.rows;
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

// Upsert by content fingerprint. The fingerprint is a SHA256 of the
// trimmed/lowercased/whitespace-collapsed content, computed inline so dedupe
// happens via the partial unique index on content_fingerprint. On conflict
// we refresh the embedding (in case the model changed) and merge any new
// metadata fields into the existing row's metadata.
export async function captureThought(
  pool: Pool,
  input: CaptureInput,
): Promise<{ id: string }> {
  const embStr = toVectorLiteral(input.embedding);
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<{ id: string }>(
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
       RETURNING id`,
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
