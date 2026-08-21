// The native-token flag accepts an exact boolean spelling. A typo must fail
// startup instead of silently disabling the only intended authentication door.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

Deno.test(
  "config.ts: invalid native-token flag fails startup",
  withEnv(
    [],
    {
      DB_PASSWORD: "test-password",
      METADATA_FALLBACK_POLICY: "off",
      ENABLE_NATIVE_TOKENS: "yes",
    },
    async () => {
      let message = "";
      try {
        await import("./config.ts");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertEquals(message.length > 0, true);
      assertStringIncludes(
        message,
        "ENABLE_NATIVE_TOKENS must be true or false",
      );
    },
  ),
);
