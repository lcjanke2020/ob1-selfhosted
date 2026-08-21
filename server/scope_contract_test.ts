import { assertEquals, assertThrows } from "@std/assert";
import { MAX_SCOPE_ID_CHARS, parseScopeId } from "./scope_contract.ts";

Deno.test("scope ids share one trimmed, nonempty, bounded parser", () => {
  assertEquals(parseScopeId("workspace_id", "  research  "), "research");
  assertEquals(
    parseScopeId("project_id", "x".repeat(MAX_SCOPE_ID_CHARS)),
    "x".repeat(MAX_SCOPE_ID_CHARS),
  );
  assertThrows(
    () => parseScopeId("workspace_id", "   "),
    Error,
    "workspace_id must not be empty",
  );
  assertThrows(
    () => parseScopeId("project_id", "x".repeat(MAX_SCOPE_ID_CHARS + 1)),
    Error,
    `project_id must be at most ${MAX_SCOPE_ID_CHARS} characters`,
  );
  assertThrows(
    () => parseScopeId("workspace_id", 42),
    Error,
    "workspace_id must be a string",
  );
});
