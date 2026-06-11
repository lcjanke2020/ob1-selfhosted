// Pure SQL business logic. No HTTP concerns. A future REST gateway, CLI, or
// scheduled job can call these same functions without touching the MCP layer.

import { Pool } from "postgres";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { toVectorLiteral } from "./embeddings.ts";

export type SearchOptions = {
  query: string;
  embedding: number[];
  limit?: number;
  threshold?: number;
  // Recency boost, ported from upstream OB1's recency-boosted-match-thoughts
  // schema (PR #231). 0 (the default) = pure similarity ranking, identical
  // SQL to before the port. >0 blends an exponential recency decay into the
  // returned similarity: score = sim*(1-w) + exp(-age_days/half_life)*w.
  recencyWeight?: number;
  halfLifeDays?: number;
};

// Clamp the recency knobs to sane ranges, mirroring upstream's in-function
// clamping: weight into [0,1], half-life positive (else the 90-day default).
// Exported for direct unit testing.
export function clampRecency(
  weight?: number,
  halfLifeDays?: number,
): { w: number; hl: number } {
  let w = weight ?? 0;
  if (!Number.isFinite(w) || w < 0) w = 0;
  if (w > 1) w = 1;
  let hl = halfLifeDays ?? 90;
  if (!Number.isFinite(hl) || hl <= 0) hl = 90;
  return { w, hl };
}

