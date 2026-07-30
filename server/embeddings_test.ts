// Regression coverage for the complete Ollama embedding-response deadline.
// Hermetic: fetch returns headers immediately, then a signal-aware body stream
// stalls until the production AbortController fires. No real network is used.

import { assert } from "@std/assert";

const FETCH_TIMEOUT_MS = 40;
const ASSERTION_DEADLINE_MS = 250;
const OLLAMA_URL = "http://ollama.invalid";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
  "METADATA_FALLBACK_POLICY",
  "FETCH_TIMEOUT_MS",
  "OLLAMA_URL",
  "EMBED_DIM",
];

type Outcome =
  | { kind: "resolved"; value: number[] }
  | { kind: "rejected"; error: unknown }
  | { kind: "deadline" };

function stalledResponse(
  signal: AbortSignal | null | undefined,
  status: number,
  prefix: string,
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
      controller.enqueue(encoder.encode(prefix));
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
      status,
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

Deno.test("embed: timeout covers response body consumption", async (t) => {
  const originalEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;

  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("FETCH_TIMEOUT_MS", String(FETCH_TIMEOUT_MS));
  Deno.env.set("OLLAMA_URL", OLLAMA_URL);
  Deno.env.set("EMBED_DIM", "1");

  let responseStatus = 200;
  let responsePrefix = "{";
  let releaseBody = () => {};

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const stalled = stalledResponse(
      init?.signal,
      responseStatus,
      responsePrefix,
    );
    releaseBody = stalled.release;
    return Promise.resolve(stalled.response);
  }) as typeof fetch;

  try {
    const { embed } = await import("./embeddings.ts");

    const assertTimesOutByDeadline = async (label: string): Promise<void> => {
      const pending = embed(label);
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<Outcome>((resolve) => {
        deadlineTimer = setTimeout(
          () => resolve({ kind: "deadline" }),
          ASSERTION_DEADLINE_MS,
        );
      });

      try {
        const outcome = await Promise.race<Outcome>([
          pending.then(
            (value): Outcome => ({ kind: "resolved", value }),
            (error): Outcome => ({ kind: "rejected", error }),
          ),
          deadline,
        ]);

        assert(
          outcome.kind === "rejected",
          `embed() did not reject within ${ASSERTION_DEADLINE_MS}ms (got ${outcome.kind})`,
        );
        assert(
          outcome.error instanceof Error,
          `embed() rejected with a non-Error value: ${String(outcome.error)}`,
        );
        const expectedMessage =
          `Ollama embed timed out after ${FETCH_TIMEOUT_MS}ms at ${OLLAMA_URL}/api/embed`;
        assert(
          outcome.error.message === expectedMessage,
          `expected "${expectedMessage}", got "${outcome.error.message}"`,
        );
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        releaseBody();
        await pending.catch(() => undefined);
      }
    };

    await t.step("200 body stalls after headers", async () => {
      responseStatus = 200;
      responsePrefix = "{";
      await assertTimesOutByDeadline("success body stalls");
    });

    await t.step("non-2xx error body stalls after headers", async () => {
      responseStatus = 503;
      responsePrefix = "backend warming";
      await assertTimesOutByDeadline("error body stalls");
    });
  } finally {
    releaseBody();
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
