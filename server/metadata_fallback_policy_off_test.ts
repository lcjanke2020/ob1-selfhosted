// `off` is the privacy-enforcing policy: even a fully configured fallback must
// receive no request after a primary failure. A separate worker gives config.ts
// a fresh module load with the policy fixed to off.

import { assertEquals } from "@std/assert";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";

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
  "METADATA_FALLBACK_POLICY",
];

Deno.test("extractMetadata: off policy never requests the configured fallback", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)] as const),
  );
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;

  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("CHAT_API_BASE", PRIMARY_BASE);
  Deno.env.set("CHAT_MODEL", "local-model");
  Deno.env.delete("CHAT_API_KEY");
  Deno.env.set("ENABLE_PRIMARY_EXTRACTION", "true");
  Deno.env.set("FALLBACK_CHAT_API_BASE", FALLBACK_BASE);
  Deno.env.set("FALLBACK_CHAT_MODEL", "hosted-model");
  Deno.env.set("FALLBACK_CHAT_API_KEY", "must-not-be-used");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");

  const urls: string[] = [];
  const warnings: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(new Response(null, { status: 503 }));
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    const { extractMetadata } = await import("./metadata.ts");
    const result = await extractMetadata("privacy policy fixture");

    assertEquals(urls, [`${PRIMARY_BASE}/chat/completions`]);
    assertEquals(
      urls.some((url) => url.startsWith(FALLBACK_BASE)),
      false,
      "off policy must make zero outbound requests to the fallback base URL",
    );
    assertEquals(result.metadata, {
      topics: ["uncategorized"],
      type: "observation",
    });
    assertEquals(result.classifier, { schema_version: 1, endpoint: "stub" });
    assertEquals(result.degradation_events, [
      {
        event_type: "primary_failure",
        endpoint_role: "primary",
        failure_reason: "non_2xx",
        http_status: 503,
        endpoint_model: "local-model",
        endpoint_base_url: PRIMARY_BASE,
      },
      {
        event_type: "stub_used",
        endpoint_role: null,
        failure_reason: null,
        http_status: null,
        endpoint_model: null,
        endpoint_base_url: null,
      },
    ]);
    assertEquals(warnings, [
      "[metadata] primary endpoint failed (non-2xx response) — HTTP 503",
      "[metadata] no endpoint produced metadata; stamping uncategorized stub",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
