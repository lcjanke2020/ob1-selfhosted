// The primary endpoint must NOT be called when ENABLE_PRIMARY_EXTRACTION is off
// (the default). config.ts reads the flag once at module load and `deno test`
// gives each file its own worker, so this lives in a separate file from
// metadata_test.ts (which loads config with the flag ON). Run: `deno task test`.

import { assertEquals } from "jsr:@std/assert@1";
import { withEnv } from "./api_test_support.ts";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";
const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  OBS_AUTH_EVENTS_ENABLED: "false",
  CHAT_API_BASE: PRIMARY_BASE,
  CHAT_MODEL: "local-model",
  FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
  FALLBACK_CHAT_MODEL: "hosted-model",
  FALLBACK_CHAT_API_KEY: "test-fallback-key",
  METADATA_FALLBACK_POLICY: "allow",
};

async function testPrimaryGateOff(): Promise<void> {
  const origFetch = globalThis.fetch;

  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    // Fallback answers; primary would answer too, but it must never be reached.
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "observation",
                topics: ["x"],
                people: [],
                action_items: [],
                dates_mentioned: [],
              }),
            },
          }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const run = withEnv([], TEST_ENV, async () => {
    const { extractMetadata } = await import("./metadata.ts");
    const r = await extractMetadata("anything");
    assertEquals(r.metadata.type, "observation");
    assertEquals(r.classifier.endpoint, "fallback");
    assertEquals(r.degradation_events.map((event) => event.event_type), [
      "fallback_used",
    ]);
    // Only the fallback endpoint was contacted; the primary was never called.
    assertEquals(urls.length, 1);
    assertEquals(urls[0], `${FALLBACK_BASE}/chat/completions`);
    assertEquals(
      urls.some((u) => u.startsWith(PRIMARY_BASE)),
      false,
      "primary endpoint must not be contacted when the gate is off",
    );
  });
  try {
    await run();
  } finally {
    globalThis.fetch = origFetch;
  }
}

Deno.test(
  "extractMetadata: primary is skipped when ENABLE_PRIMARY_EXTRACTION is off",
  testPrimaryGateOff,
);
