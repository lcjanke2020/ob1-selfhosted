// session-tracker TOML parsing + content hashing. Pure logic, no DB
// or HTTP imports, so it is hermetically unit-testable (session_toml_test.ts).
//
// TOML front matter is the interchange format accepted by `session_capture`,
// which hands the whole document to `parseSessionToml`. It maps the front
// matter onto the sessions.session columns and the `[[artifacts]]`
// array-of-tables onto sessions.artifact rows. The parser reads a fixed
// allowlist of known top-level fields from the parsed document. Unknown keys
// are rejected: silently dropping a misspelled workspace would widen the write
// to the default workspace. Provenance/owner fields are deliberately NOT
// authorable — they are stamped server-side from verified request context.

import { parse } from "@std/toml";
import {
  MEMORY_VISIBILITIES,
  type MemoryVisibility,
} from "./scope_contract.ts";

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
  workspace_id: string | null;
  project_id: string | null;
  visibility: MemoryVisibility | null;
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

const SESSION_KEYS = new Set([
  "id",
  "session_id",
  "title",
  "session_date",
  "goal",
  "agent",
  "agent_version",
  "harness",
  "machine",
  "working_dir",
  "repo_url",
  "branch",
  "head",
  "worktree",
  "started_at",
  "last_update",
  "ended_at",
  "status",
  "tags",
  "linked_issues",
  "related_sessions",
  "next_actions",
  "blockers",
  "resume_context",
  "summary",
  "workspace_id",
  "project_id",
  "visibility",
  "artifacts",
]);

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
    : (typeof v === "string" && /^[0-9]+$/.test(v.trim())
      ? Number(v.trim())
      : NaN);
  if (Number.isSafeInteger(n) && n > 0) return n;
  throw new Error(
    `id ${JSON.stringify(v)} must be a positive integer below 2^53`,
  );
}

function toStrOrNull(field: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return v;
}

function toScopeIdOrNull(field: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const value = v.trim();
  if (!value) throw new Error(`${field} must not be empty`);
  if (value.length > 128) {
    throw new Error(`${field} must be at most 128 characters`);
  }
  return value;
}

function parseVisibility(v: unknown): MemoryVisibility | null {
  if (v === null || v === undefined) return null;
  if (
    typeof v === "string" &&
    (MEMORY_VISIBILITIES as readonly string[]).includes(v)
  ) {
    return v as MemoryVisibility;
  }
  throw new Error(
    `invalid visibility ${JSON.stringify(v)}; must be one of ${
      MEMORY_VISIBILITIES.join(" | ")
    }`,
  );
}

export const SESSION_TIMESTAMP_FORMAT_MESSAGE =
  "must be YYYY-MM-DD or a valid ISO-8601 timestamp with a timezone";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function invalidTimestamp(field: string): Error {
  return new Error(`${field} ${SESSION_TIMESTAMP_FORMAT_MESSAGE}`);
}

