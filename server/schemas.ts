// Shared Zod input validation for the MCP tools (mcp-server.ts) and the REST
// gateway (api.ts). The MCP SDK's registerTool takes a RAW SHAPE (a plain
// object of Zod fields), so the shared exports here are raw shapes; the REST
// layer wraps them in z.object(...) — both transports validate byte-identically,
// including defaults. REST-only derivations (query-string coercion, path-param
// schemas) live at the bottom so every input bound is auditable in one file.

import { z } from "zod";
import { SESSION_ORDER_BY, SESSION_STATUSES } from "./session_toml.ts";

// Hard cap on captured content at 100 000 UTF-8 bytes (≈97.7 KiB;
// round-decimal limit, not a binary KiB). Downstream paths fan out through
// metadata.ts (full content sent to a paid CHAT_API_BASE /chat/completions
// endpoint) and queries.ts (full content INSERTed into postgres), so an
// authenticated client without a size bound can rack up token costs or chew
// through disk. The cost is byte-driven (tokens, storage, request body), so
// the strict bound is measured in UTF-8 bytes, not JS UTF-16 code units.
export const MAX_CONTENT_BYTES = 100_000;

// Module-level shared TextEncoder so the byte-cap refine doesn't
// allocate a fresh instance on every capture call.
const UTF8_ENCODER = new TextEncoder();

// `.max(MAX_CONTENT_BYTES)` runs first as a fast-path pre-check. Zod's
// `.max` on a string measures UTF-16 code units (JS string length); UTF-8
// encoding takes ≥ 1 byte per UTF-16 code unit (the smallest UTF-8 encoding
// of a BMP codepoint is 1 byte, and codepoints outside the BMP take 2 code
// units AND 4 UTF-8 bytes, so the inequality still holds). Therefore any
// string with code-unit length above the byte budget is guaranteed to exceed
// the byte budget too — sound cheap rejection of adversarial multi-MB inputs
// without allocating ~4× the input as a UTF-8 buffer. The `.refine` then
// enforces the byte-accurate bound for inputs that pass the code-unit
// pre-check (which would otherwise slip ~4× over budget for pure-non-ASCII
// content under just `.max`).
export function boundedUtf8String(field: string) {
  return z
    .string()
    .min(1)
    .max(MAX_CONTENT_BYTES)
    .refine(
      (s) => UTF8_ENCODER.encode(s).length <= MAX_CONTENT_BYTES,
      { message: `${field} must be at most ${MAX_CONTENT_BYTES} UTF-8 bytes` },
    );
}

// ---- thoughts ---------------------------------------------------------

// Version of the persisted `metadata.provenance` object. Callers submit only
// their claims; the server owns this version so the stored contract cannot be
// forged or drift independently across MCP and REST clients.
export const THOUGHT_PROVENANCE_SCHEMA_VERSION = 1 as const;

// Provenance values are labels/identifiers, not free-form notes. Bound each
// value independently so an authenticated caller cannot bypass the thought
// content cap by stuffing a large payload into JSONB metadata. 1024 characters
// leaves ample room for repository URLs and long generated branch names.
export const MAX_PROVENANCE_VALUE_CHARS = 1024;

const provenanceValue = (field: string) =>
  z.string().trim().min(1, `${field} must not be empty`).max(
    MAX_PROVENANCE_VALUE_CHARS,
    `${field} must be at most ${MAX_PROVENANCE_VALUE_CHARS} characters`,
  );

// These are caller ASSERTIONS, not authenticated identity. `.strict()` makes
// misspelled/future fields fail visibly instead of being silently discarded;
// the refine prevents a meaningless `{provenance: {}}` envelope. The service
// wraps validated values in the versioned persisted shape and separately
// stamps the server-verified source/door/sub keys.
export const thoughtProvenanceClaimsSchema = z.object({
  author: provenanceValue("author").optional().describe(
    "Caller-asserted human or role identity behind the thought",
  ),
  agent: provenanceValue("agent").optional().describe(
    "Caller-asserted agent tool or model that wrote the thought",
  ),
  repo: provenanceValue("repo").optional().describe(
    "Caller-asserted repository URL, slug, or local identifier",
  ),
  branch: provenanceValue("branch").optional().describe(
    "Caller-asserted branch or work-context ref",
  ),
}).strict().refine(
  (claims) => Object.values(claims).some((value) => value !== undefined),
  {
    message:
      "provenance must include at least one of author, agent, repo, or branch",
  },
);

export type ThoughtProvenanceClaims = z.infer<
  typeof thoughtProvenanceClaimsSchema
>;

