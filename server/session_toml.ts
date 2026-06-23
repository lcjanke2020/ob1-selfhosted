// session-tracker TOML parsing + content hashing. Pure logic, no DB
// or HTTP imports, so it is hermetically unit-testable (session_toml_test.ts).
//
// The canonical artifact is a TOML front-matter file. `session_capture` hands
// the whole document to `parseSessionToml`, which maps the front matter onto
// the sessions.session columns and the `[[artifacts]]` array-of-tables onto
// sessions.artifact rows. Provenance fields (source/source_node/ingested_path/
// needs_file_sync) are deliberately NOT read from the TOML — they are stamped
// server-side from the transport.

import { parse } from "@std/toml";

// Single source of truth for the lifecycle enum, shared by the zod input
// schemas (mcp-server.ts) and the DB enum (db/04-sessions.sql).
export const SESSION_STATUSES = [
  "active",
  "awaiting_review",
  "blocked",
  "done",
  "abandoned",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Columns that `session_list` is allowed to ORDER BY. Whitelisted so the value
// is never interpolated into SQL untrusted.
export const SESSION_ORDER_BY = [
  "last_update",
  "started_at",
  "created_at",
  "title",
] as const;
export type SessionOrderBy = (typeof SESSION_ORDER_BY)[number];

export function normalizeOrderBy(v: string | null | undefined): SessionOrderBy {
  return (SESSION_ORDER_BY as readonly string[]).includes(v ?? "")
    ? (v as SessionOrderBy)
    : "last_update";
}

export type ParsedSession = {
  // Server-assigned canonical key. Absent on first capture (server mints it,
  // returns it); the client writes it back to refresh the same row. Parsed as a
  // positive integer.
  id: number | null;
  // Best-effort resumable handle — free-form TEXT, NOT the key. May be a
  // harness conversation-id or anything a surface exposes; null when none.
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
  status: SessionStatus | null;
  tags: string[];
  linked_issues: string[];
  related_sessions: string[];
  next_actions: string[];
  blockers: string[];
  resume_context: string | null;
  summary: string | null;
};

export type ParsedArtifact = {
  position: number;
  kind: string;
  title: string;
  detail: string | null;
};

// The only field names a `[[artifacts]]` entry may carry. Unknown keys (e.g. the
// legacy `ref`/`note`, or a typo) are rejected loudly rather than dropped.
const ARTIFACT_KEYS = new Set(["kind", "title", "detail"]);

export type ParsedSessionDoc = {
  session: ParsedSession;
  artifacts: ParsedArtifact[];
  rawToml: string;
};

// The canonical key is a positive integer (BIGINT identity in the DB). TOML
// integers parse to JS number; tolerate a quoted integer too. Anything else is
// rejected loudly rather than coerced — a bad key should fail, not mis-target.
// Must be a SAFE integer: `id` is the upsert/lookup key, so a value past
// 2^53-1 (which a JS number rounds silently) has to be rejected, not rounded
// into mis-targeting a different row.
function toPositiveIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number"
    ? v
    : (typeof v === "string" && /^[0-9]+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (Number.isSafeInteger(n) && n > 0) return n;
  throw new Error(`id ${JSON.stringify(v)} must be a positive integer below 2^53`);
}

function toStrOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

// TOML date/datetime values parse to Date; keep ISO strings so the value is
// deterministic for tests and unambiguous for Postgres timestamptz binding.
function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v.trim() || null;
  return String(v);
}