export async function searchThoughts(
  pool: Pool,
  opts: SearchOptions,
): Promise<ThoughtMatch[]> {
  const { embedding, limit = 10, threshold = 0.5 } = opts;
  const { w, hl } = clampRecency(opts.recencyWeight, opts.halfLifeDays);
  const embStr = toVectorLiteral(embedding);
  const client = await pool.connect();
  try {
    if (w === 0) {
      // Pure-similarity path — kept byte-identical to the pre-recency SQL on
      // purpose: `ORDER BY embedding <=> $1::vector` is the shape the HNSW
      // index accelerates. The blended ORDER BY below cannot use the index
      // (it's not a plain distance ordering), so the default path must not
      // pay that seq-scan cost.
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
    }
    // Blended path. The threshold still gates on RAW cosine similarity
    // (upstream semantics) so a high recency weight can't surface
    // irrelevant-but-new thoughts. Keep the formula in sync with
    // db/05-recency-search.sql — queries_recency_test.ts asserts the parity.
    // Trade-off: this ordering seq-scans past the HNSW index; fine at
    // personal-brain scale. If a large brain needs it fast, oversample via
    // the index first and re-rank the candidates.
    const result = await client.queryObject<ThoughtMatch>(
      `SELECT id, content, metadata, created_at,
              ((1 - (embedding <=> $1::vector)) * (1.0 - $4) + exp(-GREATEST(extract(epoch FROM (now() - created_at)) / 86400.0, 0.0) / $5) * $4)::float AS similarity
       FROM thoughts
       WHERE 1 - (embedding <=> $1::vector) >= $2
       ORDER BY similarity DESC
       LIMIT $3`,
      [embStr, threshold, limit, w, hl],
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

  const client = await pool.connect();
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
  const client = await pool.connect();
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

// SHA256 of the trimmed/lowercased/whitespace-collapsed content — the dedupe
// key behind the partial unique index on content_fingerprint. Single
// definition shared by captureThought and updateThought so the two write
// paths cannot drift apart (queries_update_thought_test.ts asserts parity).
// `param` is the SQL placeholder holding the content text (e.g. "$1").
export function fingerprintSqlExpr(param: string): string {
  return `encode(sha256(convert_to(lower(trim(regexp_replace(${param}, '\\s+', ' ', 'g'))), 'UTF8')), 'hex')`;
}

// Upsert by content fingerprint. The fingerprint is computed inline so dedupe
// happens via the partial unique index on content_fingerprint. On conflict
// we refresh the embedding (in case the model changed) and merge any new
// metadata fields into the existing row's metadata.
export async function captureThought(
  pool: Pool,
  input: CaptureInput,
): Promise<{ id: string }> {
  const embStr = toVectorLiteral(input.embedding);
  const client = await pool.connect();
  try {
    const result = await client.queryObject<{ id: string }>(
      `INSERT INTO thoughts (content, embedding, metadata, content_fingerprint)
       VALUES (
         $1,
         $2::vector,
         $3::jsonb,
         ${fingerprintSqlExpr("$1")}
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

export type UpdateThoughtInput = {
  id: string;
  // content and embedding travel together: the caller re-embeds whenever it
  // replaces the text (mcp-server.ts enforces this pairing).
  content?: string;
  embedding?: number[];
  // Shallow top-level merge into the existing metadata JSONB — upstream
  // update-thought-mcp's spread-merge semantics, done in SQL via `||`.
  metadataPatch: Record<string, unknown>;
  // ISO timestamptz from the caller's last read. Undefined = last-write-wins.
  ifUnchangedSince?: string;
};

export type UpdateThoughtOutcome =
  | { kind: "updated"; id: string; updated_at: string }
  | { kind: "not_found" }
  | { kind: "stale"; current_updated_at: string }
  | { kind: "fingerprint_conflict"; existing_id: string };

// deno-postgres surfaces server errors as PostgresError with the SQLSTATE in
// `fields.code`. Duck-typed (rather than instanceof) so a stubbed pool in
// tests can raise the same shape without importing driver internals.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null &&
    (e as { fields?: { code?: string } }).fields?.code === "23505";
}

// Ported from upstream OB1's update-thought-mcp (PR #228), tightened into a
// single atomic compare-and-set UPDATE instead of upstream's read-then-write
// (which can lose a concurrent writer's update between the SELECT and the
// UPDATE). Semantics match upstream: a stored updated_at strictly newer than
// ifUnchangedSince rejects as stale; equal-or-older passes.
//
// Both sides of the comparison are truncated to milliseconds: the reference
// value usually round-tripped through a JS Date (ms precision) on the
// caller's prior read, while postgres stores microseconds — without the
// truncation every honest read-modify-write would false-positive as stale.
export async function updateThought(
  pool: Pool,
  input: UpdateThoughtInput,
): Promise<UpdateThoughtOutcome> {
  const embStr = input.embedding ? toVectorLiteral(input.embedding) : null;
  const client = await pool.connect();
  try {
    let result;
    try {
      result = await client.queryObject<{ id: string; updated_at: string }>(
        `UPDATE thoughts SET
           content = COALESCE($2, content),
           embedding = COALESCE($3::vector, embedding),
           content_fingerprint = CASE WHEN $2 IS NULL THEN content_fingerprint
             ELSE ${fingerprintSqlExpr("$2")} END,
           metadata = metadata || $4::jsonb
         WHERE id = $1
           AND ($5::timestamptz IS NULL
                OR date_trunc('milliseconds', updated_at)
                   <= date_trunc('milliseconds', $5::timestamptz))
         RETURNING id, updated_at`,
        [
          input.id,
          input.content ?? null,
          embStr,
          JSON.stringify(input.metadataPatch),
          input.ifUnchangedSince ?? null,
        ],
      );
    } catch (e) {
      // New content collided with another row's dedupe fingerprint (the
      // partial unique index). Recover the surviving row's id so the caller
      // can point at the duplicate instead of guessing.
      if (!isUniqueViolation(e)) throw e;
      const dupe = await client.queryObject<{ id: string }>(
        `SELECT id FROM thoughts
         WHERE content_fingerprint = ${fingerprintSqlExpr("$1")}
         LIMIT 1`,
        [input.content ?? ""],
      );
      return {
        kind: "fingerprint_conflict",
        existing_id: dupe.rows[0]?.id ?? "unknown",
      };
    }
    if (result.rows.length) {
      return { kind: "updated", ...result.rows[0] };
    }
    // Zero rows: either the id doesn't exist or the CAS guard rejected it.
    // One follow-up read disambiguates (and supplies current_updated_at for
    // the STALE_READ error the way upstream does).
    const probe = await client.queryObject<{ updated_at: string }>(
      `SELECT updated_at FROM thoughts WHERE id = $1 LIMIT 1`,
      [input.id],
    );
    if (!probe.rows.length) return { kind: "not_found" };
    return { kind: "stale", current_updated_at: probe.rows[0].updated_at };
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
  const client = await pool.connect();
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
  const client = await pool.connect();
  try {
    await client.queryObject("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}
