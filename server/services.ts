// Transport-agnostic orchestration shared by the MCP tools (mcp-server.ts)
// and the REST gateway (api.ts). Every operation passes through this layer so
// workspace/project/visibility is validated and resolved before a database
// transaction installs its fail-closed audience context. Multi-stage capture
// flows also coordinate embedding, extraction, hashing, and persistence here.
//
// Ollama calls are injectable (ServiceDeps) so the api/services tests stay
// hermetic — no database, no network — with hand-rolled fakes, matching the
// rest of the suite.

import type { Pool } from "postgres";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { embed as defaultEmbed } from "./embeddings.ts";
export { NotFoundError, UpstreamError, ValidationError } from "./errors.ts";
import { NotFoundError, UpstreamError, ValidationError } from "./errors.ts";
import { extractMetadata as defaultExtractMetadata } from "./metadata.ts";
import {
  type CaptureOutcome,
  captureThought,
  fetchThought,
  getStats,
  type ListOptions,
  listThoughts,
  searchThoughts,
  type Stats,
} from "./queries.ts";
import {
  type MemoryScopeInput,
  memoryScopeSchema,
  THOUGHT_PROVENANCE_SCHEMA_VERSION,
  type ThoughtProvenanceClaims,
  thoughtProvenanceClaimsSchema,
  type ThoughtSearchFilter,
  thoughtSearchFilterSchema,
  thoughtSearchQuerySchema,
} from "./schemas.ts";
import {
  getSession,
  getSessionContentHash,
  listSessions,
  resumeSession,
  searchSessions,
  type SessionListRow,
  type SessionRecord,
  type SessionSearchRow,
  updateSessionStatus,
  type UpsertOutcome,
  upsertSession,
} from "./session_queries.ts";
import { resolveReadScope, resolveWriteScope } from "./scope.ts";
import {
  computeContentHash,
  embedSource,
  type ParsedSessionDoc,
  parseSessionToml,
} from "./session_toml.ts";

// Same shape as auth.ts AppVariables / mcp-server.ts RequestAuth; declared
// standalone so this module depends on neither transport layer.
export type AuthContext = { door: "funnel" | "tailnet"; sub: string | null };

