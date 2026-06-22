// A fallback-only deployment must actually classify via the fallback endpoint.
// An operator can configure ONLY FALLBACK_CHAT_* (leaving the primary CHAT_*
// blank — e.g. to avoid an unsafe primary transport) and expects every capture
// to be classified by the fallback, NOT silently stamped with the uncategorized
// stub. config.ts reads its flags once at module load and `deno test` gives each
// file its own worker, so this lives in its own file (the primary CHAT_* knobs
// are deliberately absent here). Run: `deno task test`.

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

Deno.test("extractMetadata: fallback-only (primary blank) classifies via the fallback", async () => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  const origFetch = globalThis.fetch;

  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  // Primary endpoint deliberately unconfigured; only the fallback is set.
  Deno.env.delete("CHAT_API_BASE");
  Deno.env.delete("CHAT_MODEL");
  Deno.env.delete("CHAT_API_KEY");
  Deno.env.delete("ENABLE_PRIMARY_EXTRACTION");
  Deno.env.set("FALLBACK_CHAT_API_BASE", FALLBACK_BASE);
  Deno.env.set("FALLBACK_CHAT_MODEL", "hosted-model");
  Deno.env.set("FALLBACK_CHAT_API_KEY", "test-fallback-key");

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

  try {
    const { extractMetadata } = await import("./metadata.ts");
    const r = await extractMetadata("anything");
    // The fallback classified it — NOT the uncategorized stub.
    assertEquals(r.type, "idea");
    assertEquals(r.topics, ["fallback-only"]);
    // Exactly one call, to the fallback endpoint; the (blank) primary was
    // never contacted.
    assertEquals(urls.length, 1);
    assertEquals(urls[0], `${FALLBACK_BASE}/chat/completions`);
    assertEquals(
      urls.some((u) => u.startsWith(PRIMARY_BASE)),
      false,
      "no primary endpoint should be contacted in a fallback-only deployment",
    );
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
