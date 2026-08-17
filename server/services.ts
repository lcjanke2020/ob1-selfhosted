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
import type { AuthContext } from "./auth_context.ts";
import type { ThoughtMatch, ThoughtRecord } from "./db.ts";
import { embed as defaultEmbed } from "./embeddings.ts";
export {
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "./errors.ts";
import {
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "./errors.ts";
import { extractMetadata as defaultExtractMetadata } from "./metadata.ts";
import type { MetadataExtractionResult } from "./metadata.ts";
import {
  type CaptureOutcome,
  captureThought,
  fetchThought,
  getStats,
  type ListOptions,
  listThoughts,
  moveThought,
  type MoveThoughtOutcome,
  probeThoughtUnchanged,
  searchThoughts,
  type Stats,
  type ThoughtMutationActor,
  updateThoughtContent,
  type UpdateThoughtOutcome,
} from "./queries.ts";
import {
  type MemoryScopeInput,
  memoryScopeSchema,
  type MoveThoughtTarget,
  moveThoughtTargetSchema,
  searchQuerySchema,
  similarityThresholdSchema,
  THOUGHT_PROVENANCE_SCHEMA_VERSION,
  thoughtIdSchema,
  type ThoughtProvenanceClaims,
  thoughtProvenanceClaimsSchema,
  type ThoughtSearchFilter,
  thoughtSearchFilterSchema,
  updateThoughtShape,
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
import {
  resolveReadScope,
  resolveWriteScope,
  trustedPrincipal,
} from "./scope.ts";
import {
  computeContentHash,
  embedSource,
  normalizeSessionTimestamp,
  type ParsedSessionDoc,
  parseSessionToml,
} from "./session_toml.ts";

export type { AuthContext } from "./auth_context.ts";

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

function validateSimilarityThreshold(value: number | undefined): number {
  const parsed = similarityThresholdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      `threshold: ${
        parsed.error.issues.map((issue) => issue.message).join("; ")
      }`,
    );
  }
  return parsed.data;
}

function validateSessionTimestampBound(
  field: "since" | "until",
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeSessionTimestamp(value, field);
  } catch (error) {
    throw new ValidationError((error as Error).message);
  }
}

