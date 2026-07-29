// pure SQL business logic for the sessions schema. No HTTP concerns,
// mirroring queries.ts so a future REST gateway / CLI could reuse these.
// getClient(pool) -> client.queryObject<T>(sql, params) -> client.release().

import { Pool } from "postgres";
import { toVectorLiteral } from "./embeddings.ts";
import { withScopeClient } from "./scoped_db.ts";
import type {
  MemoryVisibility,
  ResolvedReadScope,
  ResolvedWriteScope,
} from "./scope_contract.ts";
import {
  normalizeOrderBy,
  type ParsedArtifact,
  type ParsedSession,
} from "./session_toml.ts";

// Match the thought-search floor: pgvector's default ef_search of 40 is a
// smaller scan batch than the public session-search maximum of 50. Public
// callers therefore use this floor today; Math.max also keeps internal/future
// callers above it if they request more than 50 rows.
const MIN_SESSION_HNSW_EF_SEARCH = 50;

export type SessionProvenance = {
  // The transport door: 'funnel' (Auth0 Bearer via Tailscale Funnel — all
  // Anthropic surfaces) or 'tailnet' (x-brain-key from an on-network client).
  source: "funnel" | "tailnet";
  sourceNode: string | null;
};

export type SessionUpsertInput = {
  session: ParsedSession;
  artifacts: ParsedArtifact[];
  contentHash: string;
  // null => content unchanged: keep the existing embedding (COALESCE).
  embedding: number[] | null;
  provenance: SessionProvenance;
  rawToml: string;
  scope: ResolvedWriteScope;
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
  workspace_id: string;
  project_id: string | null;
  visibility: MemoryVisibility;
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
  workspace_id: string;
  project_id: string | null;
  visibility: MemoryVisibility;
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
  workspace_id: string;
  project_id: string | null;
  visibility: MemoryVisibility;
};

