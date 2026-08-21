// Extraction-disabled deployments still persist an explicit stub classifier
// stamp, but do not turn a stable configuration into degradation history or a
// periodic alert forever.

import { assertEquals } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

Deno.test(
  "extractMetadata: disabled extraction returns a durable stub outcome",
  withEnv(
    [],
    {
      DB_PASSWORD: "test-password",
      MCP_ACCESS_KEY: "k".repeat(64),
      OBS_AUTH_EVENTS_ENABLED: "false",
      METADATA_FALLBACK_POLICY: "off",
    },
    async () => {
      const { extractMetadata } = await import("./metadata.ts");
      const result = await extractMetadata("content must not be echoed");
      assertEquals(result.metadata, {
        topics: ["uncategorized"],
        type: "observation",
      });
      assertEquals(result.classifier, { schema_version: 1, endpoint: "stub" });
      assertEquals(result.degradation_events, []);
    },
  ),
);
