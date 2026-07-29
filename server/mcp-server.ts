// MCP server factory. A fresh `McpServer` is built per HTTP request — the
// @modelcontextprotocol/sdk McpServer mutates its internal transport
// reference on connect(), so sharing one instance across concurrent
// requests races (see matthallett1's review of upstream OB1 PR #143,
// finding #4: "module-scoped McpServer with per-request reconnection").

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "postgres";

import { CITATION_BASE_URL } from "./config.ts";
import {
  mcpError as err,
  mcpJsonCollection,
  mcpJsonRecord,
  mcpText as text,
  mcpTextRecords,
} from "./mcp_result.ts";
import {
  captureThoughtSchema,
  compatibilitySearchSchema,
  fetchThoughtSchema,
  listThoughtsSchema,
  type MemoryScopeInput,
  searchThoughtsSchema,
  sessionCaptureSchema,
  sessionListSchema,
  sessionLookupSchema,
  sessionSearchSchema,
  sessionUpdateStatusSchema,
  thoughtStatsSchema,
} from "./schemas.ts";
import {
  captureSessionFromToml,
  captureThoughtWithMetadata,
  defaultDeps,
  fetchThoughtInScope,
  getThoughtStatsInScope,
  listSessionsInScope,
  listThoughtsInScope,
  lookupSessionInScope,
  searchSessionsByQuery,
  searchThoughtsByQuery,
  type ServiceDeps,
  updateSessionStatusInScope,
} from "./services.ts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  // ISO date (UTC) rather than toLocaleDateString() so the same thought
  // renders identically regardless of host/container locale.
  const datePrefix = createdAt
    ? new Date(createdAt).toISOString().slice(0, 10)
    : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

function followUpScope(scope: MemoryScopeInput | undefined): string {
  return scope
    ? `Reuse this exact scope argument for every follow-up: ${
      JSON.stringify(scope)
    }.`
    : "Omit scope again on every follow-up to reuse this call's default scope.";
}

function scopedRestPath(
  path: string,
  scope: {
    workspace_id: string;
    project_id?: string | null;
    visibility: string;
  },
): string {
  const query = new URLSearchParams();
  query.set("workspace_id", scope.workspace_id);
  if (scope.project_id) query.set("project_id", scope.project_id);
  query.set("visibility", scope.visibility);
  return `${path}?${query.toString()}`;
}

