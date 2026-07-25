// Transport-agnostic orchestration shared by the MCP tools (mcp-server.ts)
// and the REST gateway (api.ts). Only flows that fan out beyond a single
// query live here — embed + extract + merge on thought capture, and the
// parse → hash → fail-fast → conditional-embed pipeline on session capture.
// Single-query operations don't need this layer: both transports call
// queries.ts / session_queries.ts directly.
//
// Ollama calls are injectable (ServiceDeps) so the api/services tests stay
// hermetic — no database, no network — with hand-rolled fakes, matching the
// rest of the suite.

import type { Pool } from "postgres";
import type { ThoughtMatch } from "./db.ts";
import { embed as defaultEmbed } from "./embeddings.ts";
import { extractMetadata as defaultExtractMetadata } from "./metadata.ts";
import { captureThought, searchThoughts } from "./queries.ts";
import {
  getSessionContentHash,
  searchSessions,
  type SessionSearchRow,
  type UpsertOutcome,
  upsertSession,
} from "./session_queries.ts";
import {
  computeContentHash,
  embedSource,
  type ParsedSessionDoc,
  parseSessionToml,
} from "./session_toml.ts";

// Same shape as auth.ts AppVariables / mcp-server.ts RequestAuth; declared
// standalone so this module depends on neither transport layer.
export type AuthContext = { door: "funnel" | "tailnet"; sub: string | null };

// Error taxonomy the REST layer maps to HTTP status codes (400/404/502 in
// api.ts onError). The MCP layer only reads .message, so wrapping preserves
// the exact tool-facing error text these paths produced before extraction.
export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class UpstreamError extends Error {}

export type ServiceDeps = {
  embed: (text: string) => Promise<number[]>;
  extractMetadata: (text: string) => Promise<Record<string, unknown>>;
};

export const defaultDeps: ServiceDeps = {
  embed: defaultEmbed,
  extractMetadata: defaultExtractMetadata,
};

// embed() is the one upstream (Ollama) dependency on the hot path — wrap its
// failures so REST can 502 while DB errors stay 500. extractMetadata never
// throws (metadata.ts degrades to the uncategorized stub).
async function embedOrUpstreamError(
  embedFn: ServiceDeps["embed"],
  text: string,
): Promise<number[]> {
  try {
    return await embedFn(text);
  } catch (e) {
    throw new UpstreamError((e as Error).message);
  }
}

export async function captureThoughtWithMetadata(
  pool: Pool,
  input: { content: string; auth: AuthContext; via: "mcp" | "rest" },
  deps: ServiceDeps = defaultDeps,
): Promise<{ id: string; metadata: Record<string, unknown> }> {
  const [embedding, extracted] = await Promise.all([
    embedOrUpstreamError(deps.embed, input.content),
    deps.extractMetadata(input.content),
  ]);
  // Stamp the door of origin (and JWT sub on the OAuth path) into the
  // persisted metadata so the source-attribution "mobile-originated writes"
  // dashboard tile can discriminate Funnel/mobile captures from tailnet
  // captures. `door` is populated unconditionally by `requireAuth` (and
  // validated by the transport-side guard before this code runs); `sub` is
  // the verified JWT `sub` claim on Funnel captures and null on tailnet
  // captures (shared x-brain-key has no per-user identity). `source` records
  // the transport ("mcp" | "rest"). JSONB column needs no schema change.
  const metadata: Record<string, unknown> = {
    ...extracted,
    source: input.via,
    door: input.auth.door,
    sub: input.auth.sub,
  };
  const { id } = await captureThought(pool, {
    content: input.content,
    embedding,
    metadata,
  });
  return { id, metadata };
}

export async function searchThoughtsByQuery(
  pool: Pool,
  opts: { query: string; limit?: number; threshold?: number },
  deps: ServiceDeps = defaultDeps,
): Promise<ThoughtMatch[]> {
  const embedding = await embedOrUpstreamError(deps.embed, opts.query);
  return await searchThoughts(pool, {
    query: opts.query,
    embedding,
    limit: opts.limit,
    threshold: opts.threshold,
  });
}

export async function searchSessionsByQuery(
  pool: Pool,
  opts: {
    query: string;
    limit?: number;
    status?: string;
    repo_url?: string;
    tag?: string;
  },
  deps: ServiceDeps = defaultDeps,
): Promise<SessionSearchRow[]> {
  const embedding = await embedOrUpstreamError(deps.embed, opts.query);
  return await searchSessions(pool, {
    embedding,
    limit: opts.limit,
    status: opts.status,
    repo_url: opts.repo_url,
    tag: opts.tag,
  });
}

export async function captureSessionFromToml(
  pool: Pool,
  input: { tomlText: string; auth: AuthContext },
  deps: ServiceDeps = defaultDeps,
): Promise<UpsertOutcome & { reembedded: boolean }> {
  let parsed: ParsedSessionDoc;
  try {
    parsed = parseSessionToml(input.tomlText);
  } catch (e) {
    throw new ValidationError((e as Error).message);
  }
  const { session, artifacts, rawToml } = parsed;
  const contentHash = await computeContentHash(session);
  // On the update path (id present), look the row up first so a stale or
  // unknown id errors HERE — before paying for an embedding. A fresh
  // capture (no id) has no existing hash, so it always (re)embeds.
  let existingHash: string | null = null;
  if (session.id != null) {
    const cur = await getSessionContentHash(pool, session.id);
    if (cur === null) {
      throw new NotFoundError(`No session found for id ${session.id}.`);
    }
    existingHash = cur.hash;
  }
  // equal hash => content unchanged, skip embed; otherwise (re)embed.
  const reembedded = existingHash !== contentHash;
  const embedding = reembedded
    ? await embedOrUpstreamError(deps.embed, embedSource(session))
    : null;
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
      source: input.auth.door,
      sourceNode: input.auth.sub,
    },
    rawToml,
  });
  return { ...res, reembedded };
}
