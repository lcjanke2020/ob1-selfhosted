// Fresh-process integration coverage for the full server's shared runtime
// parsers. Pure parser defaults live in runtime_config_test.ts; these cases pin
// config.ts wiring without importing its unrelated required settings in-process.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runConfigSubprocess } from "./api_test_support.ts";

const SCRIPT = `
  const c = await import("./config.ts");
  console.log(JSON.stringify({
    dbPort: c.DB_PORT,
    bodyReadTimeoutMs: c.AUTH_BODY_READ_TIMEOUT_MS,
    restEnabled: c.ENABLE_REST_API,
  }));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  METADATA_FALLBACK_POLICY: "off",
  OBS_AUTH_EVENTS_ENABLED: "false",
};

const runConfig = (overrides: Record<string, string> = {}) =>
  runConfigSubprocess(SCRIPT, BASE_ENV, overrides);

Deno.test("full config retains DB/auth defaults and strict REST boolean parsing", async () => {
  const defaults = await runConfig();
  assertEquals(defaults.code, 0, defaults.stderr);
  assertEquals(JSON.parse(defaults.stdout), {
    dbPort: 5432,
    bodyReadTimeoutMs: 2000,
    restEnabled: false,
  });

  const configured = await runConfig({
    DB_PORT: "6543",
    AUTH_BODY_READ_TIMEOUT_MS: "2500",
    ENABLE_REST_API: "true",
  });
  assertEquals(configured.code, 0, configured.stderr);
  assertEquals(JSON.parse(configured.stdout), {
    dbPort: 6543,
    bodyReadTimeoutMs: 2500,
    restEnabled: true,
  });
});

Deno.test("full config rejects malformed shared runtime settings", async (t) => {
  for (
    const [name, value] of [
      ["DB_PORT", "5432abc"],
      ["DB_PORT", "65536"],
      ["AUTH_BODY_READ_TIMEOUT_MS", "2s"],
      ["ENABLE_REST_API", "enabled"],
    ] as const
  ) {
    await t.step(`${name}=${value}`, async () => {
      const result = await runConfig({ [name]: value });
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr, name);
    });
  }
});
