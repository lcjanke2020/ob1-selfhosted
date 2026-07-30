// Fail-closed request-scope resolution and pool-safe PostgreSQL context.
//
// Callers submit upstream-compatible workspace/project/visibility vocabulary.
// Registry lookup happens before expensive embedding/classification work. The
// resolved audience is then installed with transaction-local custom settings;
// RLS in db/06-spaces.sql reads those settings. A missing setting matches no
// rows, and COMMIT/ROLLBACK restores every setting before a pooled connection is
// released.

import type { Pool } from "postgres";
import type { AuthContext } from "./auth_context.ts";
import { DEFAULT_WORKSPACE_ID, MCP_ACCESS_KEY_PRINCIPAL } from "./config.ts";
import { getClient } from "./db_pool.ts";
import { ValidationError } from "./errors.ts";
import type {
  MemoryVisibility,
  ResolvedReadScope,
  ResolvedWriteScope,
  ScopeInput,
} from "./scope_contract.ts";
export {
  MEMORY_VISIBILITIES,
  type MemoryVisibility,
  type ResolvedReadScope,
  type ResolvedWriteScope,
  type ScopeInput,
} from "./scope_contract.ts";

export type AuthIdentity = AuthContext;

type WorkspaceRow = {
  default_visibility: MemoryVisibility;
  personal_only: boolean;
  project_exists: boolean;
};

export function trustedPrincipal(auth: AuthIdentity): string | null {
  if (auth.door !== "tailnet") return auth.sub;
  // The static key is shared and therefore is not an identity by itself. Only
  // explicit server configuration may bind that door to a stable principal.
  return MCP_ACCESS_KEY_PRINCIPAL || null;
}

async function lookupWorkspace(
  pool: Pool,
  workspaceId: string,
  projectId: string | null,
): Promise<WorkspaceRow> {
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<WorkspaceRow>(
      `SELECT w.default_visibility,
              w.personal_only,
              CASE
                WHEN $2::text IS NULL THEN true
                ELSE EXISTS (
                  SELECT 1
                  FROM memory_scope.project AS p
                  WHERE p.workspace_id = w.id AND p.id = $2
                )
              END AS project_exists
       FROM memory_scope.workspace AS w
       WHERE w.id = $1`,
      [workspaceId, projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ValidationError(`Unknown workspace_id "${workspaceId}".`);
    }
    if (!row.project_exists) {
      throw new ValidationError(
        `Unknown project_id "${projectId}" in workspace_id "${workspaceId}".`,
      );
    }
    return row;
  } finally {
    client.release();
  }
}

function requestedContext(input?: ScopeInput): {
  workspaceId: string;
  projectId: string | null;
} {
  return {
    workspaceId: input?.workspace_id ?? DEFAULT_WORKSPACE_ID,
    projectId: input?.project_id ?? null,
  };
}

export async function resolveReadScope(
  pool: Pool,
  input: ScopeInput | undefined,
  auth: AuthIdentity,
): Promise<ResolvedReadScope> {
  const { workspaceId, projectId } = requestedContext(input);
  const workspace = await lookupWorkspace(pool, workspaceId, projectId);
  const principal = trustedPrincipal(auth);
  const requestedVisibility = input?.visibility;

  if (requestedVisibility === "personal" && !principal) {
    throw new ValidationError(
      "personal visibility requires a server-verified or explicitly configured principal",
    );
  }
  if (requestedVisibility === "project" && !projectId) {
    throw new ValidationError(
      "project visibility requires project_id in the same scope",
    );
  }
  if (
    workspace.personal_only && requestedVisibility &&
    requestedVisibility !== "personal"
  ) {
    throw new ValidationError(
      `workspace_id "${workspaceId}" is personal-only; visibility must be personal`,
    );
  }

  let visibilities: MemoryVisibility[];
  if (requestedVisibility) {
    visibilities = [requestedVisibility];
  } else if (workspace.personal_only) {
    if (!principal) {
      throw new ValidationError(
        `workspace_id "${workspaceId}" is personal-only and requires a server-verified or explicitly configured principal`,
      );
    }
    visibilities = ["personal"];
  } else {
    visibilities = [
      ...(principal ? ["personal" as const] : []),
      ...(projectId ? ["project" as const] : []),
      "workspace",
    ];
  }

  return { workspaceId, projectId, visibilities, principal };
}

export async function resolveWriteScope(
  pool: Pool,
  input: ScopeInput | undefined,
  auth: AuthIdentity,
): Promise<ResolvedWriteScope> {
  const { workspaceId, projectId: requestedProjectId } = requestedContext(
    input,
  );
  const workspace = await lookupWorkspace(
    pool,
    workspaceId,
    requestedProjectId,
  );
  const principal = trustedPrincipal(auth);
  const visibility = input?.visibility ??
    (requestedProjectId ? "project" : workspace.default_visibility);

  if (workspace.personal_only && visibility !== "personal") {
    throw new ValidationError(
      `workspace_id "${workspaceId}" is personal-only; visibility must be personal`,
    );
  }
  if (visibility === "project" && !requestedProjectId) {
    throw new ValidationError(
      "project visibility requires project_id in the same scope",
    );
  }
  if (visibility === "personal" && !principal) {
    throw new ValidationError(
      "personal visibility requires a server-verified or explicitly configured principal",
    );
  }

  // Personal and workspace audiences span the whole workspace. Canonicalizing
  // their project to NULL makes both RLS and fingerprint uniqueness express
  // the real audience rather than an incidental capture context.
  const projectId = visibility === "project" ? requestedProjectId : null;
  return {
    workspaceId,
    projectId,
    visibility,
    visibilities: [visibility],
    principal,
    ownerSubject: visibility === "personal" ? principal : null,
  };
}