function validateThoughtProvenance(
  provenance: ThoughtProvenanceClaims | undefined,
): ThoughtProvenanceClaims | undefined {
  if (provenance === undefined) return undefined;
  const parsed = thoughtProvenanceClaimsSchema.safeParse(provenance);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function validateThoughtSearchFilter(
  filter: ThoughtSearchFilter | undefined,
): ThoughtSearchFilter | undefined {
  if (filter === undefined) return undefined;
  const parsed = thoughtSearchFilterSchema.safeParse(filter);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function validateThoughtSearchQuery(query: string): string {
  const parsed = thoughtSearchQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function validateMemoryScope(
  scope: MemoryScopeInput | undefined,
): MemoryScopeInput | undefined {
  if (scope === undefined) return undefined;
  const parsed = memoryScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

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
  input: {
    content: string;
    provenance?: ThoughtProvenanceClaims;
    scope?: MemoryScopeInput;
    auth: AuthContext;
    via: "mcp" | "rest";
  },
  deps: ServiceDeps = defaultDeps,
): Promise<CaptureOutcome> {
  // Transport handlers already validate this shape, but the shared service is
  // exported and can be called directly. Re-validate before any upstream work
  // so internal callers cannot persist an empty or otherwise invalid claims
  // envelope by bypassing the MCP/REST schemas.
  const provenance = validateThoughtProvenance(input.provenance);
  const scopeInput = validateMemoryScope(input.scope);
  // Unknown/misspelled registry targets and missing personal principals fail
  // before content reaches either the embedder or metadata extractor.
  const scope = await resolveWriteScope(pool, scopeInput, input.auth);
  const [embedding, extracted] = await Promise.all([
    embedOrUpstreamError(deps.embed, input.content),
    deps.extractMetadata(input.content),
  ]);
  // Treat these keys as reserved even though metadata.ts's strict runtime
  // schema already excludes them. This defense keeps injected test/custom
  // extractors from impersonating server stamps or caller claims.
  const classified = { ...extracted };
  for (const reserved of ["source", "door", "sub", "provenance"]) {
    delete classified[reserved];
  }

  // `provenance` is deliberately emitted only when the caller supplied at
  // least one validated claim. On a content-fingerprint conflict, queries.ts
  // performs a shallow JSONB merge: omitting this optional key therefore does
  // not erase claims from an earlier capture, while explicit new claims replace
  // the prior versioned object. The top-level compatibility keys remain the
  // server-verified transport identity used by existing consumers.
  const metadata: Record<string, unknown> = {
    ...classified,
    ...(provenance
      ? {
        provenance: {
          schema_version: THOUGHT_PROVENANCE_SCHEMA_VERSION,
          caller_asserted: provenance,
        },
      }
      : {}),
    source: input.via,
    door: input.auth.door,
    sub: input.auth.sub,
  };
  const persisted = await captureThought(pool, {
    content: input.content,
    embedding,
    metadata,
    scope,
  });
  // The upsert may preserve top-level keys omitted by this capture (notably
  // provenance on a duplicate). Return PostgreSQL's final merged row so REST
  // and MCP never report metadata that disagrees with durable state.
  return persisted;
}

export async function searchThoughtsByQuery(
  pool: Pool,
  opts: {
    query: string;
    limit?: number;
    threshold?: number;
    filter?: ThoughtSearchFilter;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
  deps: ServiceDeps = defaultDeps,
): Promise<ThoughtMatch[]> {
  // MCP and REST validate before this shared seam, but exported service calls
  // receive the same fail-fast contract and cannot trigger embedding work with
  // an oversized query or malformed filter.
  const query = validateThoughtSearchQuery(opts.query);
  const filter = validateThoughtSearchFilter(opts.filter);
  const scopeInput = validateMemoryScope(opts.scope);
  const scope = await resolveReadScope(pool, scopeInput, opts.auth);
  const embedding = await embedOrUpstreamError(deps.embed, query);
  return await searchThoughts(pool, {
    query,
    embedding,
    limit: opts.limit,
    threshold: opts.threshold,
    filter,
    scope,
  });
}

export async function listThoughtsInScope(
  pool: Pool,
  opts: ListOptions & {
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
): Promise<ThoughtRecord[]> {
  const { scope: requested, auth, ...filters } = opts;
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(requested),
    auth,
  );
  return await listThoughts(pool, filters, scope);
}

export async function fetchThoughtInScope(
  pool: Pool,
  id: string,
  input: { scope?: MemoryScopeInput; auth: AuthContext },
): Promise<ThoughtRecord | null> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  return await fetchThought(pool, id, scope);
}

export async function getThoughtStatsInScope(
  pool: Pool,
  input: { scope?: MemoryScopeInput; auth: AuthContext },
): Promise<Stats> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  return await getStats(pool, scope);
}

export async function searchSessionsByQuery(
  pool: Pool,
  opts: {
    query: string;
    limit?: number;
    status?: string;
    repo_url?: string;
    tag?: string;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
  deps: ServiceDeps = defaultDeps,
): Promise<SessionSearchRow[]> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(opts.scope),
    opts.auth,
  );
  const embedding = await embedOrUpstreamError(deps.embed, opts.query);
  return await searchSessions(pool, {
    embedding,
    limit: opts.limit,
    status: opts.status,
    repo_url: opts.repo_url,
    tag: opts.tag,
  }, scope);
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
  const scope = await resolveWriteScope(
    pool,
    {
      workspace_id: session.workspace_id ?? undefined,
      project_id: session.project_id,
      visibility: session.visibility ?? undefined,
    },
    input.auth,
  );
  const contentHash = await computeContentHash(session);
  // On the update path (id present), look the row up first so a stale or
  // unknown id errors HERE — before paying for an embedding. A fresh
  // capture (no id) has no existing hash, so it always (re)embeds.
  let existingHash: string | null = null;
  if (session.id != null) {
    const cur = await getSessionContentHash(pool, session.id, scope);
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
    scope,
  });
  return { ...res, reembedded };
}

export async function getSessionInScope(
  pool: Pool,
  id: number,
  input: { scope?: MemoryScopeInput; auth: AuthContext },
): Promise<SessionRecord | null> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  return await getSession(pool, id, scope);
}

export async function lookupSessionInScope(
  pool: Pool,
  opts: {
    id?: number | null;
    branch?: string | null;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
): Promise<SessionRecord | null> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(opts.scope),
    opts.auth,
  );
  return await resumeSession(pool, { id: opts.id, branch: opts.branch }, scope);
}

export async function listSessionsInScope(
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
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
): Promise<SessionListRow[]> {
  const { scope: requested, auth, ...filters } = opts;
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(requested),
    auth,
  );
  return await listSessions(pool, filters, scope);
}

export async function updateSessionStatusInScope(
  pool: Pool,
  id: number,
  status: string,
  input: { scope?: MemoryScopeInput; auth: AuthContext },
): Promise<{ id: number; status: string } | null> {
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  return await updateSessionStatus(pool, id, status, scope);
}
