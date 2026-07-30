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
const TEST_CHAT_TIMEOUT_MS = 40;

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
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
// unconsumed body stream (production cancels a non-2xx body without reading it).
function chatErr(status: number): Response {
  return new Response(null, { status });
}

function stalledChatResponse(
  signal: AbortSignal | null | undefined,
): { response: Response; release: () => void } {
  const encoder = new TextEncoder();
  let open = true;
  let streamController: ReadableStreamDefaultController<Uint8Array>;

  const abortBody = () => {
    if (!open) return;
    open = false;
    streamController.error(
      signal?.reason ??
        new DOMException("The operation was aborted", "AbortError"),
    );
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode("{"));
      if (signal?.aborted) abortBody();
      else signal?.addEventListener("abort", abortBody, { once: true });
    },
    cancel() {
      open = false;
      signal?.removeEventListener("abort", abortBody);
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: () => {
      signal?.removeEventListener("abort", abortBody);
      if (!open) return;
      open = false;
      streamController.error(new Error("stalled-response test cleanup"));
    },
  };
}

function validMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "observation",
    topics: ["metadata"],
    people: [],
    action_items: [],
    dates_mentioned: [],
    ...overrides,
  };
}

Deno.test("extractMetadata: primary → fallback → stub", async (t) => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  const origFetch = globalThis.fetch;
  const origWarn = console.warn;

  // config.ts module-load requirements + both endpoints configured.
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("CHAT_API_BASE", PRIMARY_BASE);
  Deno.env.set("CHAT_MODEL", "local-model");
  Deno.env.set("CHAT_TIMEOUT_MS", String(TEST_CHAT_TIMEOUT_MS));
  Deno.env.delete("CHAT_API_KEY"); // primary needs no auth (e.g. local ollama)
  Deno.env.set("FALLBACK_CHAT_API_BASE", FALLBACK_BASE);
  Deno.env.set("FALLBACK_CHAT_MODEL", "hosted-model");
  Deno.env.set("FALLBACK_CHAT_API_KEY", "test-fallback-key");
  Deno.env.set("ENABLE_PRIMARY_EXTRACTION", "true"); // exercise the primary path

  const calls: Captured[] = [];
  // Reassigned per step to choose what each endpoint returns.
  let responder: (c: Captured, init?: RequestInit) => Response = () =>
    chatErr(500);
  const warnings: string[] = [];

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body
      ? JSON.parse(init.body as string) as Record<string, unknown>
      : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const captured: Captured = { url, body, headers };
    calls.push(captured);
    return Promise.resolve(responder(captured, init));
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    // Import inside the try so the finally below always restores fetch + env,
    // even if module-load (config.ts validation) were to throw.
    const { extractMetadata, sanitizeMetadataEndpointBase } = await import(
      "./metadata.ts"
    );

    await t.step(
      "persisted endpoint base strips credential-bearing URL parts",
      () => {
        assertEquals(
          sanitizeMetadataEndpointBase(
            "https://user:password@example.invalid/v1?api_key=secret#fragment",
          ),
          "https://example.invalid/v1",
        );
      },
    );

    await t.step(
      "primary success returns its result, no fallback call",
      async () => {
        calls.length = 0;
        warnings.length = 0;
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
        assertEquals(r.metadata.type, "task");
        assertEquals(r.metadata.topics, ["dentist"]);
        assertEquals(r.classifier, {
          schema_version: 1,
          endpoint: "primary",
          model: "local-model",
        });
        assertEquals(r.degradation_events, []);
        assertEquals(
          calls.length,
          1,
          "fallback must NOT be called on primary success",
        );
        assertEquals(calls[0].url, `${PRIMARY_BASE}/chat/completions`);
        assertEquals(warnings, []);
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
        warnings.length = 0;
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE) ? chatErr(500) : chatOk({
            type: "idea",
            topics: ["caching"],
            people: [],
            action_items: [],
            dates_mentioned: [],
          });

        const r = await extractMetadata("what if we cached this");
        assertEquals(r.metadata.type, "idea");
        assertEquals(calls.length, 2, "both endpoints should be tried");
        assertEquals(calls[1].url, `${FALLBACK_BASE}/chat/completions`);
        assertEquals(calls[1].body.model, "hosted-model");
        // fallback has an API key → Authorization header present.
        assertEquals(
          calls[1].headers.Authorization,
          "Bearer test-fallback-key",
        );
        assertEquals(
          warnings[0],
          "[metadata] primary endpoint failed (non-2xx response) — HTTP 500",
        );
        assertEquals(r.classifier, {
          schema_version: 1,
          endpoint: "fallback",
          model: "hosted-model",
        });
        assertEquals(r.degradation_events, [
          {
            event_type: "primary_failure",
            endpoint_role: "primary",
            failure_reason: "non_2xx",
            http_status: 500,
            endpoint_model: "local-model",
            endpoint_base_url: PRIMARY_BASE,
          },
          {
            event_type: "fallback_used",
            endpoint_role: "fallback",
            failure_reason: null,
            http_status: null,
            endpoint_model: "hosted-model",
            endpoint_base_url: FALLBACK_BASE,
          },
        ]);
      },
    );

    await t.step(
      "primary transport failure keeps the legacy endpoint-failed substring",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        responder = (c) => {
          if (c.url.startsWith(PRIMARY_BASE)) {
            throw new TypeError("simulated transport failure");
          }
          return chatOk(validMetadata({ topics: ["transport-fallback"] }));
        };

        const r = await extractMetadata("anything");
        assertEquals(r.metadata.topics, ["transport-fallback"]);
        assertEquals(
          warnings[0],
          "[metadata] primary endpoint failed (transport/timeout)",
        );
      },
    );

    await t.step(
      "primary invalid response envelope falls back too",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE)
            ? new Response("null", { status: 200 })
            : chatOk(validMetadata({ topics: ["response-fallback"] }));

        const r = await extractMetadata("anything");
        assertEquals(r.metadata.topics, ["response-fallback"]);
        assertEquals(calls.length, 2);
        assertEquals(
          warnings[0],
          "[metadata] primary endpoint returned an invalid response — falling through",
        );
      },
    );

    await t.step(
      "primary malformed outer JSON is an invalid response",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE)
            ? new Response("{", {
              status: 200,
              headers: { "content-type": "application/json" },
            })
            : chatOk(validMetadata({ topics: ["malformed-fallback"] }));

        const r = await extractMetadata("anything");
        assertEquals(r.metadata.topics, ["malformed-fallback"]);
        assertEquals(calls.length, 2);
        assertEquals(
          warnings[0],
          "[metadata] primary endpoint returned an invalid response — falling through",
        );
      },
    );

    await t.step(
      "primary response body timeout is a transport failure",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        let releaseBody = () => {};
        responder = (c, init) => {
          if (c.url.startsWith(PRIMARY_BASE)) {
            const stalled = stalledChatResponse(init?.signal);
            releaseBody = stalled.release;
            return stalled.response;
          }
          return chatOk(validMetadata({ topics: ["timeout-fallback"] }));
        };

        try {
          const r = await extractMetadata("anything");
          assertEquals(r.metadata.topics, ["timeout-fallback"]);
          assertEquals(calls.length, 2);
          assertEquals(
            warnings[0],
            "[metadata] primary endpoint failed (transport/timeout)",
          );
        } finally {
          releaseBody();
        }
      },
    );

    await t.step("primary unparseable output falls back too", async () => {
      calls.length = 0;
      warnings.length = 0;
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
      assertEquals(r.metadata.type, "reference");
      assertEquals(calls.length, 2);
      assertEquals(
        warnings[0],
        "[metadata] primary endpoint returned unparseable metadata — falling through",
      );
    });

    await t.step("primary array output is rejected, falls back", async () => {
      calls.length = 0;
      warnings.length = 0;
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
      assertEquals(r.metadata.type, "person_note");
      assertEquals(
        calls.length,
        2,
        "an array from the primary must not count as success",
      );
      assertEquals(
        warnings[0],
        "[metadata] primary endpoint returned schema-invalid metadata — falling through",
      );
    });

    const invalidMetadataCases: Array<{ name: string; value: unknown }> = [
      { name: "missing required fields", value: {} },
      {
        name: "invalid type enum",
        value: validMetadata({ type: "memo" }),
      },
      {
        name: "wrong field type",
        value: validMetadata({ people: "Dana" }),
      },
      {
        name: "wrong array item type",
        value: validMetadata({ action_items: [42] }),
      },
      {
        name: "zero topics",
        value: validMetadata({ topics: [] }),
      },
      {
        name: "more than three topics",
        value: validMetadata({ topics: ["one", "two", "three", "four"] }),
      },
      {
        name: "additional property",
        value: validMetadata({ confidence: 0.9 }),
      },
    ];

    for (const { name, value } of invalidMetadataCases) {
      await t.step(`schema-invalid primary (${name}) falls back`, async () => {
        calls.length = 0;
        warnings.length = 0;
        const fallbackMetadata = validMetadata({
          type: "idea",
          topics: ["validated-fallback"],
        });
        responder = (c) =>
          c.url.startsWith(PRIMARY_BASE)
            ? chatOk(value)
            : chatOk(fallbackMetadata);

        const r = await extractMetadata("schema validation case");
        assertEquals(r.metadata, fallbackMetadata);
        assertEquals(
          calls.map((c) => c.url),
          [
            `${PRIMARY_BASE}/chat/completions`,
            `${FALLBACK_BASE}/chat/completions`,
          ],
        );
        assertEquals(
          warnings[0],
          "[metadata] primary endpoint returned schema-invalid metadata — falling through",
        );
      });
    }

    await t.step(
      "schema-invalid primary and fallback outputs reach the stub",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        responder = () => chatOk({});

        const r = await extractMetadata("anything");
        assertEquals(r.metadata, {
          topics: ["uncategorized"],
          type: "observation",
        });
        assertEquals(calls.length, 2, "primary then fallback both attempted");
        assertEquals(warnings, [
          "[metadata] primary endpoint returned schema-invalid metadata — falling through",
          "[metadata] fallback endpoint returned schema-invalid metadata — falling through",
          "[metadata] no endpoint produced metadata; stamping uncategorized stub",
        ]);
      },
    );

    await t.step(
      "both endpoints fail → minimal uncategorized stub",
      async () => {
        calls.length = 0;
        warnings.length = 0;
        responder = (c) => chatErr(c.url.startsWith(PRIMARY_BASE) ? 401 : 503);

        const r = await extractMetadata("anything");
        assertEquals(r.metadata, {
          topics: ["uncategorized"],
          type: "observation",
        });
        assertEquals(calls.length, 2, "primary then fallback both attempted");
        assertEquals(warnings, [
          "[metadata] primary endpoint failed (non-2xx response) — HTTP 401",
          "[metadata] fallback endpoint failed (non-2xx response) — HTTP 503",
          "[metadata] no endpoint produced metadata; stamping uncategorized stub",
        ]);
        assertEquals(r.classifier, { schema_version: 1, endpoint: "stub" });
        assertEquals(r.degradation_events, [
          {
            event_type: "primary_failure",
            endpoint_role: "primary",
            failure_reason: "non_2xx",
            http_status: 401,
            endpoint_model: "local-model",
            endpoint_base_url: PRIMARY_BASE,
          },
          {
            event_type: "fallback_failure",
            endpoint_role: "fallback",
            failure_reason: "non_2xx",
            http_status: 503,
            endpoint_model: "hosted-model",
            endpoint_base_url: FALLBACK_BASE,
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
      },
    );
  } finally {
    globalThis.fetch = origFetch;
    console.warn = origWarn;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
