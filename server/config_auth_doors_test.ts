// Fresh-process tests for authentication-door configuration. config.ts reads
// every setting at module load, so each behavior uses the shared subprocess
// fixture instead of requiring a dedicated worker file.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runConfigSubprocess } from "./api_test_support.ts";

const SCRIPT = `
  const config = await import("./config.ts");
  console.log(JSON.stringify({
    enableNativeTokens: config.ENABLE_NATIVE_TOKENS,
    enableBrainKey: config.ENABLE_BRAIN_KEY,
    enableOauth: config.ENABLE_OAUTH,
    principal: config.MCP_ACCESS_KEY_PRINCIPAL,
  }));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  MCP_ACCESS_KEY: "",
  MCP_ACCESS_KEY_PRINCIPAL: "",
  ENABLE_NATIVE_TOKENS: "",
  AUTH0_ISSUER: "",
  AUTH0_JWKS_URI: "",
  AUTH0_AUDIENCE: "",
};

const runConfig = (overrides: Record<string, string> = {}) =>
  runConfigSubprocess(SCRIPT, BASE_ENV, overrides);

Deno.test("auth config accepts native tokens as the sole door", async () => {
  const result = await runConfig({
    ENABLE_NATIVE_TOKENS: "true",
    MCP_ACCESS_KEY_PRINCIPAL: "local-operator",
  });
  assertEquals(result.code, 0, result.stderr);
  assertEquals(JSON.parse(result.stdout), {
    enableNativeTokens: true,
    enableBrainKey: false,
    enableOauth: false,
    principal: "local-operator",
  });
});

Deno.test("auth config rejects a deployment with no enabled door", async () => {
  const result = await runConfig();
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "MCP_ACCESS_KEY");
  assertStringIncludes(result.stderr, "ENABLE_NATIVE_TOKENS");
  assertStringIncludes(result.stderr, "AUTH0_");
});

Deno.test("shared-key config rejects keys shorter than 32 characters", async () => {
  const result = await runConfig({ MCP_ACCESS_KEY: "password" });
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "MCP_ACCESS_KEY");
  assertStringIncludes(result.stderr, "32");
  assertStringIncludes(result.stderr, "openssl rand -hex 32");
});

Deno.test("native-token config rejects an inexact boolean flag", async () => {
  const result = await runConfig({ ENABLE_NATIVE_TOKENS: "yes" });
  assertEquals(result.code, 1);
  assertStringIncludes(
    result.stderr,
    "ENABLE_NATIVE_TOKENS must be true or false",
  );
});

Deno.test("shared-key principal config requires the shared-key door", async () => {
  const result = await runConfig({
    MCP_ACCESS_KEY_PRINCIPAL: "local-operator",
    AUTH0_ISSUER: "https://example.auth0.com/",
    AUTH0_JWKS_URI: "https://example.auth0.com/.well-known/jwks.json",
    AUTH0_AUDIENCE: "https://brain.example.test/mcp",
  });
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "MCP_ACCESS_KEY_PRINCIPAL");
  assertStringIncludes(result.stderr, "requires MCP_ACCESS_KEY");
});
