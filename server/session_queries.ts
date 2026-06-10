// pure SQL business logic for the sessions schema. No HTTP concerns,
// mirroring queries.ts so a future REST gateway / CLI could reuse these.
// pool.connect() -> client.queryObject<T>(sql, params) -> client.release().

import { Pool } from "postgres";
import { toVectorLiteral } from "./embeddings.ts";
import {
  normalizeOrderBy,
  type ParsedArtifact,
  type ParsedSession,
} from "./session_toml.ts";

export type SessionProvenance = {
  // The transport door: 'funnel' (Auth0 Bearer via Tailscale Funnel — all
  // Anthropic surfaces) or 'tailnet' (x-brain-key from an on-network client).
  source: "funnel" | "tailnet";
  sourceNode: string | null;
  ingestedPath: string | null;
};

export type SessionUpsertInput = {
  session: ParsedSession;
  artifacts: ParsedArtifact[];
  contentHash: string;
  // null => content unchanged: keep the existing embedding (COALESCE).
  embedding: number[] | null;
  provenance: SessionProvenance;
  rawToml: string;
};

export type UpsertOutcome = {
  session_id: string;
  status: string;
  created: boolean;
};

export type ArtifactRow = {
  // The bigint identity `id` is an internal surrogate (and a JSON-unserializable
  // BigInt in deno-postgres), so it is intentionally not projected.
  position: number;
  kind: string;
  title: string;
  detail: string | null;
};

export type SessionRow = {
  session_id: string;
  title: string;
  session_date: string | null;
  goal: string | null;
  agent: string | null;
  agent_version: string | null;
  harness: string | null;
  machine: string | null;
  working_dir: string | null;
  repo_url: string | null;
  branch: string | null;
  head: string | null;
  worktree: string | null;
  started_at: string | null;
  last_update: string | null;
  ended_at: string | null;
  status: string;
  tags: string[];
  linked_issues: string[];
  related_sessions: string[];
  next_actions: string[];
  blockers: string[];
  resume_context: string | null;
  summary: string | null;
  source: string | null;
  source_node: string | null;
  ingested_path: string | null;
  needs_file_sync: boolean;
  raw_toml: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRecord = SessionRow & { artifacts: ArtifactRow[] };

export type SessionListRow = {
  session_id: string;
  title: string;
  status: string;
  repo_url: string | null;
  branch: string | null;
  last_update: string | null;
  needs_file_sync: boolean;
};

export type SessionSearchRow = {
  session_id: string;
  title: string;
  status: string;
  last_update: string | null;
  score: number;
};

// Projection used everywhere a full record is returned. Deliberately excludes
// `embedding` (a 768-float vector) so resume/get don't ship it over the wire.
const SESSION_COLUMNS = `
  session_id, title, session_date, goal,
  agent, agent_version, harness,
  machine, working_dir, repo_url, branch, head, worktree,
  started_at, last_update, ended_at, status,
  tags, linked_issues, related_sessions, next_actions, blockers,
  resume_context, summary,
  source, source_node, ingested_path, needs_file_sync,
  raw_toml, content_hash, created_at, updated_at`;

// Read just the change-detection hash so the tool layer can decide whether to
// pay for an Ollama embed before calling upsertSession. Returns null when the
// session does not exist yet (or no id was supplied).
export async function getSessionContentHash(
  pool: Pool,
  sessionId: string | null,
): Promise<string | null> {
  if (!sessionId) return null;
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{ content_hash: string | null }>(
      `SELECT content_hash FROM sessions.session WHERE session_id = $1`,
      [sessionId],
    );
    return r.rows[0]?.content_hash ?? null;
  } finally {
    client.release();
  }
}