// Session TOML schema contract, served verbatim as an MCP resource
// (registered in createMcpServer). The original artifact silent-drop happened
// because no schema was published and agents guessed field names; this is the
// single source of truth they can fetch instead of reverse-engineering return
// contracts. Keep field names in sync with ParsedSession/ParsedArtifact in
// session_toml.ts and the sessions.* columns in db/04-sessions.sql.
const SESSION_TOML_SCHEMA_DOC = `# Session TOML front-matter schema

A session is a TOML document (optionally wrapped in a \`+++\` fence; any markdown
body after the fence is preserved verbatim but not parsed). Pass the whole thing
to \`session_capture\`. The schema is **flat** — do NOT use nested
\`[identity]\`/\`[where]\`/\`[state_for_resuming]\` tables.

## Required
- \`title\` (string)

## The key
- \`id\` (integer) — the canonical key. **Omit on first capture**; the server
  assigns it and returns it. To *refresh* an existing session, write that exact
  \`id\` back so the capture updates the same row (omitting it inserts a new one).

## Optional scalars
- \`session_id\` (string) — an optional, best-effort *resumable handle* (e.g. a
  harness conversation-id), NOT the key. Free-form; NULL when none is available.
- \`goal\`, \`agent\`, \`agent_version\`, \`harness\`, \`machine\`, \`working_dir\`,
  \`repo_url\`, \`branch\`, \`head\`, \`worktree\` (strings)
- \`session_date\` (date), \`started_at\`, \`last_update\`, \`ended_at\`
  (date or RFC-3339 datetime; a date is expanded to midnight UTC)
- \`status\` — one of: active | awaiting_review | blocked | done | abandoned
  (defaults to active on first capture; on a refresh, omit it unless deliberately
  changing lifecycle state so the stored status is preserved)

Every ordinary string-valued scalar must use TOML string syntax; numbers and
booleans are not coerced to strings. Session time fields accept TOML date
literals, timezone-qualified TOML datetime literals, or quoted
timezone-qualified ISO-8601 strings.

## Optional arrays
- \`tags\`, \`linked_issues\`, \`related_sessions\`, \`next_actions\`, \`blockers\`
  — each must be an array whose every element is a quoted string

## Optional prose (use TOML multiline """…""")
- \`summary\`, \`resume_context\`

## Optional memory scope
- \`workspace_id\` (string) — registered workspace; omitted means the server's
  configured default workspace, never every workspace
- \`project_id\` (string) — registered project inside \`workspace_id\`
- \`visibility\` — personal | project | workspace. Omit it to use the
  workspace default (or project when \`project_id\` is present).

The seeded \`sensitive\` workspace is personal-only. It requires a verified
OAuth subject, or a shared-key deployment configured with
\`MCP_ACCESS_KEY_PRINCIPAL\`; broader visibility is rejected.

## Artifacts — \`[[artifacts]]\` (plural) array-of-tables
Each entry:
- \`kind\` (string, required) — e.g. pr | code | doc | note
- \`title\` (string, required)
- \`detail\` (string, optional)

A single \`[artifacts]\` table, a singular \`[[artifact]]\` block, or any other
field name inside an entry is **rejected**.

## Refresh semantics
A refresh (\`id\` present) replaces the authorable session document and its
entire artifact set; it is not a patch. \`title\` remains required. Apart from
\`session_id\` and \`status\`, which are preserved when omitted, omitted optional
scalars are stored as null, omitted arrays as empty arrays, and omitting all
\`[[artifacts]]\` removes previously stored artifacts. Re-send every field and
artifact you intend to retain, using the current structured record and live
context to assemble fresh TOML. Supply the existing row's scope when refreshing;
an ID outside the requested audience is indistinguishable from an unknown ID.

## Lookup and historical input
\`session_lookup\` returns the current structured fields plus \`raw_toml\`.
\`raw_toml\` is the verbatim document supplied to the most recent
\`session_capture\`; it is historical input, not canonical state, and may differ
from current structured fields (for example, after \`session_update_status\`).
Treat the structured fields as authoritative. Never use \`raw_toml\` as a
recapture template; assemble recapture TOML fresh from live context.

## Strict fields and server ownership
Unknown top-level fields are rejected so a misspelled \`workspace_id\` cannot
silently widen into the default workspace. \`owner_subject\` is stamped from
verified server context and is rejected if authored. Other storage/provenance
fields such as \`source\`, \`source_node\`, \`content_hash\`, \`created_at\`, and
\`updated_at\` are not accepted TOML fields either.

## Example
\`\`\`toml
+++
title = "Fix flaky CI"
status = "awaiting_review"
workspace_id = "sensitive"
visibility = "personal"
agent = "claude-code"
repo_url = "https://github.com/x/y"
branch = "main"
tags = ["ci", "flaky"]
next_actions = ["rerun pipeline"]
summary = """
Stabilized the retry path.
"""

[[artifacts]]
kind = "pr"
title = "PR #42 — retry backoff"
detail = "the fix"

[[artifacts]]
kind = "note"
title = "Tool inventory"
+++
\`\`\`
`;

// Per-request auth context captured as a closure variable on the
// factory rather than via AsyncLocalStorage. `createMcpServer` is already
// called fresh per HTTP request (index.ts wires it in app.all("/mcp", ...)
// and app.all("/", ...)) because the @modelcontextprotocol/sdk McpServer
// mutates an instance-scoped transport reference on connect() — see the
// file header. That per-request lifecycle gives the tool callbacks a
// natural enclosing scope to read door + sub from without an ALS hop.
export type RequestAuth = { door: "funnel" | "tailnet"; sub: string | null };

