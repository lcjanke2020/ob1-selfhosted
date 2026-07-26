// Pure wire/domain contract for memory spaces. This module intentionally has
// no config or database imports so Zod and TOML unit tests remain hermetic.

export const MEMORY_VISIBILITIES = [
  "personal",
  "project",
  "workspace",
] as const;

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
