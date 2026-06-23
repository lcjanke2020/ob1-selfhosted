// pure SQL business logic for the sessions schema. No HTTP concerns,
// mirroring queries.ts so a future REST gateway / CLI could reuse these.
// getClient(pool) -> client.queryObject<T>(sql, params) -> client.release().

import { Pool } from "postgres";
import { getClient } from "./db_pool.ts";
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
  // The canonical key. deno-postgres decodes BIGINT as a JS BigInt that
  // JSON.stringify cannot serialize, so every projection of `id` is narrowed to
  // a JS number here (counts are tiny — single-operator store — far under
  // Number.MAX_SAFE_INTEGER, so lossless).
  id: number;
  session_id: string | null;
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
  id: number;
  session_id: string | null;
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
  id: number;
  session_id: string | null;
  title: string;
  status: string;
  repo_url: string | null;
  branch: string | null;
  last_update: string | null;
  needs_file_sync: boolean;
};

export type SessionSearchRow = {
  id: number;
  session_id: string | null;
  title: string;
  status: string;
  last_update: string | null;
  score: number;
};

// Projection used everywhere a full record is returned. Deliberately excludes
// `embedding` (a 768-float vector) so resume/get don't ship it over the wire.
const SESSION_COLUMNS = `
  id, session_id, title, session_date, goal,
  agent, agent_version, harness,
  machine, working_dir, repo_url, branch, head, worktree,
  started_at, last_update, ended_at, status,
  tags, linked_issues, related_sessions, next_actions, blockers,
  resume_context, summary,
  source, source_node, ingested_path, needs_file_sync,
  raw_toml, content_hash, created_at, updated_at`;

