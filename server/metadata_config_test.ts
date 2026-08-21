// Fresh-process tests for metadata behaviors selected at config-module load.
// Each case uses the shared subprocess fixture so the privacy policy, endpoint
// gates, and fallback topology can vary without one worker file per case.

import { assertEquals } from "@std/assert";
import { runConfigSubprocess } from "./api_test_support.ts";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";

const SCRIPT = `
  const urls = [];
  const warnings = [];
  const logs = [];
  const writeOutput = console.log.bind(console);
  console.warn = (...args) => warnings.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    urls.push(url);
    if (Deno.env.get("TEST_METADATA_RESPONSE") === "failure") {
      return new Response(null, { status: 503 });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            type: Deno.env.get("TEST_METADATA_TYPE") ?? "observation",
            topics: [Deno.env.get("TEST_METADATA_TOPIC") ?? "test"],
            people: [],
            action_items: [],
            dates_mentioned: [],
          }),
        },
      }],
    }), { status: 200 });
  };
  const { extractMetadata } = await import("./metadata.ts");
  const result = await extractMetadata("content must not be echoed");
  writeOutput(JSON.stringify({ result, urls, warnings, logs }));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  OBS_AUTH_EVENTS_ENABLED: "false",
  CHAT_API_BASE: "",
  CHAT_MODEL: "",
  ENABLE_PRIMARY_EXTRACTION: "",
  FALLBACK_CHAT_API_BASE: "",
  FALLBACK_CHAT_API_KEY: "",
  FALLBACK_CHAT_MODEL: "",
  METADATA_FALLBACK_POLICY: "off",
  TEST_METADATA_RESPONSE: "success",
  TEST_METADATA_TYPE: "observation",
  TEST_METADATA_TOPIC: "test",
};

interface MetadataRun {
  result: {
    metadata: Record<string, unknown>;
    classifier: Record<string, unknown>;
    degradation_events: Array<Record<string, unknown>>;
  };
  urls: string[];
  warnings: string[];
  logs: string[];
}

async function runMetadata(
  overrides: Record<string, string> = {},
): Promise<MetadataRun> {
  const output = await runConfigSubprocess(SCRIPT, BASE_ENV, overrides);
  assertEquals(output.code, 0, output.stderr);
  return JSON.parse(output.stdout) as MetadataRun;
}

Deno.test("metadata config skips primary extraction when its gate is off", async () => {
  const output = await runMetadata({
    CHAT_API_BASE: PRIMARY_BASE,
    CHAT_MODEL: "local-model",
    FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
    FALLBACK_CHAT_MODEL: "hosted-model",
    FALLBACK_CHAT_API_KEY: "test-fallback-key",
    METADATA_FALLBACK_POLICY: "allow",
    TEST_METADATA_TOPIC: "x",
  });

  assertEquals(output.result.metadata.type, "observation");
  assertEquals(output.result.classifier.endpoint, "fallback");
  assertEquals(
    output.result.degradation_events.map((event) => event.event_type),
    ["fallback_used"],
  );
  assertEquals(output.urls, [`${FALLBACK_BASE}/chat/completions`]);
  assertEquals(
    output.urls.some((url) => url.startsWith(PRIMARY_BASE)),
    false,
  );
});

Deno.test("metadata off policy never requests a configured fallback", async () => {
  const output = await runMetadata({
    CHAT_API_BASE: PRIMARY_BASE,
    CHAT_MODEL: "local-model",
    ENABLE_PRIMARY_EXTRACTION: "true",
    FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
    FALLBACK_CHAT_MODEL: "hosted-model",
    FALLBACK_CHAT_API_KEY: "must-not-be-used",
    TEST_METADATA_RESPONSE: "failure",
  });

  assertEquals(output.urls, [`${PRIMARY_BASE}/chat/completions`]);
  assertEquals(
    output.urls.some((url) => url.startsWith(FALLBACK_BASE)),
    false,
  );
  assertEquals(output.result.metadata, {
    topics: ["uncategorized"],
    type: "observation",
  });
  assertEquals(output.result.classifier, {
    schema_version: 1,
    endpoint: "stub",
  });
  assertEquals(output.result.degradation_events, [
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
  assertEquals(output.warnings, [
    "[metadata] primary endpoint failed (non-2xx response) — HTTP 503",
    "[metadata] no endpoint produced metadata; stamping uncategorized stub",
  ]);
});

Deno.test("metadata fallback-only config classifies through the fallback", async () => {
  const output = await runMetadata({
    FALLBACK_CHAT_API_BASE: FALLBACK_BASE,
    FALLBACK_CHAT_MODEL: "hosted-model",
    FALLBACK_CHAT_API_KEY: "test-fallback-key",
    METADATA_FALLBACK_POLICY: "allow",
    TEST_METADATA_TYPE: "idea",
    TEST_METADATA_TOPIC: "fallback-only",
  });

  assertEquals(output.result.metadata.type, "idea");
  assertEquals(output.result.metadata.topics, ["fallback-only"]);
  assertEquals(output.result.classifier, {
    schema_version: 1,
    endpoint: "fallback",
    model: "hosted-model",
  });
  assertEquals(output.result.degradation_events, [{
    event_type: "fallback_used",
    endpoint_role: "fallback",
    failure_reason: null,
    http_status: null,
    endpoint_model: "hosted-model",
    endpoint_base_url: FALLBACK_BASE,
  }]);
  assertEquals(output.urls, [`${FALLBACK_BASE}/chat/completions`]);
  assertEquals(
    output.urls.some((url) => url.startsWith(PRIMARY_BASE)),
    false,
  );
});

Deno.test("disabled metadata extraction returns a durable stub outcome", async () => {
  const output = await runMetadata();
  assertEquals(output.urls, []);
  assertEquals(output.result.metadata, {
    topics: ["uncategorized"],
    type: "observation",
  });
  assertEquals(output.result.classifier, {
    schema_version: 1,
    endpoint: "stub",
  });
  assertEquals(output.result.degradation_events, []);
});
