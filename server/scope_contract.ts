// Pure wire/domain contract for memory spaces. This module intentionally has
// no config or database imports so Zod and TOML unit tests remain hermetic.

export const MEMORY_VISIBILITIES = [
  "personal",
  "project",
  "workspace",
] as const;

export const MAX_SCOPE_ID_CHARS = 128;

export function parseScopeId(field: string, raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const value = raw.trim();
  if (!value) throw new Error(`${field} must not be empty`);
  if (value.length > MAX_SCOPE_ID_CHARS) {
    throw new Error(
      `${field} must be at most ${MAX_SCOPE_ID_CHARS} characters`,
    );
  }
  return value;
}

export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export type ScopeInput = {
  workspace_id?: string;
  project_id?: string | null;
  visibility?: MemoryVisibility;
};

export type ResolvedReadScope = {
  workspaceId: string;
  projectId: string | null;
  visibilities: MemoryVisibility[];
  principal: string | null;
};

export type ResolvedWriteScope = ResolvedReadScope & {
  visibility: MemoryVisibility;
  ownerSubject: string | null;
};
