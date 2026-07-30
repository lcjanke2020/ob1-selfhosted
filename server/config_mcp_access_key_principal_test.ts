// A shared-key principal is meaningful only when that auth door exists. A
// stale binding on an OAuth-only deployment must fail boot instead of creating
// an ambiguous personal-memory identity.

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

Deno.test("config.ts: shared-key principal requires the shared-key door", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.delete("ENABLE_NATIVE_TOKENS");
  Deno.env.set("MCP_ACCESS_KEY_PRINCIPAL", "local-operator");
  Deno.env.set("AUTH0_ISSUER", "https://example.auth0.com/");
  Deno.env.set(
    "AUTH0_JWKS_URI",
    "https://example.auth0.com/.well-known/jwks.json",
  );
  Deno.env.set("AUTH0_AUDIENCE", "https://brain.example.test/mcp");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");

  try {
    let message = "";
    try {
      await import("./config.ts");
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message.length > 0, true);
    assertStringIncludes(message, "MCP_ACCESS_KEY_PRINCIPAL");
    assertStringIncludes(message, "requires MCP_ACCESS_KEY");
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
