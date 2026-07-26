// Hermetic scope-resolution tests. Registry rows are scripted in memory; no
// PostgreSQL or embedding endpoint is contacted.

import { assertEquals, assertRejects } from "@std/assert";
import { asPool, FakePool, makeDeps } from "./api_test_support.ts";

Deno.env.set("DB_PASSWORD", "test-password");
Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");

const {
  captureThoughtWithMetadata,
  ValidationError,
} = await import("./services.ts");
const { resolveReadScope, resolveWriteScope } = await import("./scope.ts");

const OAUTH_ALICE = { door: "funnel" as const, sub: "auth0|alice" };
const SHARED_KEY = { door: "tailnet" as const, sub: null };

function registryPool() {
  return new FakePool((sql, params) => {
    if (!sql.includes("FROM memory_scope.workspace AS w")) return undefined;
    const workspaceId = params[0];
    const projectId = params[1];
    if (workspaceId === "sensitive") {
      return {
        rows: [{
          default_visibility: "personal",
          personal_only: true,
          project_exists: projectId == null,
        }],
      };
    }
    if (workspaceId === "default") {
      return {
        rows: [{
          default_visibility: "workspace",
          personal_only: false,
          project_exists: projectId == null || projectId === "alpha",
        }],
      };
    }
    return { rows: [] };
  });
}

Deno.test("scope resolution is fail-closed and sensitive defaults personal", async () => {
  const pool = registryPool();

  assertEquals(
    await resolveWriteScope(
      asPool(pool),
      { workspace_id: "sensitive" },
      OAUTH_ALICE,
    ),
    {
      workspaceId: "sensitive",
      projectId: null,
      visibility: "personal",
      visibilities: ["personal"],
      principal: "auth0|alice",
      ownerSubject: "auth0|alice",
    },
  );

  await assertRejects(
    () =>
      resolveWriteScope(
        asPool(pool),
        { workspace_id: "sensitive", visibility: "workspace" },
        OAUTH_ALICE,
      ),
    ValidationError,
    "personal-only",
  );
  await assertRejects(
    () =>
      resolveWriteScope(
        asPool(pool),
        { workspace_id: "sensitive" },
        SHARED_KEY,
      ),
    ValidationError,
    "requires a server-verified or explicitly configured principal",
  );

  assertEquals(
    await resolveWriteScope(
      asPool(pool),
      { project_id: "alpha" },
      OAUTH_ALICE,
    ),
    {
      workspaceId: "default",
      projectId: "alpha",
      visibility: "project",
      visibilities: ["project"],
      principal: "auth0|alice",
      ownerSubject: null,
    },
  );
  assertEquals(
    await resolveReadScope(
      asPool(pool),
      { project_id: "alpha" },
      OAUTH_ALICE,
    ),
    {
      workspaceId: "default",
      projectId: "alpha",
      visibilities: ["personal", "project", "workspace"],
      principal: "auth0|alice",
    },
  );

  await assertRejects(
    () =>
      resolveReadScope(
        asPool(pool),
        { workspace_id: "misspelled" },
        OAUTH_ALICE,
      ),
    ValidationError,
    'Unknown workspace_id "misspelled"',
  );
  await assertRejects(
    () =>
      resolveReadScope(
        asPool(pool),
        { project_id: "misspelled" },
        OAUTH_ALICE,
      ),
    ValidationError,
    'Unknown project_id "misspelled"',
  );
});

Deno.test("bad scope fails before thought content reaches upstreams", async () => {
  const pool = registryPool();
  const deps = makeDeps();

  await assertRejects(
    () =>
      captureThoughtWithMetadata(
        asPool(pool),
        {
          content: "particularly sensitive content",
          scope: { workspace_id: "misspelled" },
          auth: OAUTH_ALICE,
          via: "mcp",
        },
        deps,
      ),
    ValidationError,
    "Unknown workspace_id",
  );
  assertEquals(deps.embedCalls, []);
  assertEquals(deps.extractCalls, []);

  await assertRejects(
    () =>
      captureThoughtWithMetadata(
        asPool(pool),
        {
          content: "particularly sensitive content",
          scope: { workpace_id: "sensitive" } as never,
          auth: OAUTH_ALICE,
          via: "mcp",
        },
        deps,
      ),
    ValidationError,
    "Unrecognized key",
  );
  assertEquals(deps.embedCalls, []);
  assertEquals(deps.extractCalls, []);
});