// Validate and normalize date/time strings before they can reach PostgreSQL.
// Date-only values are the one documented convenience conversion: timestamp
// fields expand them to midnight UTC. Full timestamps retain the caller's
// explicit offset/text after validation, so raw structured state remains
// recognizable while PostgreSQL receives an unambiguous instant.
export function normalizeSessionTimestamp(
  value: string,
  field = "timestamp",
): string {
  const input = value.trim();
  const date = DATE_ONLY_PATTERN.exec(input);
  if (date) {
    const [, y, m, d] = date;
    if (validCalendarDate(Number(y), Number(m), Number(d))) {
      return `${input}T00:00:00.000Z`;
    }
    throw invalidTimestamp(field);
  }

  const timestamp = TIMESTAMP_PATTERN.exec(input);
  if (!timestamp) throw invalidTimestamp(field);
  const [, y, m, d, hour, minute, second = "0", , , offsetHour, offsetMinute] =
    timestamp;
  if (
    !validCalendarDate(Number(y), Number(m), Number(d)) ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (offsetHour !== undefined &&
      (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) ||
    !Number.isFinite(Date.parse(input))
  ) {
    throw invalidTimestamp(field);
  }
  return input;
}

export function isSessionTimestamp(value: string): boolean {
  try {
    normalizeSessionTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

// TOML date/datetime values parse to Date; normalize them to UTC. Quoted
// strings go through the same strict validator used by MCP/REST list bounds.
function toIsoOrNull(field: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) throw invalidTimestamp(field);
    return v.toISOString();
  }
  if (typeof v === "string") return normalizeSessionTimestamp(v, field);
  throw invalidTimestamp(field);
}

// DATE column: normalize through UTC so an explicit offset and an unquoted
// TOML datetime cannot produce different calendar dates for the same instant.
function toDateOrNull(field: string, v: unknown): string | null {
  const timestamp = toIsoOrNull(field, v);
  return timestamp === null
    ? null
    : new Date(timestamp).toISOString().slice(0, 10);
}

function toStringArray(field: string, v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return v.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${field}[${index}] must be a string`);
    }
    return item;
  });
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

  if (doc.owner_subject !== undefined) {
    throw new Error("owner_subject is server-stamped and cannot be authored");
  }
  const unknownTopLevel = Object.keys(doc).filter((key) =>
    !SESSION_KEYS.has(key) && key !== "artifact"
  );
  if (unknownTopLevel.length > 0) {
    throw new Error(
      `session TOML has unknown top-level field(s) ${
        unknownTopLevel.join(", ")
      }`,
    );
  }

  const title = toStrOrNull("title", doc.title);
  if (!title || !title.trim()) {
    throw new Error("session TOML is missing required field 'title'");
  }

  const session: ParsedSession = {
    id: toPositiveIntOrNull(doc.id),
    // Free-form resumable handle; no longer UUID-validated (the random UUID was
    // the demoted PK — see db/04-sessions.sql).
    session_id: toStrOrNull("session_id", doc.session_id),
    title,
    session_date: toDateOrNull("session_date", doc.session_date),
    goal: toStrOrNull("goal", doc.goal),
    agent: toStrOrNull("agent", doc.agent),
    agent_version: toStrOrNull("agent_version", doc.agent_version),
    harness: toStrOrNull("harness", doc.harness),
    machine: toStrOrNull("machine", doc.machine),
    working_dir: toStrOrNull("working_dir", doc.working_dir),
    repo_url: toStrOrNull("repo_url", doc.repo_url),
    branch: toStrOrNull("branch", doc.branch),
    head: toStrOrNull("head", doc.head),
    worktree: toStrOrNull("worktree", doc.worktree),
    started_at: toIsoOrNull("started_at", doc.started_at),
    last_update: toIsoOrNull("last_update", doc.last_update),
    ended_at: toIsoOrNull("ended_at", doc.ended_at),
    status: parseStatus(doc.status),
    tags: toStringArray("tags", doc.tags),
    linked_issues: toStringArray("linked_issues", doc.linked_issues),
    related_sessions: toStringArray("related_sessions", doc.related_sessions),
    next_actions: toStringArray("next_actions", doc.next_actions),
    blockers: toStringArray("blockers", doc.blockers),
    resume_context: toStrOrNull("resume_context", doc.resume_context),
    summary: toStrOrNull("summary", doc.summary),
    workspace_id: toScopeIdOrNull("workspace_id", doc.workspace_id),
    project_id: toScopeIdOrNull("project_id", doc.project_id),
    visibility: parseVisibility(doc.visibility),
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

  // `[[artifacts]]` must parse to an array of tables. A single `[artifacts]`
  // table, a scalar, or any other shape is schema-invalid and must not be
  // rewritten into a different artifact set while reporting success.
  const rawArtifacts = doc.artifacts;
  if (rawArtifacts !== null && rawArtifacts !== undefined) {
    if (!Array.isArray(rawArtifacts)) {
      throw new Error(
        "artifacts must be an array of tables written as [[artifacts]]",
      );
    }
  }
  const artifactList: unknown[] = rawArtifacts ?? [];

  const artifacts: ParsedArtifact[] = artifactList.map((a, i) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(`artifacts[${i}] must be a table`);
    }
    const o = a as Record<string, unknown>;
    // Reject unknown keys loudly rather than dropping them — a silent drop
    // reads as success (strict artifacts parsing). Catches the legacy `ref`/`note` + typos.
    const unknownKeys = Object.keys(o).filter((k) => !ARTIFACT_KEYS.has(k));
    if (unknownKeys.length > 0) {
      throw new Error(
        `artifacts[${i}] has unknown field(s) ${unknownKeys.join(", ")}; ` +
          "allowed: kind, title, detail",
      );
    }
    const kind = toStrOrNull(`artifacts[${i}].kind`, o.kind);
    const title = toStrOrNull(`artifacts[${i}].title`, o.title);
    if (!kind?.trim() || !title?.trim()) {
      throw new Error(
        `artifacts[${i}] requires non-empty string fields 'kind' and 'title'`,
      );
    }
    return {
      position: i,
      kind,
      title,
      detail: toStrOrNull(`artifacts[${i}].detail`, o.detail),
    };
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
