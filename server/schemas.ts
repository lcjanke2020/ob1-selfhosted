// Shared Zod input validation for the MCP tools (mcp-server.ts) and the REST
// gateway (api.ts). Shared fields are raw shapes so both transports can compose
// them. When envelope strictness is part of the contract, as it is for thought
// search, both transports reuse the same assembled object schema. REST-only
// derivations (query-string coercion, path-param schemas) live at the bottom so
// every input bound is auditable in one file.

import { z } from "zod";
import { SESSION_ORDER_BY, SESSION_STATUSES } from "./session_toml.ts";
import { MEMORY_VISIBILITIES } from "./scope_contract.ts";

// Hard cap on captured content at 100 000 UTF-8 bytes (≈97.7 KiB;
// round-decimal limit, not a binary KiB). Downstream paths fan out through
// metadata.ts (full content sent to a paid CHAT_API_BASE /chat/completions
// endpoint) and queries.ts (full content INSERTed into postgres), so an
// authenticated client without a size bound can rack up token costs or chew
// through disk. The cost is byte-driven (tokens, storage, request body), so
// the strict bound is measured in UTF-8 bytes, not JS UTF-16 code units.
export const MAX_CONTENT_BYTES = 100_000;

// Search text fans out to both the embedding backend and PostgreSQL's text
// query parser. Keep it comfortably below PostgreSQL's tsquery complexity
// limits so an authenticated caller cannot turn a search into an oversized
// parser/planner workload. This is a UTF-8 byte bound for the same reason as
// captured content: request cost follows bytes, not JavaScript code units.
export const MAX_SEARCH_QUERY_BYTES = 8 * 1024;
export const MAX_SCOPE_ID_CHARS = 128;

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
export function boundedUtf8String(
  field: string,
  maxBytes = MAX_CONTENT_BYTES,
) {
  return z
    .string()
    .min(1)
    .max(maxBytes, `${field} must be at most ${maxBytes} UTF-8 bytes`)
    .refine(
      (s) => UTF8_ENCODER.encode(s).length <= maxBytes,
      { message: `${field} must be at most ${maxBytes} UTF-8 bytes` },
    );
}

// ---- thoughts ---------------------------------------------------------

// Version of the persisted `metadata.provenance` object. Callers submit only
// their claims; the server owns this version so the stored contract cannot be
// forged or drift independently across MCP and REST clients.
export const THOUGHT_PROVENANCE_SCHEMA_VERSION = 1 as const;

// Canonical order for the caller-asserted claim keys. Query construction uses
// this list too so bound-parameter order cannot vary with JSON property order.
export const THOUGHT_PROVENANCE_FIELDS = [
  "author",
  "agent",
  "repo",
  "branch",
] as const;

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
).meta({
  // Zod refinements enforce runtime validation but are not representable in
  // generated JSON Schema. Publish the equivalent standard keyword so MCP
  // tools/list clients see the same non-empty-object contract.
  minProperties: 1,
});

export type ThoughtProvenanceClaims = z.infer<
  typeof thoughtProvenanceClaimsSchema
>;

// Search deliberately exposes only the provenance claims the server already
// owns as a versioned contract, not an open-ended JSONPath/query language over
// every metadata key. Includes are conjunctive; exclusions are any-match deny
// terms (the SQL layer emits one negative predicate per supplied field).
export const thoughtSearchFilterSchema = z.object({
  include: thoughtProvenanceClaimsSchema.optional().describe(
    "Require every supplied caller-asserted provenance field",
  ),
  exclude: thoughtProvenanceClaimsSchema.optional().describe(
    "Exclude a thought when any supplied caller-asserted provenance field matches",
  ),
}).strict().refine(
  (filter) => filter.include !== undefined || filter.exclude !== undefined,
  { message: "filter must specify include or exclude" },
).meta({ minProperties: 1 });

export type ThoughtSearchFilter = z.infer<typeof thoughtSearchFilterSchema>;

const scopeId = (field: string) =>
  z.string().trim().min(1, `${field} must not be empty`).max(
    MAX_SCOPE_ID_CHARS,
    `${field} must be at most ${MAX_SCOPE_ID_CHARS} characters`,
  );

// Strict nested object: a misspelled workspace/project/visibility must never be
// stripped into omitted scope (which resolves to `default`). Field names align
// with upstream OB1's agent-memory contract. On reads, visibility optionally
// narrows the server-computed audience union to one class.
export const memoryScopeSchema = z.object({
  workspace_id: scopeId("workspace_id").optional().describe(
    "Registered top-level memory workspace; omitted means the configured default workspace",
  ),
  project_id: scopeId("project_id").nullable().optional().describe(
    "Optional project registered inside workspace_id",
  ),
  visibility: z.enum(MEMORY_VISIBILITIES).optional().describe(
    "Capture audience, or an optional single-class narrowing on reads",
  ),
}).strict();

export type MemoryScopeInput = z.infer<typeof memoryScopeSchema>;