// Look up the change-detection hash for an existing session by its canonical
// key, so the tool layer can decide whether to pay for an Ollama embed before
// calling upsertSession. Returns { hash } when the row exists (hash may itself
// be null — a row that was never embedded), or null when NO row matches. The
// found/not-found distinction lets the caller fail fast on a stale/unknown id
// WITHOUT first paying for an embedding (the same SELECT already reveals it).
export async function getSessionContentHash(
  pool: Pool,
  id: number,
): Promise<{ hash: string | null } | null> {
  const client = await getClient(pool);
  try {
    const r = await client.queryObject<{ content_hash: string | null }>(
      `SELECT content_hash FROM sessions.session WHERE id = $1`,
      [id],
    );
    return r.rows.length ? { hash: r.rows[0].content_hash } : null;
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

  // Capture is TWO-PATH because the canonical key `id` is GENERATED ALWAYS
  // (never client-assigned, so no INSERT ... ON CONFLICT (id)):
  //   - id present -> UPDATE that row (refresh). 0 rows => the caller sent a
  //     stale/unknown id; surfaced as an error rather than silently minting a
  //     new row under a different id.
  //   - id absent  -> INSERT a fresh row; the server assigns id.
  // status / embedding / session_id are COALESCE-preserved on UPDATE so an
  // omitted value keeps what's stored: a mobile-set status, an unchanged
  // embedding, or a resumable handle set by an earlier capture from a surface
  // that exposed one. The $-positions are shared by both statements; the UPDATE
  // appends the key as $31.
  const cols = [
    s.session_id, // $1  resumable handle (TEXT, nullable) — NOT the key
    s.title, // $2
    s.session_date, // $3
    s.goal, // $4
    s.agent, // $5
    s.agent_version, // $6
    s.harness, // $7
    s.machine, // $8
    s.working_dir, // $9
    s.repo_url, // $10
    s.branch, // $11
    s.head, // $12
    s.worktree, // $13
    s.started_at, // $14
    s.last_update, // $15
    s.ended_at, // $16
    s.status, // $17
    s.tags, // $18
    s.linked_issues, // $19
    s.related_sessions, // $20
    s.next_actions, // $21
    s.blockers, // $22
    s.resume_context, // $23
    s.summary, // $24
    input.provenance.source, // $25
    input.provenance.sourceNode, // $26
    input.provenance.ingestedPath, // $27
    input.rawToml, // $28
    input.contentHash, // $29
    embParam, // $30
  ];

  const insertSql = `
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
      $1, $2, $3::date, $4,
      $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14::timestamptz, $15::timestamptz, $16::timestamptz,
      COALESCE($17::sessions.session_status, 'active'),
      $18::text[], $19::text[], $20::text[], $21::text[], $22::text[],
      $23, $24,
      $25, $26, $27, false,
      $28, $29, $30::vector
    )
    RETURNING id, session_id, status`;

  const updateSql = `
    UPDATE sessions.session SET
      session_id = COALESCE($1, sessions.session.session_id),
      title = $2,
      session_date = $3::date,
      goal = $4,
      agent = $5,
      agent_version = $6,
      harness = $7,
      machine = $8,
      working_dir = $9,
      repo_url = $10,
      branch = $11,
      head = $12,
      worktree = $13,
      started_at = $14::timestamptz,
      last_update = $15::timestamptz,
      ended_at = $16::timestamptz,
      status = COALESCE($17::sessions.session_status, sessions.session.status),
      tags = $18::text[],
      linked_issues = $19::text[],
      related_sessions = $20::text[],
      next_actions = $21::text[],
      blockers = $22::text[],
      resume_context = $23,
      summary = $24,
      source = $25,
      source_node = $26,
      ingested_path = $27,
      needs_file_sync = false,
      raw_toml = $28,
      content_hash = $29,
      embedding = COALESCE($30::vector, sessions.session.embedding),
      updated_at = now()
    WHERE id = $31
    RETURNING id, session_id, status`;

  type UpsertRow = { id: bigint; session_id: string | null; status: string };
  const isUpdate = s.id != null;

  const client = await getClient(pool);
  try {
    await client.queryArray("BEGIN");
    const res = isUpdate
      ? await client.queryObject<UpsertRow>(updateSql, [...cols, s.id])
      : await client.queryObject<UpsertRow>(insertSql, cols);
    if (isUpdate && res.rows.length === 0) {
      throw new Error(`no session with id ${s.id}`);
    }
    const row = res.rows[0];
    // Bind the BIGINT key as a JS number for the artifact FK (same lossless
    // bound as the returned id); deno-postgres decodes RETURNING id as BigInt.
    const sessionPk = Number(row.id);

    // Reconcile artifact children: a qualified (WHERE session_pk) delete then
    // re-insert, keyed on the BIGINT canonical key.
    await client.queryArray(
      `DELETE FROM sessions.artifact WHERE session_pk = $1`,
      [sessionPk],
    );
    for (const a of input.artifacts) {
      await client.queryArray(
        `INSERT INTO sessions.artifact (session_pk, position, kind, title, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionPk, a.position, a.kind, a.title, a.detail],
      );
    }

    await client.queryArray("COMMIT");
    return {
      id: sessionPk,
      session_id: row.session_id,
      status: row.status,
      created: !isUpdate,
    };
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
  id: number,
): Promise<SessionRecord | null> {
  const client = await getClient(pool);
  try {
    // id decodes as a BigInt at runtime (deno-postgres); type it honestly as
    // bigint here and narrow to a number on return, rather than mislabelling it.
    const sess = await client.queryObject<Omit<SessionRow, "id"> & { id: bigint }>(
      `SELECT ${SESSION_COLUMNS} FROM sessions.session WHERE id = $1`,
      [id],
    );
    const row = sess.rows[0];
    if (!row) return null;
    const arts = await client.queryObject<ArtifactRow>(
      `SELECT position, kind, title, detail
       FROM sessions.artifact
       WHERE session_pk = $1
       ORDER BY position, id`,
      [id],
    );
    // id comes back as a BigInt (JSON-unserializable) → narrow to a number.
    return { ...row, id: Number(row.id), artifacts: arts.rows };
  } finally {
    client.release();
  }
}

export async function resumeSession(
  pool: Pool,
  opts: { id?: number | null; branch?: string | null },
): Promise<SessionRecord | null> {
  if (opts.id != null) return getSession(pool, opts.id);
  if (!opts.branch) return null;

  const client = await getClient(pool);
  let chosenId: number | null;
  try {
    // Branch ties broken deterministically: newest last_update, then the
    // server-managed updated_at, then id for total order.
    const r = await client.queryObject<{ id: bigint }>(
      `SELECT id FROM sessions.session
       WHERE branch = $1
       ORDER BY last_update DESC NULLS LAST, updated_at DESC, id
       LIMIT 1`,
      [opts.branch],
    );
    chosenId = r.rows[0] ? Number(r.rows[0].id) : null;
  } finally {
    client.release();
  }
  return chosenId != null ? getSession(pool, chosenId) : null;
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
  const client = await getClient(pool);
  try {
    const r = await client.queryObject<
      Omit<SessionSearchRow, "id" | "score"> & { id: bigint; score: string }
    >(
      `SELECT id, session_id, title, status, last_update,
              1 - (embedding <=> $1::vector) AS score
       FROM sessions.session
       WHERE ${cond.join(" AND ")}
       ORDER BY embedding <=> $1::vector
       LIMIT $${p}`,
      [...params, limit],
    );
    // id decodes as a BigInt and the distance expression as text; expose both
    // as JS numbers.
    return r.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      score: Number(row.score),
    }));
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

  const client = await getClient(pool);
  try {
    const r = await client.queryObject<Omit<SessionListRow, "id"> & { id: bigint }>(
      `SELECT id, session_id, title, status, repo_url, branch, last_update, needs_file_sync
       FROM sessions.session
       ${where}
       ORDER BY ${orderBy} DESC NULLS LAST, updated_at DESC, id
       LIMIT $${p}`,
      [...params, limit],
    );
    // id decodes as a BigInt → narrow to a number for JSON.
    return r.rows.map((row) => ({ ...row, id: Number(row.id) }));
  } finally {
    client.release();
  }
}

export async function updateSessionStatus(
  pool: Pool,
  id: number,
  status: string,
): Promise<
  { id: number; status: string; needs_file_sync: boolean } | null
> {
  const client = await getClient(pool);
  try {
    const r = await client.queryObject<
      { id: bigint; status: string; needs_file_sync: boolean }
    >(
      `UPDATE sessions.session
       SET status = $2::sessions.session_status, needs_file_sync = true
       WHERE id = $1
       RETURNING id, status, needs_file_sync`,
      [id, status],
    );
    const row = r.rows[0];
    return row ? { ...row, id: Number(row.id) } : null;
  } finally {
    client.release();
  }
}
