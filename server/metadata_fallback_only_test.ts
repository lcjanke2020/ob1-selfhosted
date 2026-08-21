// A fallback-only deployment must actually classify via the fallback endpoint.
// An operator can configure ONLY FALLBACK_CHAT_* (leaving the primary CHAT_*
// blank — e.g. to avoid an unsafe primary transport) and expects every capture
// to be classified by the fallback, NOT silently stamped with the uncategorized
// stub. config.ts reads its flags once at module load and `deno test` gives each
// file its own worker, so this lives in its own file (the primary CHAT_* knobs
// are deliberately absent here). Run: `deno task test`.

import { assertEquals } from "jsr:@std/assert@1";
import { withEnv } from "./api_test_support.ts";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";
const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  OBS_AUTH_EVENTS_ENABLED: "false",
  FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
  FALLBACK_CHAT_MODEL: "hosted-model",
  FALLBACK_CHAT_API_KEY: "test-fallback-key",
  METADATA_FALLBACK_POLICY: "allow",
};

async function testFallbackOnly(): Promise<void> {
  const origFetch = globalThis.fetch;

  const urls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "idea",
                topics: ["fallback-only"],
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
    // The fallback classified it — NOT the uncategorized stub.
    assertEquals(r.metadata.type, "idea");
    assertEquals(r.metadata.topics, ["fallback-only"]);
    assertEquals(r.classifier, {
      schema_version: 1,
      endpoint: "fallback",
      model: "hosted-model",
    });
    assertEquals(r.degradation_events, [{
      event_type: "fallback_used",
      endpoint_role: "fallback",
      failure_reason: null,
      http_status: null,
      endpoint_model: "hosted-model",
      endpoint_base_url: FALLBACK_BASE,
    }]);
    // Exactly one call, to the fallback endpoint; the (blank) primary was
    // never contacted.
    assertEquals(urls.length, 1);
    assertEquals(urls[0], `${FALLBACK_BASE}/chat/completions`);
    assertEquals(
      urls.some((u) => u.startsWith(PRIMARY_BASE)),
      false,
      "no primary endpoint should be contacted in a fallback-only deployment",
    );
  });
  try {
    await run();
  } finally {
    globalThis.fetch = origFetch;
  }
}

Deno.test(
  "extractMetadata: fallback-only (primary blank) classifies via the fallback",
  testFallbackOnly,
);
