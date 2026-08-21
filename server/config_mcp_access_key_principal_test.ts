// A shared-key principal is meaningful only when that auth door exists. A
// stale binding on an OAuth-only deployment must fail boot instead of creating
// an ambiguous personal-memory identity.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

Deno.test(
  "config.ts: shared-key principal requires the shared-key door",
  withEnv(
    [],
    {
      DB_PASSWORD: "test-password",
      METADATA_FALLBACK_POLICY: "off",
      MCP_ACCESS_KEY_PRINCIPAL: "local-operator",
      AUTH0_ISSUER: "https://example.auth0.com/",
      AUTH0_JWKS_URI: "https://example.auth0.com/.well-known/jwks.json",
      AUTH0_AUDIENCE: "https://brain.example.test/mcp",
    },
    async () => {
      let message = "";
      try {
        await import("./config.ts");
      } catch (error) {
        message = (error as Error).message;
      }
      assertEquals(message.length > 0, true);
      assertStringIncludes(message, "MCP_ACCESS_KEY_PRINCIPAL");
      assertStringIncludes(message, "requires MCP_ACCESS_KEY");
    },
  ),
);