export const captureThoughtShape = {
  content: boundedUtf8String("content").describe("The thought to capture"),
  provenance: thoughtProvenanceClaimsSchema.optional().describe(
    "Optional caller-asserted author/agent/repo/branch context. Supply known values and omit unknowns; the server stores claims separately from verified transport identity.",
  ),
};

export const searchThoughtsShape = {
  query: z.string().min(1).describe("What to search for"),
  limit: z.number().int().min(1).max(100).optional().default(10),
  threshold: z.number().min(0).max(1).optional().default(0.5),
};

export const listThoughtsShape = {
  limit: z.number().int().min(1).max(100).optional().default(10),
  type: z.string().optional()
    .describe(
      "Filter by type: observation, task, idea, reference, person_note",
    ),
  topic: z.string().optional().describe("Filter by topic tag"),
  person: z.string().optional().describe("Filter by person mentioned"),
  days: z.number().int().min(1).max(3650).optional()
    .describe("Only thoughts from the last N days"),
};

// ---- sessions ---------------------------------------------------------

export const sessionCaptureShape = {
  // Same UTF-8 byte cap as capture_thought: the full doc is embedded and
  // stored, so bound it in bytes, not UTF-16 code units.
  toml_text: boundedUtf8String("toml_text").describe(
    "The session's TOML front matter (optionally inside a +++ fence)",
  ),
};

export const sessionLookupShape = {
  id: z.number().int().positive().optional()
    .describe("Session id (the canonical key returned by session_capture)"),
  branch: z.string().optional().describe(
    "Git branch; the newest matching session is returned",
  ),
};

export const sessionSearchShape = {
  query: z.string().min(1).describe("What to search for"),
  limit: z.number().int().min(1).max(50).optional().default(5),
  status: z.enum(SESSION_STATUSES).optional(),
  repo_url: z.string().optional(),
  tag: z.string().optional().describe("Match a single tag"),
};

export const sessionListShape = {
  status: z.enum(SESSION_STATUSES).optional(),
  repo_url: z.string().optional(),
  branch: z.string().optional(),
  agent: z.string().optional(),
  tag: z.string().optional(),
  linked_issue: z.string().optional().describe(
    "Match a single linked issue (e.g. PROJ-123)",
  ),
  since: z.string().optional().describe(
    "ISO date/datetime lower bound on last_update",
  ),
  until: z.string().optional().describe(
    "ISO date/datetime upper bound on last_update",
  ),
  order_by: z.enum(SESSION_ORDER_BY).optional().default("last_update"),
  limit: z.number().int().min(1).max(200).optional().default(50),
};

export const sessionUpdateStatusShape = {
  id: z.number().int().positive()
    .describe("Session id (the canonical key returned by session_capture)"),
  status: z.enum(SESSION_STATUSES),
};

// ---- REST bodies ------------------------------------------------------
// z.object(...) around the shared shapes, so a REST body and an MCP tool
// call cannot drift apart in what they accept.

export const captureThoughtBody = z.object(captureThoughtShape);
export const searchThoughtsBody = z.object(searchThoughtsShape);
export const sessionCaptureBody = z.object(sessionCaptureShape);
export const sessionSearchBody = z.object(sessionSearchShape);
// The session id arrives via the URL path on REST (PATCH /sessions/:id/status),
// so the body carries only the status.
export const sessionUpdateStatusBody = z.object({
  status: z.enum(SESSION_STATUSES),
});

// ---- REST query strings -----------------------------------------------
// Query-string values always arrive as strings, so numeric fields use
// z.coerce. Bounds mirror the MCP shapes above exactly.

export const listThoughtsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  type: z.string().optional(),
  topic: z.string().optional(),
  person: z.string().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
});

export const listSessionsQuery = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  repo_url: z.string().optional(),
  branch: z.string().optional(),
  agent: z.string().optional(),
  tag: z.string().optional(),
  linked_issue: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  order_by: z.enum(SESSION_ORDER_BY).default("last_update"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sessionLookupQuery = z.object({
  id: z.coerce.number().int().positive().optional(),
  branch: z.string().min(1).optional(),
}).refine((v) => v.id != null || v.branch != null, {
  // Matches the MCP session_lookup error text.
  message: "Provide id or branch.",
});

// ---- REST path params -------------------------------------------------

// Thought ids are Postgres gen_random_uuid() values; rejecting a malformed id
// here yields a 400 instead of a Postgres uuid-cast error surfacing as a 500.
export const thoughtIdParam = z.uuid();

// The session key is a BIGINT identity. The safe-integer ceiling mirrors
// toPositiveIntOrNull in session_toml.ts: a value past 2^53-1 would round
// silently and could mis-target a different row, so reject it instead.
export const sessionIdParam = z.coerce.number().int().positive()
  .max(Number.MAX_SAFE_INTEGER);
