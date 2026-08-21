// `off` is the privacy-enforcing policy: even a fully configured fallback must
// receive no request after a primary failure. A separate worker gives config.ts
// a fresh module load with the policy fixed to off.

import { assertEquals } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";
const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  OBS_AUTH_EVENTS_ENABLED: "false",
  CHAT_API_BASE: PRIMARY_BASE,
  CHAT_MODEL: "local-model",
  ENABLE_PRIMARY_EXTRACTION: "true",
  FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
  FALLBACK_CHAT_MODEL: "hosted-model",
  FALLBACK_CHAT_API_KEY: "must-not-be-used",
  METADATA_FALLBACK_POLICY: "off",
};

async function testFallbackPolicyOff(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;

  const urls: string[] = [];
  const warnings: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(new Response(null, { status: 503 }));
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  const run = withEnv([], TEST_ENV, async () => {
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
    assertEquals(result.classifier, {
      schema_version: 1,
      endpoint: "stub",
    });
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
  });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

Deno.test(
  "extractMetadata: off policy never requests the configured fallback",
  testFallbackPolicyOff,
);
