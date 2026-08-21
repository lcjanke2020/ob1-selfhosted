// Native tokens are a complete authentication door: a private deployment may
// boot with them enabled while the legacy static key and Auth0 are both absent.

import { assertEquals } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

Deno.test(
  "config.ts: native tokens can be the sole authentication mechanism",
  withEnv(
    [],
    {
      DB_PASSWORD: "test-password",
      METADATA_FALLBACK_POLICY: "off",
      ENABLE_NATIVE_TOKENS: "true",
      MCP_ACCESS_KEY_PRINCIPAL: "local-operator",
    },
    async () => {
      const config = await import("./config.ts");
      assertEquals(config.ENABLE_NATIVE_TOKENS, true);
      assertEquals(config.ENABLE_BRAIN_KEY, false);
      assertEquals(config.ENABLE_OAUTH, false);
      assertEquals(config.MCP_ACCESS_KEY_PRINCIPAL, "local-operator");
    },
  ),
);
