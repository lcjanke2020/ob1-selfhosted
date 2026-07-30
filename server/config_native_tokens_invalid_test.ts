// The native-token flag accepts an exact boolean spelling. A typo must fail
// startup instead of silently disabling the only intended authentication door.

import { assertEquals, assertStringIncludes } from "@std/assert";

const ENV_KEYS = [
  "DB_PASSWORD",
  "ENABLE_NATIVE_TOKENS",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "METADATA_FALLBACK_POLICY",
];

Deno.test("config.ts: invalid native-token flag fails startup", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("ENABLE_NATIVE_TOKENS", "yes");
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");

  try {
    let message = "";
    try {
      await import("./config.ts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertEquals(message.length > 0, true);
    assertStringIncludes(message, "ENABLE_NATIVE_TOKENS must be true or false");
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
