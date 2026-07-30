// Positive regression for the single-user local deployment: a shared key is
// not identity by itself, but the operator may bind that whole door to one
// stable server-owned principal so the seeded sensitive workspace is usable.

import { assertEquals } from "jsr:@std/assert@1";
import { asPool, FakePool } from "./api_test_support.ts";

Deno.env.set("DB_PASSWORD", "test-password");
Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
Deno.env.set("MCP_ACCESS_KEY_PRINCIPAL", "local-owner");
Deno.env.delete("AUTH0_ISSUER");
Deno.env.delete("AUTH0_JWKS_URI");
Deno.env.delete("AUTH0_AUDIENCE");
Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
Deno.env.set("METADATA_FALLBACK_POLICY", "off");

Deno.test("configured shared-key principal owns sensitive personal scope", async () => {
  const { resolveReadScope, resolveWriteScope, trustedPrincipal } =
    await import(
      "./scope.ts"
    );
  const pool = asPool(
    new FakePool((sql) =>
      sql.includes("FROM memory_scope.workspace")
        ? {
          rows: [{
            default_visibility: "personal",
            personal_only: true,
            project_exists: true,
          }],
        }
        : undefined
    ),
  );
  const auth = { door: "tailnet" as const, sub: null, tokenLabel: null };

  assertEquals(trustedPrincipal(auth), "local-owner");
  assertEquals(
    await resolveWriteScope(pool, { workspace_id: "sensitive" }, auth),
    {
      workspaceId: "sensitive",
      projectId: null,
      visibility: "personal",
      visibilities: ["personal"],
      principal: "local-owner",
      ownerSubject: "local-owner",
    },
  );
  assertEquals(
    await resolveReadScope(pool, { workspace_id: "sensitive" }, auth),
    {
      workspaceId: "sensitive",
      projectId: null,
      visibilities: ["personal"],
      principal: "local-owner",
    },
  );
});