function validateSearchQuery(query: string): string {
  const parsed = searchQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function validateThoughtId(id: string): string {
  const parsed = thoughtIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ValidationError(
      `id: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

function validateUpdateContent(content: string): string {
  const parsed = updateThoughtShape.content.safeParse(content);
  if (!parsed.success) {
    throw new ValidationError(
      `content: ${
        parsed.error.issues.map((issue) => issue.message).join("; ")
      }`,
    );
  }
  return parsed.data;
}

function validateMoveTarget(target: MoveThoughtTarget): MoveThoughtTarget {
  const parsed = moveThoughtTargetSchema.safeParse(target);
  if (!parsed.success) {
    throw new ValidationError(
      `target: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

// The identity written on revision rows. `subject` is the trusted principal
// (what RLS compares personal rows against), so an OAuth caller's sub, the
// configured shared-key principal, or null — never a caller-asserted claim.
function mutationActor(auth: AuthContext): ThoughtMutationActor {
  return {
    subject: trustedPrincipal(auth),
    door: auth.door,
    tokenLabel: auth.tokenLabel,
  };
}

// Treat these keys as reserved even though metadata.ts's strict runtime schema
// already excludes them. This defense keeps injected test/custom extractors
// from impersonating server stamps or caller claims — on capture and again on
// update, where the fresh classifier output replaces the old.
const RESERVED_METADATA_KEYS = [
  "source",
  "door",
  "sub",
  "token_label",
  "provenance",
  "metadata_extraction",
] as const;

function classifiedMetadata(
  extraction: MetadataExtractionResult,
): Record<string, unknown> {
  const classified = { ...extraction.metadata };
  for (const reserved of RESERVED_METADATA_KEYS) {
    delete classified[reserved];
  }
  return classified;
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
  extractMetadata: (text: string) => Promise<MetadataExtractionResult>;
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
  const [embedding, extraction] = await Promise.all([
    embedOrUpstreamError(deps.embed, input.content),
    deps.extractMetadata(input.content),
  ]);
  const classified = classifiedMetadata(extraction);

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
    token_label: input.auth.tokenLabel,
    metadata_extraction: extraction.classifier,
  };
  const persisted = await captureThought(pool, {
    content: input.content,
    embedding,
    metadata,
    degradationEvents: extraction.degradation_events,
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
  const query = validateSearchQuery(opts.query);
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
  // MCP and REST validate at their transport boundaries, but preserve the
  // same pre-DB invariant for direct callers of this exported service seam.
  const thoughtId = validateThoughtId(id);
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  return await fetchThought(pool, thoughtId, scope);
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

// Replace a thought's content in place inside its CURRENT audience: a locked
// probe first (same visibility rule as fetch — an id outside the caller's
// scope is null — and identical content is a no-op decided under the head's
// row lock, so the returned head and history depth are one atomic state),
// then re-embed and re-classify exactly like a capture, then a single locked
// transaction that snapshots the prior state to thought_revisions and rewrites
// the head. Original capture stamps (source/door/sub/token_label/provenance)
// survive; classifier fields are replaced by the fresh extraction. Content
// never reaches the embedder or the classifier for a no-op or an invisible id.
export async function updateThoughtInScope(
  pool: Pool,
  input: {
    id: string;
    content: string;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
  deps: ServiceDeps = defaultDeps,
): Promise<UpdateThoughtOutcome | null> {
  const thoughtId = validateThoughtId(input.id);
  const content = validateUpdateContent(input.content);
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  // Invisible/unknown ids and identical content are decided HERE, under the
  // head's row lock, before content reaches the embedder or a possibly
  // off-box classifier. Changed content falls through; updateThoughtContent
  // re-locks and re-checks, so a concurrent edit in between is still safe
  // (its own locked no-op branch answers if the texts have converged).
  const probe = await probeThoughtUnchanged(pool, {
    id: thoughtId,
    content,
    scope,
  });
  if (probe.state === "invisible") return null;
  if (probe.state === "unchanged") return probe.outcome;
  const [embedding, extraction] = await Promise.all([
    embedOrUpstreamError(deps.embed, content),
    deps.extractMetadata(content),
  ]);
  return await updateThoughtContent(pool, {
    id: thoughtId,
    content,
    embedding,
    freshMetadata: {
      ...classifiedMetadata(extraction),
      metadata_extraction: extraction.classifier,
    },
    degradationEvents: extraction.degradation_events,
    actor: mutationActor(input.auth),
    scope,
  });
}

// Move a thought to another audience in place (same id, content, embedding,
// created_at). The CURRENT audience is addressed through `scope` like fetch;
// the destination is resolved with the same fail-closed rules as a capture —
// registered workspace/project, personal-only workspaces accept only personal,
// personal requires a trusted principal — and then the SECURITY DEFINER
// helper re-checks source visibility, validates the target again, snapshots
// the prior state, and stamps a personal owner from the transaction-local
// principal. Widening (personal → project/workspace) is allowed only because
// every target field is explicit; nothing about the destination is defaulted.
export async function moveThoughtInScope(
  pool: Pool,
  input: {
    id: string;
    target: MoveThoughtTarget;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
): Promise<MoveThoughtOutcome | null> {
  const thoughtId = validateThoughtId(input.id);
  const target = validateMoveTarget(input.target);
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(input.scope),
    input.auth,
  );
  const destination = await resolveWriteScope(
    pool,
    {
      workspace_id: target.workspace_id,
      project_id: target.project_id ?? null,
      visibility: target.visibility,
    },
    input.auth,
  );
  const outcome = await moveThought(pool, {
    id: thoughtId,
    target: {
      workspaceId: destination.workspaceId,
      projectId: destination.projectId,
      visibility: destination.visibility,
    },
    actor: mutationActor(input.auth),
    scope,
  });
  if (!outcome) return null;
  if (outcome.outcome === "conflict") {
    throw new ConflictError(
      `A thought with identical content already exists in the target audience (id: ${outcome.conflict_thought_id}).`,
    );
  }
  return outcome;
}

export async function searchSessionsByQuery(
  pool: Pool,
  opts: {
    query: string;
    limit?: number;
    threshold?: number;
    status?: string;
    repo_url?: string;
    tag?: string;
    scope?: MemoryScopeInput;
    auth: AuthContext;
  },
  deps: ServiceDeps = defaultDeps,
): Promise<SessionSearchRow[]> {
  // Transport handlers validate this shape too, but the exported service must
  // not let direct callers borrow a DB client or invoke the embedder with a
  // blank/oversized query.
  const query = validateSearchQuery(opts.query);
  const threshold = validateSimilarityThreshold(opts.threshold);
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(opts.scope),
    opts.auth,
  );
  const embedding = await embedOrUpstreamError(deps.embed, query);
  return await searchSessions(pool, {
    embedding,
    limit: opts.limit,
    threshold,
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
      // Store the server-verified credential label faithfully, mirroring how
      // capture_thought stamps thoughts.metadata.door. OAuth user surfaces
      // remain indistinguishable from each other and use `funnel`; OAuth
      // client-credentials identities use `service`; static keys and native
      // tokens use `tailnet`. These are auth/provenance labels, not Caddy
      // route evidence.
      source: input.auth.door,
      // OAuth stamps its verified subject. A native token has no identity
      // principal, but its server-verified label is still useful attribution.
      // The legacy static key has neither and remains null.
      sourceNode: input.auth.sub ?? input.auth.tokenLabel,
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
  const normalizedFilters = {
    ...filters,
    since: validateSessionTimestampBound("since", filters.since),
    until: validateSessionTimestampBound("until", filters.until),
  };
  const scope = await resolveReadScope(
    pool,
    validateMemoryScope(requested),
    auth,
  );
  return await listSessions(pool, normalizedFilters, scope);
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
