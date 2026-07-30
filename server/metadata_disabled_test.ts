// Extraction-disabled deployments still persist an explicit stub classifier
// stamp, but do not turn a stable configuration into degradation history or a
// periodic alert forever.

import { assertEquals } from "@std/assert";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
  "CHAT_API_BASE",
  "CHAT_API_KEY",
  "CHAT_MODEL",
  "FALLBACK_CHAT_API_BASE",
  "FALLBACK_CHAT_API_KEY",
  "FALLBACK_CHAT_MODEL",
  "ENABLE_PRIMARY_EXTRACTION",
];

Deno.test("extractMetadata: disabled extraction returns a durable stub outcome", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)] as const),
  );
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  for (
    const key of [
      "MCP_ACCESS_KEY_PRINCIPAL",
      "AUTH0_ISSUER",
      "AUTH0_JWKS_URI",
      "AUTH0_AUDIENCE",
      "CHAT_API_BASE",
      "CHAT_API_KEY",
      "CHAT_MODEL",
      "FALLBACK_CHAT_API_BASE",
      "FALLBACK_CHAT_API_KEY",
      "FALLBACK_CHAT_MODEL",
      "ENABLE_PRIMARY_EXTRACTION",
    ]
  ) Deno.env.delete(key);

  try {
    const { extractMetadata } = await import("./metadata.ts");
    const result = await extractMetadata("content must not be echoed");
    assertEquals(result.metadata, {
      topics: ["uncategorized"],
      type: "observation",
    });
    assertEquals(result.classifier, { schema_version: 1, endpoint: "stub" });
    assertEquals(result.degradation_events, []);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
