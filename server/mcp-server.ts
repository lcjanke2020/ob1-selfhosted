// MCP server factory. A fresh `McpServer` is built per HTTP request — the
// @modelcontextprotocol/sdk McpServer mutates its internal transport
// reference on connect(), so sharing one instance across concurrent
// requests races (see matthallett1's review of upstream OB1 PR #143,
// finding #4: "module-scoped McpServer with per-request reconnection").

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CITATION_BASE_URL } from "./config.ts";
import { pool } from "./db.ts";
import { embed } from "./embeddings.ts";
import { extractMetadata } from "./metadata.ts";
import {
  captureThought,
  fetchThought,
  getStats,
  listThoughts,
  searchThoughts,
} from "./queries.ts";
import {
  getSessionContentHash,
  listSessions,
  resumeSession,
  searchSessions,
  updateSessionStatus,
  upsertSession,
} from "./session_queries.ts";
import {
  computeContentHash,
  embedSource,
  parseSessionToml,
  SESSION_ORDER_BY,
  SESSION_STATUSES,
} from "./session_toml.ts";

// Module-level shared TextEncoder so the byte-cap refine doesn't
// allocate a fresh instance on every capture_thought call.
const UTF8_ENCODER = new TextEncoder();

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

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
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

## Optional arrays
- \`tags\`, \`linked_issues\`, \`related_sessions\`, \`next_actions\`, \`blockers\`

## Optional prose (use TOML multiline """…""")
- \`summary\`, \`resume_context\`

## Artifacts — \`[[artifacts]]\` (plural) array-of-tables
Each entry:
- \`kind\` (string, required) — e.g. pr | code | doc | note
- \`title\` (string, required)
- \`detail\` (string, optional)

A singular \`[[artifact]]\` block, or any other field name inside an entry, is
**rejected** (it used to be silently dropped).

## Server-stamped — do NOT author by hand
\`source\`, \`source_node\`, \`content_hash\`, \`created_at\`, \`updated_at\` are set
server-side and ignored if present.

## Example
\`\`\`toml
+++
title = "Fix flaky CI"
status = "awaiting_review"
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

export function createMcpServer(auth: RequestAuth): McpServer {
  const server = new McpServer({
    name: "open-brain-homelab",
    // Bump on behavior changes — this is the serverInfo version a client
    // sees on initialize. 1.2.0: breaking session-tool contract change
    // (session_resume → session_lookup; tools key on integer `id`).
    // 1.3.0: retired the file/Syncthing model — session_update_status returns
    // {id, status} (dropped needs_file_sync), and ingested_path/needs_file_sync
    // are gone from the TOML schema resource.
    version: "1.3.0",
  });

  // ChatGPT-compatible search/fetch shapes (read-only). The standard names
  // `search` and `fetch` are what restricted-connector surfaces look for.
  server.registerTool(
    "search",
    {
      title: "Search Open Brain",
      description:
        "Search Open Brain memories by meaning. Read-only compatibility tool for ChatGPT-style search/fetch consumers.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe(
          "The search query to run against Open Brain",
        ),
      },
    },
    async ({ query }) => {
      try {
        const embedding = await embed(query);
        const rows = await searchThoughts(pool, { query, embedding });
        const results = rows.map((t) => ({
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));
        return text(JSON.stringify({ results }));
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
        "Fetch one Open Brain thought by ID after using search. Read-only compatibility tool.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().describe("The thought ID returned by search"),
      },
    },
    async ({ id }) => {
      try {
        const t = await fetchThought(pool, id);
        if (!t) return err(`No thought found for ID ${id}.`);
        const document = {
          id: t.id,
          title: thoughtTitle(t.content, t.created_at),
          text: t.content,
          url: thoughtUrl(t.id),
          metadata: {
            ...t.metadata,
            created_at: t.created_at,
            updated_at: t.updated_at,
          },
        };
        return text(JSON.stringify(document));
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
        "Search captured thoughts by meaning. Use when the user asks about a topic, person, or idea they've previously captured.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("What to search for"),
        limit: z.number().int().min(1).max(100).optional().default(10),
        threshold: z.number().min(0).max(1).optional().default(0.5),
      },
    },
    async ({ query, limit, threshold }) => {
      try {
        const embedding = await embed(query);
        const rows = await searchThoughts(pool, {
          query,
          embedding,
          limit,
          threshold,
        });
        if (!rows.length) return text(`No thoughts found matching "${query}".`);
        const lines = rows.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${
              (t.similarity * 100).toFixed(1)
            }% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type ?? "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length) {
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          }
          if (Array.isArray(m.people) && m.people.length) {
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          }
          if (Array.isArray(m.action_items) && m.action_items.length) {
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          }
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });
        return text(
          `Found ${rows.length} thought(s):\n\n${lines.join("\n\n")}`,
        );
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
        "List recently captured thoughts with optional filters by type, topic, person, or time range.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(10),
        type: z.string().optional()
          .describe(
            "Filter by type: observation, task, idea, reference, person_note",
          ),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().int().min(1).max(3650).optional()
          .describe("Only thoughts from the last N days"),
      },
    },
    async (opts) => {
      try {
        const rows = await listThoughts(pool, opts);
        if (!rows.length) return text("No thoughts found.");
        const lines = rows.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics)
            ? (m.topics as string[]).join(", ")
            : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${
            m.type ?? "??"
          }${tags ? " - " + tags : ""})\n   ${t.content}`;
        });
        return text(
          `${rows.length} recent thought(s):\n\n${lines.join("\n\n")}`,
        );
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
        "Summary of all captured thoughts: totals, types, top topics, people.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const s = await getStats(pool);
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
        "Save a new thought. Generates an embedding via Ollama and (if configured) extracts metadata.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        // Hard cap on captured content at 100 000 UTF-8 bytes
        // (≈97.7 KiB; round-decimal limit, not a binary KiB). Downstream
        // paths fan out through metadata.ts (full content sent to a paid
        // CHAT_API_BASE /chat/completions endpoint) and queries.ts (full
        // content INSERTed into postgres), so an authenticated client
        // without a size bound can rack up token costs or chew through
        // disk. The cost is byte-driven (tokens, storage, request body),
        // so the strict bound is measured in UTF-8 bytes, not JS UTF-16
        // code units.
        //
        // `.max(100_000)` runs first as a fast-path pre-check. Zod's
        // `.max` on a string measures
        // UTF-16 code units (JS string length); UTF-8 encoding takes
        // ≥ 1 byte per UTF-16 code unit (the smallest UTF-8 encoding
        // of a BMP codepoint is 1 byte, and codepoints outside the BMP
        // take 2 code units AND 4 UTF-8 bytes, so the inequality still
        // holds). Therefore any string with code-unit length above the
        // byte budget is guaranteed to exceed the byte budget too —
        // sound cheap rejection of adversarial multi-MB inputs without
        // allocating ~4× the input as a UTF-8 buffer. The `.refine`
        // then enforces the byte-accurate bound for inputs that pass
        // the code-unit pre-check (which would otherwise slip ~4×
        // over budget for pure-non-ASCII content under just `.max`).
        content: z
          .string()
          .min(1)
          .max(100_000)
          .refine(
            (s) => UTF8_ENCODER.encode(s).length <= 100_000,
            { message: "content must be at most 100000 UTF-8 bytes" },
          )
          .describe("The thought to capture"),
      },
    },
    async ({ content }) => {
      try {
        const [embedding, metadata] = await Promise.all([
          embed(content),
          extractMetadata(content),
        ]);
        // Stamp the door of origin (and JWT sub on the OAuth
        // path) into the persisted metadata so the source-attribution
        // "mobile-originated writes" dashboard tile can discriminate
        // Funnel/mobile captures from tailnet captures. `door` is
        // populated unconditionally by `requireAuth` (and validated by
        // the index.ts authContextOr500 guard before this code runs);
        // `sub` is the verified JWT `sub` claim on Funnel captures and
        // null on tailnet captures (shared x-brain-key has no per-user
        // identity). JSONB column needs no schema change.
        const meta: Record<string, unknown> = {
          ...metadata,
          source: "mcp",
          door: auth.door,
          sub: auth.sub,
        };
        const { id } = await captureThought(pool, {
          content,
          embedding,
          metadata: meta,
        });

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
        "Ingest or refresh an agent work session from its TOML front matter. Upserts the session and its artifacts, re-embeds only when the embedded content changed, and stamps provenance server-side. Returns {id, session_id, status, created, reembedded} — `id` is the canonical key; write it back into the TOML to refresh the same session. Artifacts go in a [[artifacts]] array-of-tables: kind and title required, detail optional; unknown fields or a singular [[artifact]] block are rejected. See the 'Session TOML schema' resource for the full front-matter contract.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        // Not idempotent: a TOML without `id` inserts a fresh row every call,
        // and one with `id` bumps updated_at and delete-reinserts artifacts.
        // Matches capture_thought's hint so clients don't auto-retry.
        idempotentHint: false,
      },
      inputSchema: {
        // Same UTF-8 byte cap as capture_thought: the full doc is
        // embedded and stored, so bound it in bytes, not UTF-16 code units.
        toml_text: z
          .string()
          .min(1)
          .max(100_000)
          .refine(
            (s) => UTF8_ENCODER.encode(s).length <= 100_000,
            { message: "toml_text must be at most 100000 UTF-8 bytes" },
          )
          .describe(
            "The session's TOML front matter (optionally inside a +++ fence)",
          ),
      },
    },
    async ({ toml_text }) => {
      try {
        const { session, artifacts, rawToml } = parseSessionToml(toml_text);
        const contentHash = await computeContentHash(session);
        // On the update path (id present), look the row up first so a stale or
        // unknown id errors HERE — before paying for an embedding. A fresh
        // capture (no id) has no existing hash, so it always (re)embeds.
        let existingHash: string | null = null;
        if (session.id != null) {
          const cur = await getSessionContentHash(pool, session.id);
          if (cur === null) return err(`No session found for id ${session.id}.`);
          existingHash = cur.hash;
        }
        // equal hash => content unchanged, skip embed; otherwise (re)embed.
        const reembedded = existingHash !== contentHash;
        const embedding = reembedded ? await embed(embedSource(session)) : null;
        const res = await upsertSession(pool, {
          session,
          artifacts,
          contentHash,
          embedding,
          provenance: {
            // Store the transport door faithfully ('funnel' | 'tailnet'),
            // mirroring how capture_thought stamps thoughts.metadata.door. The
            // funnel door carries every Anthropic surface (web/desktop/mobile),
            // indistinguishable server-side (requests arrive from Anthropic
            // egress, not the device), so 'funnel' is the honest label — not
            // 'mobile'.
            source: auth.door,
            sourceNode: auth.sub,
          },
          rawToml,
        });
        return text(JSON.stringify({
          id: res.id,
          session_id: res.session_id,
          status: res.status,
          created: res.created,
          reembedded,
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
        "Retrieve a stored session record by id or branch — this does NOT resume execution, it fetches the record. Returns the full record (resume_context, next_actions, blockers, artifacts, raw_toml), or null if no match. On a branch tie the most-recently-updated session wins.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.number().int().positive().optional()
          .describe("Session id (the canonical key returned by session_capture)"),
        branch: z.string().optional().describe(
          "Git branch; the newest matching session is returned",
        ),
      },
    },
    async ({ id, branch }) => {
      try {
        if (id == null && !branch) {
          return err("Provide id or branch.");
        }
        const rec = await resumeSession(pool, { id, branch });
        return text(JSON.stringify(rec));
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
        "Semantic search over session title/goal/summary/resume_context. Optional structured filters by status, repo_url, tag. Returns [{id, session_id, title, status, last_update, score}].",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("What to search for"),
        limit: z.number().int().min(1).max(50).optional().default(5),
        status: z.enum(SESSION_STATUSES).optional(),
        repo_url: z.string().optional(),
        tag: z.string().optional().describe("Match a single tag"),
      },
    },
    async ({ query, limit, status, repo_url, tag }) => {
      try {
        const embedding = await embed(query);
        const rows = await searchSessions(pool, {
          embedding,
          limit,
          status,
          repo_url,
          tag,
        });
        return text(JSON.stringify(rows));
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
        "List sessions by structured filters (no embedding) — the 'show me everything awaiting_review' path. Returns lightweight rows ordered by the chosen column.",
      annotations: { readOnlyHint: true },
      inputSchema: {
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
      },
    },
    async (opts) => {
      try {
        const rows = await listSessions(pool, opts);
        return text(JSON.stringify(rows));
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
        "Lightweight lifecycle flip (e.g. mark 'done' after a PR merges), usable from any surface with no repo checkout — writes straight to the canonical store. Returns {id, status}.",
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        id: z.number().int().positive()
          .describe("Session id (the canonical key returned by session_capture)"),
        status: z.enum(SESSION_STATUSES),
      },
    },
    async ({ id, status }) => {
      try {
        const row = await updateSessionStatus(pool, id, status);
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