// DATE column: keep only the calendar-date portion.
function toDateOrNull(v: unknown): string | null {
  const iso = toIsoOrNull(v);
  return iso === null ? null : iso.split("T")[0];
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function parseStatus(v: unknown): SessionStatus | null {
  if (v === null || v === undefined) return null;
  if (
    typeof v === "string" &&
    (SESSION_STATUSES as readonly string[]).includes(v)
  ) {
    return v as SessionStatus;
  }
  throw new Error(
    `invalid status ${JSON.stringify(v)}; must be one of ${
      SESSION_STATUSES.join(" | ")
    }`,
  );
}

// Support a `+++`-fenced front-matter block (markdown body after it is ignored
// for column mapping but preserved verbatim in raw_toml). Otherwise treat the
// whole input as a TOML document.
function extractToml(input: string): string {
  const noBom = input.replace(/^\uFEFF/, "");
  const m = noBom.match(
    /^\s*\+\+\+\s*\r?\n([\s\S]*?)\r?\n\+\+\+\s*(?:\r?\n|$)/,
  );
  return m ? m[1] : noBom;
}

export function parseSessionToml(tomlText: string): ParsedSessionDoc {
  const doc = parse(extractToml(tomlText)) as Record<string, unknown>;

  const title = toStrOrNull(doc.title);
  if (!title || !title.trim()) {
    throw new Error("session TOML is missing required field 'title'");
  }

  const session: ParsedSession = {
    id: toPositiveIntOrNull(doc.id),
    // Free-form resumable handle; no longer UUID-validated (the random UUID was
    // the demoted PK — see db/04-sessions.sql).
    session_id: toStrOrNull(doc.session_id),
    title,
    session_date: toDateOrNull(doc.session_date),
    goal: toStrOrNull(doc.goal),
    agent: toStrOrNull(doc.agent),
    agent_version: toStrOrNull(doc.agent_version),
    harness: toStrOrNull(doc.harness),
    machine: toStrOrNull(doc.machine),
    working_dir: toStrOrNull(doc.working_dir),
    repo_url: toStrOrNull(doc.repo_url),
    branch: toStrOrNull(doc.branch),
    head: toStrOrNull(doc.head),
    worktree: toStrOrNull(doc.worktree),
    started_at: toIsoOrNull(doc.started_at),
    last_update: toIsoOrNull(doc.last_update),
    ended_at: toIsoOrNull(doc.ended_at),
    status: parseStatus(doc.status),
    tags: toStringArray(doc.tags),
    linked_issues: toStringArray(doc.linked_issues),
    related_sessions: toStringArray(doc.related_sessions),
    next_actions: toStringArray(doc.next_actions),
    blockers: toStringArray(doc.blockers),
    resume_context: toStrOrNull(doc.resume_context),
    summary: toStrOrNull(doc.summary),
  };

  // Canonical artifact block is `[[artifacts]]` (plural), matching the concept
  // and the sessions.artifact columns. Reject any singular `artifact` key
  // loudly instead of silently dropping it (strict artifacts parsing): a parsed-but-unread block
  // previously returned success with `artifacts: []`. The guard fires on any
  // value under `artifact` — array-of-tables `[[artifact]]`, a single
  // `[artifact]` table, or a scalar — so the message names the key rather than
  // assuming the `[[artifact]]` shape.
  if (doc.artifact !== undefined) {
    throw new Error(
      "found an 'artifact' key (singular); the canonical spelling is " +
        "'[[artifacts]]' (plural) with fields kind, title, detail",
    );
  }

  // `[[artifacts]]` → array; tolerate a single `[artifacts]` table.
  const rawArtifacts = doc.artifacts;
  const artifactList: unknown[] = Array.isArray(rawArtifacts)
    ? rawArtifacts
    : (rawArtifacts && typeof rawArtifacts === "object" ? [rawArtifacts] : []);

  const artifacts: ParsedArtifact[] = artifactList.map((a, i) => {
    const o = (a ?? {}) as Record<string, unknown>;
    // Reject unknown keys loudly rather than dropping them — a silent drop
    // reads as success (strict artifacts parsing). Catches the legacy `ref`/`note` + typos.
    const unknownKeys = Object.keys(o).filter((k) => !ARTIFACT_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `artifacts[${i}] has unknown field(s) ${unknownKeys.join(", ")}; ` +
          "allowed: kind, title, detail",
      );
    }
    const kind = toStrOrNull(o.kind);
    const title = toStrOrNull(o.title);
    if (!kind || !title) {
      throw new Error(
        `artifacts[${i}] is missing required 'kind' and/or 'title'`,
      );
    }
    return { position: i, kind, title, detail: toStrOrNull(o.detail) };
  });

  return { session, artifacts, rawToml: tomlText };
}

// Max characters the embedder actually consumes -- mirrors the slice in
// embeddings.ts `embed()`. Local constant (not imported) so this module stays
// dependency-free and hermetically testable. Truncating here keeps content_hash
// aligned with what is embedded: an edit past this boundary cannot change the
// vector, so it must not force a re-embed either.
const EMBED_INPUT_MAX_CHARS = 8000;

// The text fed to the embedder, and the exact string computeContentHash hashes.
// Only these four fields drive re-embedding, so edits to lists
// (next_actions/blockers/tags) do not trigger one. Fields are joined with a NUL
// delimiter so distinct compositions cannot collide (e.g. "AB"+"" vs "A"+"B").
export function embedSource(s: ParsedSession): string {
  return [s.title, s.goal, s.summary, s.resume_context]
    .map((x) => x ?? "")
    .join("\u0000")
    .slice(0, EMBED_INPUT_MAX_CHARS);
}

export async function computeContentHash(s: ParsedSession): Promise<string> {
  const data = new TextEncoder().encode(embedSource(s));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