export async function upsertSession(
  pool: Pool,
  input: SessionUpsertInput,
): Promise<UpsertOutcome> {
  const s = input.session;
  const embParam = input.embedding ? toVectorLiteral(input.embedding) : null;

  // Status and embedding reference the raw nullable params ($17 / $30) directly
  // in the DO UPDATE (not EXCLUDED) so an omitted status preserves a mobile-set
  // value and an unchanged-content capture keeps the existing embedding.
  const sql = `
    INSERT INTO sessions.session (
      session_id, title, session_date, goal,
      agent, agent_version, harness,
      machine, working_dir, repo_url, branch, head, worktree,
      started_at, last_update, ended_at, status,
      tags, linked_issues, related_sessions, next_actions, blockers,
      resume_context, summary,
      source, source_node, ingested_path, needs_file_sync,
      raw_toml, content_hash, embedding
    ) VALUES (
      COALESCE($1::uuid, gen_random_uuid()), $2, $3::date, $4,
      $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14::timestamptz, $15::timestamptz, $16::timestamptz,
      COALESCE($17::sessions.session_status, 'active'),
      $18::text[], $19::text[], $20::text[], $21::text[], $22::text[],
      $23, $24,
      $25, $26, $27, false,
      $28, $29, $30::vector
    )
    ON CONFLICT (session_id) DO UPDATE SET
      title = EXCLUDED.title,
      session_date = EXCLUDED.session_date,
      goal = EXCLUDED.goal,
      agent = EXCLUDED.agent,
      agent_version = EXCLUDED.agent_version,
      harness = EXCLUDED.harness,
      machine = EXCLUDED.machine,
      working_dir = EXCLUDED.working_dir,
      repo_url = EXCLUDED.repo_url,
      branch = EXCLUDED.branch,
      head = EXCLUDED.head,
      worktree = EXCLUDED.worktree,
      started_at = EXCLUDED.started_at,
      last_update = EXCLUDED.last_update,
      ended_at = EXCLUDED.ended_at,
      status = COALESCE($17::sessions.session_status, sessions.session.status),
      tags = EXCLUDED.tags,
      linked_issues = EXCLUDED.linked_issues,
      related_sessions = EXCLUDED.related_sessions,
      next_actions = EXCLUDED.next_actions,
      blockers = EXCLUDED.blockers,
      resume_context = EXCLUDED.resume_context,
      summary = EXCLUDED.summary,
      source = EXCLUDED.source,
      source_node = EXCLUDED.source_node,
      ingested_path = EXCLUDED.ingested_path,
      needs_file_sync = false,
      raw_toml = EXCLUDED.raw_toml,
      content_hash = EXCLUDED.content_hash,
      embedding = COALESCE($30::vector, sessions.session.embedding),
      updated_at = now()
    RETURNING session_id, status, (xmax = 0) AS created`;

  const params = [
    s.session_id,
    s.title,
    s.session_date,
    s.goal,
    s.agent,
    s.agent_version,
    s.harness,
    s.machine,
    s.working_dir,
    s.repo_url,
    s.branch,
    s.head,
    s.worktree,
    s.started_at,
    s.last_update,
    s.ended_at,
    s.status,
    s.tags,
    s.linked_issues,
    s.related_sessions,
    s.next_actions,
    s.blockers,
    s.resume_context,
    s.summary,
    input.provenance.source,
    input.provenance.sourceNode,
    input.provenance.ingestedPath,
    input.rawToml,
    input.contentHash,
    embParam,
  ];

  const client = await pool.connect();
  try {
    await client.queryArray("BEGIN");
    const up = await client.queryObject<UpsertOutcome>(sql, params);
    const row = up.rows[0];

    // Reconcile artifact children: a qualified (WHERE session_id) delete then
    // re-insert. The WHERE is for correctness; it is kept on one physical line
    // only as a habit mirroring the SQL files (ob1-gate.yml Rule 5's
    // DELETE-needs-WHERE scan covers `*.sql` only, not this `.ts`).
    await client.queryArray(
      `DELETE FROM sessions.artifact WHERE session_id = $1`,
      [row.session_id],
    );
    for (const a of input.artifacts) {
      await client.queryArray(
        `INSERT INTO sessions.artifact (session_id, position, kind, title, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.session_id, a.position, a.kind, a.title, a.detail],
      );
    }

    await client.queryArray("COMMIT");
    return row;
  } catch (e) {
    try {
      await client.queryArray("ROLLBACK");
    } catch { /* already failing; surface the original error */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function getSession(
  pool: Pool,
  sessionId: string,
): Promise<SessionRecord | null> {
  const client = await pool.connect();
  try {
    const sess = await client.queryObject<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions.session WHERE session_id = $1`,
      [sessionId],
    );
    if (!sess.rows[0]) return null;
    const arts = await client.queryObject<ArtifactRow>(
      `SELECT position, kind, title, detail
       FROM sessions.artifact
       WHERE session_id = $1
       ORDER BY position, id`,
      [sessionId],
    );
    return { ...sess.rows[0], artifacts: arts.rows };
  } finally {
    client.release();
  }
}

export async function resumeSession(
  pool: Pool,
  opts: { sessionId?: string | null; branch?: string | null },
): Promise<SessionRecord | null> {
  if (opts.sessionId) return getSession(pool, opts.sessionId);
  if (!opts.branch) return null;

  const client = await pool.connect();
  let chosenId: string | null;
  try {
    // Branch ties broken deterministically: newest last_update, then the
    // server-managed updated_at, then session_id for total order.
    const r = await client.queryObject<{ session_id: string }>(
      `SELECT session_id FROM sessions.session
       WHERE branch = $1
       ORDER BY last_update DESC NULLS LAST, updated_at DESC, session_id
       LIMIT 1`,
      [opts.branch],
    );
    chosenId = r.rows[0]?.session_id ?? null;
  } finally {
    client.release();
  }
  return chosenId ? getSession(pool, chosenId) : null;
}

export async function searchSessions(
  pool: Pool,
  opts: {
    embedding: number[];
    limit?: number;
    status?: string;
    repo_url?: string;
    tag?: string;
  },
): Promise<SessionSearchRow[]> {
  const { embedding, limit = 5, status, repo_url, tag } = opts;
  const embStr = toVectorLiteral(embedding);
  const params: unknown[] = [embStr];
  let p = 2;
  const cond: string[] = ["embedding IS NOT NULL"];
  if (status) {
    cond.push(`status = $${p++}::sessions.session_status`);
    params.push(status);
  }
  if (repo_url) {
    cond.push(`repo_url = $${p++}`);
    params.push(repo_url);
  }
  if (tag) {
    cond.push(`tags @> ARRAY[$${p++}]::text[]`);
    params.push(tag);
  }
  const client = await pool.connect();
  try {
    const r = await client.queryObject<SessionSearchRow>(
      `SELECT session_id, title, status, last_update,
              1 - (embedding <=> $1::vector) AS score
       FROM sessions.session
       WHERE ${cond.join(" AND ")}
       ORDER BY embedding <=> $1::vector
       LIMIT $${p}`,
      [...params, limit],
    );
    // deno-postgres decodes the distance expression as text; expose a number.
    return r.rows.map((row) => ({ ...row, score: Number(row.score) }));
  } finally {
    client.release();
  }
}

export async function listSessions(
  pool: Pool,
  opts: {
    status?: string;
    repo_url?: string;
    branch?: string;
    agent?: string;
    tag?: string;
    linked_issue?: string;
    since?: string;
    until?: string;
    order_by?: string;
    limit?: number;
  },
): Promise<SessionListRow[]> {
  const cond: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (opts.status) {
    cond.push(`status = $${p++}::sessions.session_status`);
    params.push(opts.status);
  }
  if (opts.repo_url) {
    cond.push(`repo_url = $${p++}`);
    params.push(opts.repo_url);
  }
  if (opts.branch) {
    cond.push(`branch = $${p++}`);
    params.push(opts.branch);
  }
  if (opts.agent) {
    cond.push(`agent = $${p++}`);
    params.push(opts.agent);
  }
  if (opts.tag) {
    cond.push(`tags @> ARRAY[$${p++}]::text[]`);
    params.push(opts.tag);
  }
  if (opts.linked_issue) {
    cond.push(`linked_issues @> ARRAY[$${p++}]::text[]`);
    params.push(opts.linked_issue);
  }
  if (opts.since) {
    cond.push(`last_update >= $${p++}::timestamptz`);
    params.push(opts.since);
  }
  if (opts.until) {
    cond.push(`last_update <= $${p++}::timestamptz`);
    params.push(opts.until);
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  // order_by is whitelisted (never interpolated untrusted).
  const orderBy = normalizeOrderBy(opts.order_by);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const client = await pool.connect();
  try {
    const r = await client.queryObject<SessionListRow>(
      `SELECT session_id, title, status, repo_url, branch, last_update, needs_file_sync
       FROM sessions.session
       ${where}
       ORDER BY ${orderBy} DESC NULLS LAST, updated_at DESC, session_id
       LIMIT $${p}`,
      [...params, limit],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

export async function updateSessionStatus(
  pool: Pool,
  sessionId: string,
  status: string,
): Promise<
  { session_id: string; status: string; needs_file_sync: boolean } | null
> {
  const client = await pool.connect();
  try {
    const r = await client.queryObject<
      { session_id: string; status: string; needs_file_sync: boolean }
    >(
      `UPDATE sessions.session
       SET status = $2::sessions.session_status, needs_file_sync = true
       WHERE session_id = $1
       RETURNING session_id, status, needs_file_sync`,
      [sessionId, status],
    );
    return r.rows[0] ?? null;
  } finally {
    client.release();
  }
}
