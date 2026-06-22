// The primary endpoint must NOT be called when ENABLE_PRIMARY_EXTRACTION is off
// (the default). config.ts reads the flag once at module load and `deno test`
// gives each file its own worker, so this lives in a separate file from
// metadata_test.ts (which loads config with the flag ON). Run: `deno task test`.

import { assertEquals } from "jsr:@std/assert@1";

const PRIMARY_BASE = "http://primary.invalid/v1";
const FALLBACK_BASE = "http://fallback.invalid/v1";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "OBS_AUTH_EVENTS_ENABLED",
  "CHAT_API_BASE",
  "CHAT_API_KEY",
  "CHAT_MODEL",
  "FALLBACK_CHAT_API_BASE",
  "FALLBACK_CHAT_API_KEY",
  "FALLBACK_CHAT_MODEL",
  "ENABLE_PRIMARY_EXTRACTION",
];

Deno.test("extractMetadata: primary is skipped when ENABLE_PRIMARY_EXTRACTION is off", async () => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  const origFetch = globalThis.fetch;

  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  // Both endpoints configured, but the primary gate is OFF (deleted, not "true").
  Deno.env.set("CHAT_API_BASE", PRIMARY_BASE);
  Deno.env.set("CHAT_MODEL", "local-model");
  Deno.env.set("FALLBACK_CHAT_API_BASE", FALLBACK_BASE);
  Deno.env.set("FALLBACK_CHAT_MODEL", "hosted-model");
  Deno.env.set("FALLBACK_CHAT_API_KEY", "test-fallback-key");
  Deno.env.delete("ENABLE_PRIMARY_EXTRACTION");

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

  try {
    const { extractMetadata } = await import("./metadata.ts");
    const r = await extractMetadata("anything");
    assertEquals(r.type, "observation");
    // Only the fallback endpoint was contacted; the primary was never called.
    assertEquals(urls.length, 1);
    assertEquals(urls[0], `${FALLBACK_BASE}/chat/completions`);
    assertEquals(
      urls.some((u) => u.startsWith(PRIMARY_BASE)),
      false,
      "primary endpoint must not be contacted when the gate is off",
    );
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
