// Native tokens are a complete authentication door: a private deployment may
// boot with them enabled while the legacy static key and Auth0 are both absent.

import { assertEquals } from "@std/assert";

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

Deno.test("config.ts: native tokens can be the sole authentication mechanism", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("ENABLE_NATIVE_TOKENS", "true");
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.set("MCP_ACCESS_KEY_PRINCIPAL", "local-operator");
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");

  try {
    const config = await import("./config.ts");
    assertEquals(config.ENABLE_NATIVE_TOKENS, true);
    assertEquals(config.ENABLE_BRAIN_KEY, false);
    assertEquals(config.ENABLE_OAUTH, false);
    assertEquals(config.MCP_ACCESS_KEY_PRINCIPAL, "local-operator");
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