export const captureThoughtShape = {
  content: boundedUtf8String("content").describe("The thought to capture"),
  provenance: thoughtProvenanceClaimsSchema.optional().describe(
    "Optional caller-asserted author/agent/repo/branch context. Supply known values and omit unknowns; the server stores claims separately from verified transport identity.",
  ),
  scope: memoryScopeSchema.optional().describe(
    "Fail-closed workspace/project/visibility audience. Omitted means the configured default workspace, never all workspaces.",
  ),
};

export const thoughtSearchQuerySchema = boundedUtf8String(
  "query",
  MAX_SEARCH_QUERY_BYTES,
).refine((query) => query.trim().length > 0, {
  message: "query must not be empty",
});

export const searchThoughtsShape = {
  query: thoughtSearchQuerySchema.describe(
    "Natural-language or literal text to search for. The lexical leg supports quoted phrases, OR, and -term web-search syntax.",
  ),
  limit: z.number().int().min(1).max(100).optional().default(10),
  threshold: z.number().min(0).max(1).optional().default(0.5).describe(
    "Minimum cosine similarity for admission through the vector leg. Exact lexical hits may still be returned below this value.",
  ),
  filter: thoughtSearchFilterSchema.optional().describe(
    "Optional caller-asserted provenance filter. Include fields are ANDed; a match on any exclude field rejects the thought.",
  ),
  scope: memoryScopeSchema.optional().describe(
    "Workspace/project recall context, optionally narrowed to one visibility class",
  ),
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
  scope: memoryScopeSchema.optional(),
};

export const fetchThoughtShape = {
  id: z.string().describe("The thought ID returned by search"),
  scope: memoryScopeSchema.optional(),
};

export const thoughtStatsShape = {
  scope: memoryScopeSchema.optional(),
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
  scope: memoryScopeSchema.optional(),
};

export const sessionSearchShape = {
  query: z.string().min(1).describe("What to search for"),
  limit: z.number().int().min(1).max(50).optional().default(5),
  status: z.enum(SESSION_STATUSES).optional(),
  repo_url: z.string().optional(),
  tag: z.string().optional().describe("Match a single tag"),
  scope: memoryScopeSchema.optional(),
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
  scope: memoryScopeSchema.optional(),
};

export const sessionUpdateStatusShape = {
  id: z.number().int().positive()
    .describe("Session id (the canonical key returned by session_capture)"),
  status: z.enum(SESSION_STATUSES),
  scope: memoryScopeSchema.optional(),
};

// A typo in the top-level filter key would otherwise be stripped into an
// unfiltered search. The MCP SDK accepts an assembled object schema here, so
// REST and MCP can share the same fail-closed envelope as well as field shapes.
export const searchThoughtsSchema = z.object(searchThoughtsShape).strict();
export const captureThoughtSchema = z.object(captureThoughtShape).strict();
export const listThoughtsSchema = z.object(listThoughtsShape).strict();
export const fetchThoughtSchema = z.object(fetchThoughtShape).strict();
export const thoughtStatsSchema = z.object(thoughtStatsShape).strict();
export const sessionCaptureSchema = z.object(sessionCaptureShape).strict();
export const sessionLookupSchema = z.object(sessionLookupShape).strict();
export const sessionSearchSchema = z.object(sessionSearchShape).strict();
export const sessionListSchema = z.object(sessionListShape).strict();
export const sessionUpdateStatusSchema = z.object(sessionUpdateStatusShape)
  .strict();
export const compatibilitySearchSchema = z.object({
  query: thoughtSearchQuerySchema.describe(
    "The search query to run against Open Brain",
  ),
  scope: memoryScopeSchema.optional(),
}).strict();

// ---- REST bodies ------------------------------------------------------
// z.object(...) around the shared shapes, so a REST body and an MCP tool
// call cannot drift apart in what they accept.

export const captureThoughtBody = captureThoughtSchema;
// Search filters narrow or exclude returned memory, so a misspelled envelope
// key must fail visibly instead of being stripped into an unfiltered search.
export const searchThoughtsBody = searchThoughtsSchema;
export const sessionCaptureBody = sessionCaptureSchema;
export const sessionSearchBody = sessionSearchSchema;
// The session id arrives via the URL path on REST (PATCH /sessions/:id/status),
// so the body carries only the status.
export const sessionUpdateStatusBody = z.object({
  status: z.enum(SESSION_STATUSES),
  scope: memoryScopeSchema.optional(),
}).strict();

// ---- REST query strings -----------------------------------------------
// Query-string values always arrive as strings, so numeric fields use
// z.coerce. Bounds mirror the MCP shapes above exactly.

export const listThoughtsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  type: z.string().optional(),
  topic: z.string().optional(),
  person: z.string().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  workspace_id: scopeId("workspace_id").optional(),
  project_id: scopeId("project_id").optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
}).strict();

export const scopeQuery = z.object({
  workspace_id: scopeId("workspace_id").optional(),
  project_id: scopeId("project_id").optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
}).strict();

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
  workspace_id: scopeId("workspace_id").optional(),
  project_id: scopeId("project_id").optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
}).strict();

export const sessionLookupQuery = z.object({
  id: z.coerce.number().int().positive().optional(),
  branch: z.string().min(1).optional(),
  workspace_id: scopeId("workspace_id").optional(),
  project_id: scopeId("project_id").optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
}).strict().refine((v) => v.id != null || v.branch != null, {
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
