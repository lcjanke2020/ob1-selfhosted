// Negative test for the "at least one auth door" guard in config.ts. With the
// static key, native tokens, and Auth0 all optional, a deployment that configures
// none of them would boot with no authentication at all —
// config.ts must refuse to start in that state.
//
// The positive cases are covered implicitly elsewhere: auth_brainkey_test.ts
// boots with MCP_ACCESS_KEY only (x-brain-key door), and auth_oauth_test.ts +
// auth_oauth_only_test.ts boot with AUTH0_* (OAuth door). This file covers the
// single negative case (one-throw-per-file; see the min-length test header for
// why the import-throws-once contract forces a dedicated file).
//
// Run with: `deno task test` (or `deno test --allow-env --allow-net=127.0.0.1
// config_require_at_least_one_auth_test.ts`).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { withEnv } from "./api_test_support.ts";

Deno.test(
  "config.ts: throws when neither auth door is configured (no MCP_ACCESS_KEY, no AUTH0_*)",
  withEnv(
    [],
    {
      DB_PASSWORD: "test-password",
      OBS_AUTH_EVENTS_ENABLED: "false",
      METADATA_FALLBACK_POLICY: "off",
    },
    async () => {
      let threw = false;
      let message = "";
      try {
        await import("./config.ts");
      } catch (e) {
        threw = true;
        message = (e as Error).message;
      }
      assertEquals(
        threw,
        true,
        "config.ts must throw at module load when no auth door is configured",
      );
      assertStringIncludes(
        message,
        "MCP_ACCESS_KEY",
        "error must name the x-brain-key option",
      );
      assertStringIncludes(
        message,
        "ENABLE_NATIVE_TOKENS",
        "error must name the native-token option",
      );
      assertStringIncludes(
        message,
        "AUTH0_",
        "error must name the OAuth option",
      );
    },
  ),
);