export type SessionSearchRow = {
  id: number;
  session_id: string | null;
  title: string;
  status: string;
  last_update: string | null;
  score: number;
  workspace_id: string;
  project_id: string | null;
  visibility: MemoryVisibility;
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
  source, source_node,
  workspace_id, project_id, visibility,
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
  scope: ResolvedReadScope,
): Promise<{ hash: string | null } | null> {
  return await withScopeClient(pool, scope, async (client) => {
    const r = await client.queryObject<{ content_hash: string | null }>(
      `SELECT content_hash FROM sessions.session WHERE id = $1`,
      [id],
    );
    return r.rows.length ? { hash: r.rows[0].content_hash } : null;
  });
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
  // appends audience fields as $30-$33 and the key as $34.
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
    input.rawToml, // $27
    input.contentHash, // $28
    embParam, // $29
    input.scope.workspaceId, // $30
    input.scope.projectId, // $31
    input.scope.visibility, // $32
    input.scope.ownerSubject, // $33
  ];

  const insertSql = `
    INSERT INTO sessions.session (
      session_id, title, session_date, goal,
      agent, agent_version, harness,
      machine, working_dir, repo_url, branch, head, worktree,
      started_at, last_update, ended_at, status,
      tags, linked_issues, related_sessions, next_actions, blockers,
      resume_context, summary,
      source, source_node,
      raw_toml, content_hash, embedding,
      workspace_id, project_id, visibility, owner_subject
    ) VALUES (
      $1, $2, $3::date, $4,
      $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      $14::timestamptz, $15::timestamptz, $16::timestamptz,
      COALESCE($17::sessions.session_status, 'active'),
      $18::text[], $19::text[], $20::text[], $21::text[], $22::text[],
      $23, $24,
      $25, $26,
      $27, $28, $29::vector,
      $30, $31, $32::memory_scope.visibility, $33
    )
    RETURNING id, session_id, status,
              workspace_id, project_id, visibility`;

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
      raw_toml = $27,
      content_hash = $28,
      embedding = COALESCE($29::vector, sessions.session.embedding),
      workspace_id = $30,
      project_id = $31,
      visibility = $32::memory_scope.visibility,
      owner_subject = $33,
      updated_at = now()
    WHERE id = $34
    RETURNING id, session_id, status,
              workspace_id, project_id, visibility`;

  type UpsertRow = {
    id: bigint;
    session_id: string | null;
    status: string;
    workspace_id: string;
    project_id: string | null;
    visibility: MemoryVisibility;
  };
  const isUpdate = s.id != null;

  return await withScopeClient(pool, input.scope, async (client) => {
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

    return {
      id: sessionPk,
      session_id: row.session_id,
      status: row.status,
      created: !isUpdate,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      visibility: row.visibility,
    };
  });
}

export async function getSession(
  pool: Pool,
  id: number,
  scope: ResolvedReadScope,
): Promise<SessionRecord | null> {
  return await withScopeClient(pool, scope, async (client) => {
    // id decodes as a BigInt at runtime (deno-postgres); type it honestly as
    // bigint here and narrow to a number on return, rather than mislabelling it.
    const sess = await client.queryObject<
      Omit<SessionRow, "id"> & { id: bigint }
    >(
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
  });
}

export async function resumeSession(
  pool: Pool,
  opts: { id?: number | null; branch?: string | null },
  scope: ResolvedReadScope,
): Promise<SessionRecord | null> {
  if (opts.id != null) return getSession(pool, opts.id, scope);
  if (!opts.branch) return null;

  const chosenId = await withScopeClient(pool, scope, async (client) => {
    // A caller timestamp is meaningful when supplied; otherwise the
    // server-managed update time is the row's freshness. Keep server time and
    // id as deterministic tie-breakers for equal effective timestamps.
    const r = await client.queryObject<{ id: bigint }>(
      `SELECT id FROM sessions.session
       WHERE branch = $1
       ORDER BY COALESCE(last_update, updated_at) DESC,
                updated_at DESC, id DESC
       LIMIT 1`,
      [opts.branch],
    );
    return r.rows[0] ? Number(r.rows[0].id) : null;
  });
  return chosenId != null ? getSession(pool, chosenId, scope) : null;
}

export async function searchSessions(
  pool: Pool,
  opts: {
    embedding: number[];
    limit?: number;
    threshold?: number;
    status?: string;
    repo_url?: string;
    tag?: string;
  },
  scope: ResolvedReadScope,
): Promise<SessionSearchRow[]> {
  const { embedding, limit = 5, threshold = 0.5, status, repo_url, tag } = opts;
  const candidateDepth = Math.max(MIN_SESSION_HNSW_EF_SEARCH, limit);
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
  cond.push(`1 - (embedding <=> $1::vector) >= $${p++}::double precision`);
  params.push(threshold);
  const searchParams = [...params, limit];
  const approximateSql = `SELECT id, session_id, title, status, last_update,
            workspace_id, project_id, visibility,
            1 - (embedding <=> $1::vector) AS score
     FROM sessions.session
     WHERE ${cond.join(" AND ")}
     ORDER BY embedding <=> $1::vector
     LIMIT $${p}`;
  // MATERIALIZED prevents the distance ordering from being satisfied by the
  // HNSW index: PostgreSQL must first collect the RLS-visible, filter-eligible
  // rows and then sort that finite relation by exact vector distance.
  const exactFallbackSql = `WITH eligible AS MATERIALIZED (
       SELECT id, session_id, title, status, last_update,
              workspace_id, project_id, visibility, embedding
       FROM sessions.session
       WHERE ${cond.join(" AND ")}
     )
     SELECT id, session_id, title, status, last_update,
            workspace_id, project_id, visibility,
            1 - (embedding <=> $1::vector) AS score
     FROM eligible
     ORDER BY embedding <=> $1::vector
     LIMIT $${p}`;
  return await withScopeClient(pool, scope, async (client) => {
    // RLS and the optional status/repository/tag predicates are residual
    // filters on the HNSW scan. Without iterative scanning, all of the first
    // approximate candidates can be discarded before a farther visible match
    // is considered. Keep both controls transaction-local so pooled clients
    // recover their pre-request state after commit or rollback.
    await client.queryArray(
      "SELECT set_config('hnsw.ef_search', $1::text, true)",
      [String(candidateDepth)],
    );
    await client.queryArray(
      "SET LOCAL hnsw.iterative_scan = strict_order",
    );

    let result = await client.queryObject<
      Omit<SessionSearchRow, "id" | "score"> & { id: bigint; score: string }
    >(approximateSql, searchParams);

    // Iterative HNSW remains bounded by pgvector's max_scan_tuples and scan
    // memory. If RLS or residual predicates still exhaust that bounded scan,
    // retry through the exact materialized path instead of silently returning
    // fewer rows than are available. A genuinely sparse result pays for one
    // exact confirmation; filled ANN requests retain the fast path.
    if (result.rows.length < limit) {
      result = await client.queryObject<
        Omit<SessionSearchRow, "id" | "score"> & {
          id: bigint;
          score: string;
        }
      >(exactFallbackSql, searchParams);
    }

    // id decodes as a BigInt and the distance expression as text; expose both
    // as JS numbers.
    return result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      score: Number(row.score),
    }));
  });
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
  scope: ResolvedReadScope,
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
  // order_by is whitelisted (never interpolated untrusted). The public
  // default is effective freshness: caller last_update when present, otherwise
  // the server-managed update timestamp. Explicit alternate columns retain
  // their ordinary descending semantics.
  const orderBy = normalizeOrderBy(opts.order_by);
  const ordering = orderBy === "last_update"
    ? "COALESCE(last_update, updated_at) DESC, updated_at DESC, id DESC"
    : `${orderBy} DESC NULLS LAST, updated_at DESC, id DESC`;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  return await withScopeClient(pool, scope, async (client) => {
    const r = await client.queryObject<
      Omit<SessionListRow, "id"> & { id: bigint }
    >(
      `SELECT id, session_id, title, status, repo_url, branch, last_update,
              workspace_id, project_id, visibility
       FROM sessions.session
       ${where}
       ORDER BY ${ordering}
       LIMIT $${p}`,
      [...params, limit],
    );
    // id decodes as a BigInt → narrow to a number for JSON.
    return r.rows.map((row) => ({ ...row, id: Number(row.id) }));
  });
}

export async function updateSessionStatus(
  pool: Pool,
  id: number,
  status: string,
  scope: ResolvedReadScope,
): Promise<
  { id: number; status: string } | null
> {
  return await withScopeClient(pool, scope, async (client) => {
    const r = await client.queryObject<
      { id: bigint; status: string }
    >(
      `UPDATE sessions.session
       SET status = $2::sessions.session_status
       WHERE id = $1
       RETURNING id, status`,
      [id, status],
    );
    const row = r.rows[0];
    return row ? { ...row, id: Number(row.id) } : null;
  });
}