export function createMcpServer(
  pool: Pool,
  auth: RequestAuth,
  deps: ServiceDeps = defaultDeps,
): McpServer {
  const server = new McpServer({
    name: "open-brain-homelab",
    // Bump on behavior changes — this is the serverInfo version a client
    // sees on initialize. 1.2.0: breaking session-tool contract change
    // (session_resume → session_lookup; tools key on integer `id`).
    // 1.3.0: retired the file/Syncthing model — session_update_status returns
    // {id, status} (dropped needs_file_sync), and ingested_path/needs_file_sync
    // are gone from the TOML schema resource.
    // 1.4.0: opt-in REST gateway (/api/v1) alongside the MCP transport, so
    // captures now carry a `source` of "mcp" or "rest"; extractor output is
    // validated against the metadata schema at runtime (schema-invalid output
    // falls through to the fallback endpoint or the stub instead of reaching
    // the corpus); the embedding fetch timeout now covers the response body.
    // 1.5.0: capture_thought accepts bounded author/agent/repo/branch claims
    // and persists them in the versioned metadata.provenance contract while
    // retaining server-verified source/door/sub compatibility keys.
    // 1.6.0: search_thoughts accepts strict positive and negative provenance
    // filters shared byte-for-byte with the REST search body.
    // 1.7.0: thought search fuses bounded pgvector and token-preserving
    // full-text/literal candidate legs with reciprocal rank fusion (RRF).
    // 1.8.0: every rejected credential on the MCP transport now returns
    // HTTP 401 with the WWW-Authenticate challenge (was HTTP 200 + JSON-RPC
    // error for tried-but-invalid credentials), so OAuth clients refresh
    // expired tokens instead of stranding; plus live-reliability fixes in
    // the pool stack, log-ingester rotation cursors, and the funnel
    // summary window.
    // 1.9.0: fail-closed DB-enforced workspace/project/visibility audiences
    // across thoughts and sessions, including personal-only sensitive memory.
    // 1.10.0: session semantic search uses transaction-local iterative HNSW,
    // then an exact retry when RLS or status/repository/tag residual filters
    // exhaust the bounded ANN scan before enough visible matches are reached.
    // 1.11.0: thought, session, and compatibility search share nonblank,
    // UTF-8-byte-bounded queries; MCP thought fetch now publishes and enforces
    // the same UUID contract as REST before database work.
    // 1.12.0: MCP recall results enforce one 120,000-byte serialized budget,
    // preserve whole-record boundaries, and publish scope-safe recovery paths.
    // 1.13.0: metadata classification logs preserve non-2xx HTTP statuses and
    // distinguish endpoint availability, malformed responses, unparseable
    // output, and runtime-schema rejection.
    // 1.14.0: session capture rejects non-string values supplied to string
    // scalar/list fields and requires a strictly typed [[artifacts]] array.
    // 1.15.0: session time fields and list bounds reject malformed values
    // before database work; session search adds a bounded similarity floor.
    version: "1.15.0",
  });

  // ChatGPT-compatible search/fetch shapes (read-only). The standard names
  // `search` and `fetch` are what restricted-connector surfaces look for.
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning and exact text inside one fail-closed workspace scope. Read-only compatibility tool for ChatGPT-style search/fetch consumers. Oversized MCP results include explicit omission metadata and recovery guidance.",
      annotations: { readOnlyHint: true },
      inputSchema: compatibilitySearchSchema,
    },
    async ({ query, scope }) => {
      try {
        const rows = await searchThoughtsByQuery(
          pool,
          { query, scope, auth },
          deps,
        );
        const results = rows.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));
        return mcpJsonCollection(results, {
          fullPayload: (included) => ({ results: included }),
          id: (result) => result.id,
          recovery: `${followUpScope(scope)} ` +
            "Call fetch once per omitted ID, or rerun search with a narrower query.",
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Open Brain Thought",
      description:
        "Fetch one Open Brain thought by ID after using search. Read-only compatibility tool. If MCP serialization cannot carry a complete record, the response identifies omitted fields and the optional tailnet REST recovery path.",
      annotations: { readOnlyHint: true },
      inputSchema: fetchThoughtSchema,
    },
    async ({ id, scope }) => {
      try {
        const t = await fetchThoughtInScope(pool, id, { scope, auth });
        if (!t) return err(`No thought found for ID ${id}.`);
        const document = {
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          text: t.content,
          url: thoughtUrl(t.id),
          metadata: {
            ...t.metadata,
            workspace_id: t.workspace_id,
            project_id: t.project_id,
            visibility: t.visibility,
            created_at: t.created_at,
            updated_at: t.updated_at,
          },
        };
        const recovery = `When tailnet REST is enabled, use GET ${
          scopedRestPath(`/api/v1/thoughts/${t.id}`, t)
        } to retrieve fields omitted from this MCP result.`;
        return mcpJsonRecord(document, {
          reductions: [
            { field: "metadata", action: "replace", value: {} },
            {
              field: "text",
              action: "replace",
              value: `[Thought text omitted from MCP; ${recovery}]`,
            },
          ],
          recovery,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Hybrid-search captured thoughts by meaning and exact text inside one fail-closed workspace scope, optionally narrowing visibility or requiring/excluding caller-asserted provenance. Oversized MCP results retain complete records that fit and identify omitted thought IDs.",
      annotations: { readOnlyHint: true },
      inputSchema: searchThoughtsSchema,
    },
    async ({ query, limit, threshold, filter, scope }) => {
      try {
        const rows = await searchThoughtsByQuery(pool, {
          query,
          limit,
          threshold,
          filter,
          scope,
          auth,
        }, deps);
        if (!rows.length) return text(`No thoughts found matching "${query}".`);
        return mcpTextRecords(rows, {
          fullHeading: (total) => `Found ${total} thought(s):`,
          truncatedHeading: (included, total) =>
            `Showing ${included} of ${total} thought(s):`,
          renderRecord: (t, i) => {
            const m = t.metadata || {};
            const matchLabel = t.similarity < (threshold ?? 0.5)
              ? "exact-text match"
              : `${(t.similarity * 100).toFixed(1)}% semantic similarity`;
            const parts = [
              `--- Result ${i + 1} (${matchLabel}) ---`,
              `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
              `Space: ${t.workspace_id}${
                t.project_id ? ` / ${t.project_id}` : ""
              } (${t.visibility})`,
              `Type: ${m.type ?? "unknown"}`,
            ];
            if (Array.isArray(m.topics) && m.topics.length) {
              parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
            }
            if (Array.isArray(m.people) && m.people.length) {
              parts.push(`People: ${(m.people as string[]).join(", ")}`);
            }
            if (Array.isArray(m.action_items) && m.action_items.length) {
              parts.push(
                `Actions: ${(m.action_items as string[]).join("; ")}`,
              );
            }
            parts.push(`\n${t.content}`);
            return parts.join("\n");
          },
          id: (thought) => thought.id,
          recovery: `${followUpScope(scope)} ` +
            "Call fetch once per omitted ID; an abridged fetch will publish a fully scoped tailnet REST path when one is available.",
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "List recently captured thoughts inside one fail-closed workspace scope, with optional filters by type, topic, person, or time range. Oversized MCP results retain complete records that fit and identify omitted thought IDs.",
      annotations: { readOnlyHint: true },
      inputSchema: listThoughtsSchema,
    },
    async (opts) => {
      try {
        const rows = await listThoughtsInScope(pool, { ...opts, auth });
        if (!rows.length) return text("No thoughts found.");
        return mcpTextRecords(rows, {
          fullHeading: (total) => `${total} recent thought(s):`,
          truncatedHeading: (included, total) =>
            `Showing ${included} of ${total} recent thought(s):`,
          renderRecord: (t, i) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics)
              ? (m.topics as string[]).join(", ")
              : "";
            return `${i + 1}. [${
              new Date(t.created_at).toLocaleDateString()
            }] [${t.workspace_id}${
              t.project_id ? `/${t.project_id}` : ""
            }:${t.visibility}] (${m.type ?? "??"}${
              tags ? " - " + tags : ""
            })\n   ${t.content}`;
          },
          id: (thought) => thought.id,
          recovery: `${followUpScope(opts.scope)} ` +
            "Call fetch once per omitted ID; an abridged fetch will publish a fully scoped tailnet REST path when one is available.",
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description:
        "Summary of thoughts visible inside one fail-closed workspace scope: totals, types, top topics, people.",
      annotations: { readOnlyHint: true },
      inputSchema: thoughtStatsSchema,
    },
    async ({ scope }) => {
      try {
        const s = await getThoughtStatsInScope(pool, { scope, auth });
        const lines: string[] = [
          `Total thoughts: ${s.count}`,
          `Date range: ${
            s.earliest && s.latest
              ? new Date(s.earliest).toLocaleDateString() +
                " -> " +
                new Date(s.latest).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...s.types.map(([k, v]) => `  ${k}: ${v}`),
        ];
        if (s.topics.length) {
          lines.push("", "Top topics:");
          for (const [k, v] of s.topics) lines.push(`  ${k}: ${v}`);
        }
        if (s.people.length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of s.people) lines.push(`  ${k}: ${v}`);
        }
        return text(lines.join("\n"));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a new thought in a fail-closed workspace/project/visibility audience. The seeded sensitive workspace is personal-only. Generates an embedding and optional metadata; provenance claims remain separate from verified transport identity.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      // The UTF-8 byte cap and its rationale live with the shared shape in
      // schemas.ts — the REST gateway validates the identical bound.
      inputSchema: captureThoughtSchema,
    },
    async ({ content, provenance, scope }) => {
      try {
        // Embed + extract + door/sub stamping live in services.ts, shared
        // with the REST gateway; via: "mcp" keeps persisted rows identical
        // to the pre-extraction behavior (metadata.source === "mcp").
        const captured = await captureThoughtWithMetadata(
          pool,
          { content, provenance, scope, auth, via: "mcp" },
          deps,
        );
        const { id, metadata: meta } = captured;

        const parts: string[] = [`Captured as ${meta.type ?? "thought"}`];
        if (Array.isArray(meta.topics) && meta.topics.length) {
          parts.push(`-- ${(meta.topics as string[]).join(", ")}`);
        }
        if (Array.isArray(meta.people) && meta.people.length) {
          parts.push(`| People: ${(meta.people as string[]).join(", ")}`);
        }
        if (Array.isArray(meta.action_items) && meta.action_items.length) {
          parts.push(
            `| Actions: ${(meta.action_items as string[]).join("; ")}`,
          );
        }
        parts.push(
          `| Space: ${captured.workspace_id}${
            captured.project_id ? `/${captured.project_id}` : ""
          } (${captured.visibility})`,
        );
        parts.push(`(id: ${id})`);
        return text(parts.join(" "));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  // ---- session tracking -----------------------------------------
  // Sessions live in their own `sessions` schema (db/04-sessions.sql),
  // alongside thoughts. The DB is the canonical store; TOML front matter is the
  // interchange format accepted by session_capture, not a second on-disk
  // artifact. Provenance is stamped from `auth` (the per-request transport
  // context), never trusted from the caller.

  server.registerTool(
    "session_capture",
    {
      title: "Capture Session",
      description:
        "Ingest or refresh an agent work session from its TOML front matter. Upserts the session and its artifacts, re-embeds only when the embedded content changed, and stamps provenance/server-owned personal identity. Returns {id, session_id, status, created, reembedded, workspace_id, project_id, visibility} — `id` is the canonical key; write it and the stored scope back into fresh TOML to refresh the same session. String fields are not coerced, list fields contain only strings, and artifacts must use a [[artifacts]] array-of-tables with kind and title required and detail optional. See the 'Session TOML schema' resource for the full front-matter contract, including the personal-only sensitive workspace.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        // Not idempotent: a TOML without `id` inserts a fresh row every call,
        // and one with `id` bumps updated_at and delete-reinserts artifacts.
        // Matches capture_thought's hint so clients don't auto-retry.
        idempotentHint: false,
      },
      // Byte cap shared with the REST gateway via schemas.ts.
      inputSchema: sessionCaptureSchema,
    },
    async ({ toml_text }) => {
      try {
        // The parse → hash → fail-fast → conditional-embed pipeline and the
        // server-side provenance stamping live in services.ts, shared with
        // the REST gateway. Error messages are unchanged (the typed errors
        // it throws carry the exact pre-extraction text).
        const res = await captureSessionFromToml(
          pool,
          {
            tomlText: toml_text,
            auth,
          },
          deps,
        );
        return text(JSON.stringify({
          id: res.id,
          session_id: res.session_id,
          status: res.status,
          created: res.created,
          reembedded: res.reembedded,
          workspace_id: res.workspace_id,
          project_id: res.project_id,
          visibility: res.visibility,
        }));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "session_lookup",
    {
      title: "Look up Session",
      description:
        "Retrieve a stored session record by id or branch — this does NOT resume execution, it fetches the record. Returns the full record (resume_context, next_actions, blockers, artifacts, raw_toml), or null if no match. Structured fields are authoritative; raw_toml is the verbatim input from the last session_capture, may differ from current structured fields (for example, after session_update_status), and must not be used as a recapture template. On a branch tie the most-recently-updated session wins. Oversized MCP records identify omitted fields and the optional tailnet REST recovery path.",
      annotations: { readOnlyHint: true },
      inputSchema: sessionLookupSchema,
    },
    async ({ id, branch, scope }) => {
      try {
        if (id == null && !branch) {
          return err("Provide id or branch.");
        }
        const rec = await lookupSessionInScope(pool, {
          id,
          branch,
          scope,
          auth,
        });
        if (!rec) return text("null");
        const recovery = `Structured fields are authoritative. ` +
          `When tailnet REST is enabled, use GET ${
            scopedRestPath(`/api/v1/sessions/${rec.id}`, rec)
          } only when an omitted field is required.`;
        return mcpJsonRecord(rec, {
          reductions: [
            { field: "raw_toml", action: "omit" },
            { field: "summary", action: "omit" },
            { field: "artifacts", action: "omit" },
            { field: "related_sessions", action: "omit" },
            { field: "linked_issues", action: "omit" },
            { field: "tags", action: "omit" },
            { field: "blockers", action: "omit" },
            { field: "next_actions", action: "omit" },
            { field: "resume_context", action: "omit" },
            { field: "goal", action: "omit" },
          ],
          recovery,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "session_search",
    {
      title: "Search Sessions",
      description:
        "Semantic search over session title/goal/summary/resume_context with an optional minimum cosine-similarity threshold (default 0.5). Optional structured filters by status, repo_url, tag. A fitting response is the existing [{id, session_id, title, status, last_update, score}] array; a truncated response is {results, truncation}. Oversized MCP results retain complete rows and identify omitted session IDs.",
      annotations: { readOnlyHint: true },
      inputSchema: sessionSearchSchema,
    },
    async ({ query, limit, threshold, status, repo_url, tag, scope }) => {
      try {
        const rows = await searchSessionsByQuery(pool, {
          query,
          limit,
          threshold,
          status,
          repo_url,
          tag,
          scope,
          auth,
        }, deps);
        return mcpJsonCollection(rows, {
          fullPayload: (included) => included,
          id: (row) => row.id,
          recovery: `${followUpScope(scope)} ` +
            "Call session_lookup once per omitted ID, or rerun session_search with a smaller limit and narrower filters.",
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "session_list",
    {
      title: "List Sessions",
      description:
        "List sessions by structured filters (no embedding) — the 'show me everything awaiting_review' path. A fitting response is the existing array of lightweight rows; a truncated response is {results, truncation}. Rows are ordered by the chosen column, and oversized MCP results retain complete rows while identifying omitted session IDs.",
      annotations: { readOnlyHint: true },
      inputSchema: sessionListSchema,
    },
    async (opts) => {
      try {
        const rows = await listSessionsInScope(pool, { ...opts, auth });
        return mcpJsonCollection(rows, {
          fullPayload: (included) => included,
          id: (row) => row.id,
          recovery: `${followUpScope(opts.scope)} ` +
            "Call session_lookup once per omitted ID, or rerun session_list with a smaller limit and narrower filters.",
        });
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  server.registerTool(
    "session_update_status",
    {
      title: "Update Session Status",
      description:
        "Lightweight lifecycle flip (e.g. mark 'done' after a PR merges), usable from any surface with no repo checkout — updates the structured status in the canonical store and leaves historical raw_toml unchanged. Returns {id, status}.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: sessionUpdateStatusSchema,
    },
    async ({ id, status, scope }) => {
      try {
        const row = await updateSessionStatusInScope(pool, id, status, {
          scope,
          auth,
        });
        if (!row) return err(`No session found for id ${id}.`);
        return text(JSON.stringify(row));
      } catch (e) {
        return err((e as Error).message);
      }
    },
  );

  // Publish the session TOML schema (above) as an MCP
  // resource so agents can fetch the field contract instead of guessing it.
  // Static doc; same per-request server lifecycle as the tools.
  server.registerResource(
    "session-toml-schema",
    "schema://open-brain/session-toml",
    {
      title: "Session TOML schema",
      description:
        "Session TOML front-matter schema accepted by session_capture, including the [[artifacts]] block (kind/title/detail).",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: SESSION_TOML_SCHEMA_DOC,
      }],
    }),
  );

  return server;
}
