// Tests for extractMetadata's primary → fallback → stub orchestration and the
// json_schema structured-output request shape. Run with `deno task test`.
//
// Hermetic: snapshots/restores the env keys THIS TEST mutates (DB_PASSWORD /
// MCP_ACCESS_KEY / the CHAT_* + FALLBACK_CHAT_* knobs config.ts reads at module
// load) and the global fetch. config.ts reads other env vars too, but they are
// not touched here. Both the primary and fallback endpoints are configured so a
// single module-load (Deno caches dynamic imports per worker) can exercise
// every path — the path taken is driven entirely by the swappable fetch stub,
// keyed on which endpoint's URL was called. No real network: fetch is stubbed.

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
  "CHAT_TIMEOUT_MS",
  "FALLBACK_CHAT_API_BASE",
  "FALLBACK_CHAT_API_KEY",
  "FALLBACK_CHAT_MODEL",
  "ENABLE_PRIMARY_EXTRACTION",
];

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

// 200 with an OpenAI-shaped chat completion whose content is the given object
// serialized as JSON (what a json_schema-constrained model returns).
function chatOk(obj: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(obj) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Error response with a null body so the test resource sanitizer sees no
// unconsumed body stream (the production code returns null without reading it).
function chatErr(status: number): Response {
  return new Response(null, { status });
}

Deno.test("extractMetadata: primary → fallback → stub", async (t) => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  const origFetch = globalThis.fetch;

  // config.ts module-load requirements + both endpoints configured.
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("CHAT_API_BASE", PRIMARY_BASE);
  Deno.env.set("CHAT_MODEL", "local-model");
  Deno.env.delete("CHAT_API_KEY"); // primary needs no auth (e.g. local ollama)
  Deno.env.set("FALLBACK_CHAT_API_BASE", FALLBACK_BASE);
  Deno.env.set("FALLBACK_CHAT_MODEL", "hosted-model");
  Deno.env.set("FALLBACK_CHAT_API_KEY", "test-fallback-key");
  Deno.env.set("ENABLE_PRIMARY_EXTRACTION", "true"); // exercise the primary path

  const calls: Captured[] = [];
  // Reassigned per step to choose what each endpoint returns.
  let responder: (c: Captured) => Response = () => chatErr(500);

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body
      ? JSON.parse(init.body as string) as Record<string, unknown>
      : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const captured: Captured = { url, body, headers };
    calls.push(captured);
    return Promise.resolve(responder(captured));
  }) as typeof fetch;

  const { extractMetadata } = await import("./metadata.ts");

  try {
    await t.step(
      "primary success returns its result, no fallback call",
      async () => {
        calls.length = 0;
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE)
            ? chatOk({
              type: "task",
              topics: ["dentist"],
              people: [],
              action_items: ["Call the dentist"],
              dates_mentioned: [],
            })
            : chatOk({ type: "observation", topics: ["wrong-endpoint"] });

        const r = await extractMetadata("Call the dentist tomorrow");
        assertEquals(r.type, "task");
        assertEquals(r.topics, ["dentist"]);
        assertEquals(
          calls.length,
          1,
          "fallback must NOT be called on primary success",
        );
        assertEquals(calls[0].url, `${PRIMARY_BASE}/chat/completions`);
      },
    );

    await t.step("request carries strict json_schema response_format", () => {
      const rf = calls[0].body.response_format as Record<string, unknown>;
      assertEquals(rf.type, "json_schema");
      const js = rf.json_schema as Record<string, unknown>;
      assertEquals(js.name, "thought_metadata");
      assertEquals(js.strict, true);
      assertEquals(calls[0].body.model, "local-model");
      // primary has no API key → no Authorization header.
      assertEquals(calls[0].headers.Authorization, undefined);
    });

    await t.step(
      "primary failure (5xx) falls back to the hosted endpoint",
      async () => {
        calls.length = 0;
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE) ? chatErr(500) : chatOk({
            type: "idea",
            topics: ["caching"],
            people: [],
            action_items: [],
            dates_mentioned: [],
          });

        const r = await extractMetadata("what if we cached this");
        assertEquals(r.type, "idea");
        assertEquals(calls.length, 2, "both endpoints should be tried");
        assertEquals(calls[1].url, `${FALLBACK_BASE}/chat/completions`);
        assertEquals(calls[1].body.model, "hosted-model");
        // fallback has an API key → Authorization header present.
        assertEquals(
          calls[1].headers.Authorization,
          "Bearer test-fallback-key",
        );
      },
    );

    await t.step("primary unparseable output falls back too", async () => {
      calls.length = 0;
      responder = (c) =>
        c.url.startsWith(PRIMARY_BASE)
          // 200 but content isn't valid JSON → parse fails → treated as failure.
          ? new Response(
            JSON.stringify({
              choices: [{ message: { content: "not json {{" } }],
            }),
            { status: 200 },
          )
          : chatOk({
            type: "reference",
            topics: ["x"],
            people: [],
            action_items: [],
            dates_mentioned: [],
          });

      const r = await extractMetadata("save this link");
      assertEquals(r.type, "reference");
      assertEquals(calls.length, 2);
    });

    await t.step("primary array output is rejected, falls back", async () => {
      calls.length = 0;
      responder = (c) =>
        c.url.startsWith(PRIMARY_BASE)
          // 200 but content is a JSON array — typeof [] === "object", so this
          // guards that arrays aren't mistaken for a metadata object.
          ? chatOk([])
          : chatOk({
            type: "person_note",
            topics: ["dana"],
            people: ["Dana"],
            action_items: [],
            dates_mentioned: [],
          });

      const r = await extractMetadata("note about Dana");
      assertEquals(r.type, "person_note");
      assertEquals(
        calls.length,
        2,
        "an array from the primary must not count as success",
      );
    });

    await t.step(
      "both endpoints fail → minimal uncategorized stub",
      async () => {
        calls.length = 0;
        responder = () => chatErr(503);

        const r = await extractMetadata("anything");
        assertEquals(r, { topics: ["uncategorized"], type: "observation" });
        assertEquals(calls.length, 2, "primary then fallback both attempted");
      },
    );
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
