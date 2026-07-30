// Subprocess tests for notification config's fail-fast contract. Each case
// gets a fresh config.ts module instance and no real network access.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = `
  const c = await import("./config.ts");
  console.log(JSON.stringify({
    channels: c.METADATA_NOTIFY_CHANNELS,
    label: c.METADATA_NOTIFY_LABEL,
    enabled: c.ENABLE_METADATA_NOTIFICATIONS,
    ntfyUrl: c.METADATA_NTFY_SERVER_URL,
    pollMs: c.METADATA_NOTIFY_POLL_INTERVAL_MS,
    rollupMs: c.METADATA_NOTIFY_ROLLUP_MS,
    timeoutMs: c.METADATA_NOTIFY_TIMEOUT_MS,
  }));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  MCP_ACCESS_KEY_PRINCIPAL: "",
  AUTH0_ISSUER: "",
  AUTH0_JWKS_URI: "",
  AUTH0_AUDIENCE: "",
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_NOTIFY_CHANNELS: "",
  METADATA_NOTIFY_LABEL: "",
  METADATA_NOTIFY_POLL_INTERVAL_MS: "",
  METADATA_NOTIFY_ROLLUP_MS: "",
  METADATA_NOTIFY_TIMEOUT_MS: "",
  METADATA_PUSHOVER_APP_TOKEN: "",
  METADATA_PUSHOVER_USER_KEY: "",
  METADATA_NTFY_SERVER_URL: "",
  METADATA_NTFY_TOPIC: "",
  METADATA_NTFY_TOKEN: "",
};

async function runConfig(overrides: Record<string, string>) {
  const command = new Deno.Command("deno", {
    args: ["eval", SCRIPT],
    cwd: import.meta.dirname!,
    env: { ...BASE_ENV, ...overrides },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

Deno.test("metadata notification config: disabled default and valid dual-channel config", async (t) => {
  await t.step("empty channel list keeps delivery disabled", async () => {
    const result = await runConfig({});
    assertEquals(result.code, 0, result.stderr);
    assertEquals(JSON.parse(result.stdout), {
      channels: [],
      label: "OpenBrain",
      enabled: false,
      ntfyUrl: "https://ntfy.sh",
      pollMs: 300_000,
      rollupMs: 1_800_000,
      timeoutMs: 10_000,
    });
  });

  await t.step(
    "both adapters load only with their complete config",
    async () => {
      const result = await runConfig({
        METADATA_NOTIFY_CHANNELS: "pushover,ntfy",
        METADATA_NOTIFY_LABEL: "Private memory",
        METADATA_PUSHOVER_APP_TOKEN: "app-token",
        METADATA_PUSHOVER_USER_KEY: "user-key",
        METADATA_NTFY_SERVER_URL: "https://notify.example/base",
        METADATA_NTFY_TOPIC: "unguessable-topic",
        METADATA_NTFY_TOKEN: "ntfy-token",
        METADATA_NOTIFY_POLL_INTERVAL_MS: "2147483647",
      });
      assertEquals(result.code, 0, result.stderr);
      assertEquals(JSON.parse(result.stdout), {
        channels: ["pushover", "ntfy"],
        label: "Private memory",
        enabled: true,
        ntfyUrl: "https://notify.example/base",
        pollMs: 2_147_483_647,
        rollupMs: 1_800_000,
        timeoutMs: 10_000,
      });
    },
  );
});

Deno.test("metadata notification config: incomplete or unsafe channel config fails fast", async (t) => {
  await t.step("unknown adapter is rejected", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_CHANNELS: "misplaced-secret-value",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "Invalid METADATA_NOTIFY_CHANNELS");
    assertEquals(result.stderr.includes("misplaced-secret-value"), false);
  });

  await t.step("Pushover selection requires both credentials", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_CHANNELS: "pushover",
      METADATA_PUSHOVER_APP_TOKEN: "app-token",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "METADATA_PUSHOVER_USER_KEY");
  });

  await t.step("ntfy selection requires a topic", async () => {
    const result = await runConfig({ METADATA_NOTIFY_CHANNELS: "ntfy" });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "METADATA_NTFY_TOPIC");
  });

  await t.step("credential-bearing ntfy base URL is rejected", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_CHANNELS: "ntfy",
      METADATA_NTFY_TOPIC: "topic",
      METADATA_NTFY_SERVER_URL: "https://user:password@notify.example",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "contain no credentials");
    assertEquals(result.stderr.includes("password@"), false);
  });

  await t.step("non-header-safe ntfy bearer token is rejected", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_CHANNELS: "ntfy",
      METADATA_NTFY_TOPIC: "topic",
      METADATA_NTFY_TOKEN: "not-header-safe-€",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "not a valid bearer token");
    assertEquals(result.stderr.includes("not-header-safe"), false);
  });

  await t.step("timer values reject partial numeric strings", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_POLL_INTERVAL_MS: "1e3",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "METADATA_NOTIFY_POLL_INTERVAL_MS");
    assertStringIncludes(result.stderr, "complete positive decimal integer");
  });

  await t.step("timer values reject setTimeout overflow", async () => {
    const result = await runConfig({
      METADATA_NOTIFY_TIMEOUT_MS: "2147483648",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "METADATA_NOTIFY_TIMEOUT_MS");
    assertStringIncludes(result.stderr, "2147483647");
  });
});
