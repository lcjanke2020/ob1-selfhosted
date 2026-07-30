// Subprocess tests for extraction and notification config's fail-fast
// contracts. Each case gets a fresh config.ts instance and no network access.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = `
  const c = await import("./config.ts");
  console.log(JSON.stringify({
    channels: c.METADATA_NOTIFY_CHANNELS,
    label: c.METADATA_NOTIFY_LABEL,
    enabled: c.ENABLE_METADATA_NOTIFICATIONS,
    fallbackEnabled: c.ENABLE_FALLBACK_EXTRACTION,
    policy: c.METADATA_FALLBACK_POLICY,
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
  CHAT_API_BASE: "",
  CHAT_API_KEY: "",
  CHAT_MODEL: "",
  ENABLE_PRIMARY_EXTRACTION: "",
  FALLBACK_CHAT_API_BASE: "",
  FALLBACK_CHAT_API_KEY: "",
  FALLBACK_CHAT_MODEL: "",
  METADATA_FALLBACK_POLICY: "off",
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
      fallbackEnabled: false,
      policy: "off",
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
        fallbackEnabled: false,
        policy: "off",
        ntfyUrl: "https://notify.example/base",
        pollMs: 2_147_483_647,
        rollupMs: 1_800_000,
        timeoutMs: 10_000,
      });
    },
  );
});

Deno.test("metadata fallback policy: required, bounded, and notification-aware", async (t) => {
  await t.step("unset policy refuses to boot", async () => {
    const result = await runConfig({ METADATA_FALLBACK_POLICY: "" });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "Missing required env var");
    assertStringIncludes(result.stderr, "METADATA_FALLBACK_POLICY");
  });

  await t.step("unknown policy refuses to boot", async () => {
    const result = await runConfig({ METADATA_FALLBACK_POLICY: "silent" });
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "METADATA_FALLBACK_POLICY must be off, alert, or allow",
    );
  });

  await t.step("off keeps a configured fallback inert", async () => {
    const result = await runConfig({
      METADATA_FALLBACK_POLICY: "off",
      FALLBACK_CHAT_API_BASE: "https://fallback.example/v1",
      FALLBACK_CHAT_MODEL: "fallback-model",
    });
    assertEquals(result.code, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assertEquals(config.policy, "off");
    assertEquals(config.fallbackEnabled, false);
  });

  await t.step(
    "allow activates a configured fallback without delivery",
    async () => {
      const result = await runConfig({
        METADATA_FALLBACK_POLICY: "allow",
        FALLBACK_CHAT_API_BASE: "https://fallback.example/v1",
        FALLBACK_CHAT_MODEL: "fallback-model",
      });
      assertEquals(result.code, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      assertEquals(config.policy, "allow");
      assertEquals(config.fallbackEnabled, true);
      assertEquals(config.enabled, false);
    },
  );

  await t.step(
    "alert without a notification channel refuses to boot",
    async () => {
      const result = await runConfig({ METADATA_FALLBACK_POLICY: "alert" });
      assertEquals(result.code, 1);
      assertStringIncludes(
        result.stderr,
        "METADATA_FALLBACK_POLICY=alert requires at least one configured",
      );
      assertStringIncludes(result.stderr, "METADATA_NOTIFY_CHANNELS");
    },
  );

  await t.step("alert activates fallback with a valid channel", async () => {
    const result = await runConfig({
      METADATA_FALLBACK_POLICY: "alert",
      FALLBACK_CHAT_API_BASE: "https://fallback.example/v1",
      FALLBACK_CHAT_MODEL: "fallback-model",
      METADATA_NOTIFY_CHANNELS: "ntfy",
      METADATA_NTFY_TOPIC: "private-topic",
    });
    assertEquals(result.code, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assertEquals(config.policy, "alert");
    assertEquals(config.fallbackEnabled, true);
    assertEquals(config.enabled, true);
  });
});

Deno.test("metadata extraction config: explicit primary opt-in fails closed", async (t) => {
  await t.step("enabled primary requires both endpoint and model", async () => {
    const result = await runConfig({
      ENABLE_PRIMARY_EXTRACTION: "true",
      CHAT_API_BASE: "http://classifier.example/v1",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "ENABLE_PRIMARY_EXTRACTION=true");
    assertStringIncludes(result.stderr, "CHAT_API_BASE and CHAT_MODEL");
  });

  await t.step("misspelled primary gate is rejected", async () => {
    const result = await runConfig({
      ENABLE_PRIMARY_EXTRACTION: "ture",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "must be true or false");
    assertEquals(result.stderr.includes("ture"), false);
  });
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
