import { assert, assertEquals, assertRejects } from "@std/assert";
import { withEnv } from "./api_test_support.ts";
import {
  buildEmbeddingIndex,
  EmbeddingContextError,
} from "./embedding_index.ts";

Deno.test(
  "strict embedding transport and runtime identity",
  withEnv([], {
    DB_PASSWORD: "test-password",
    MCP_ACCESS_KEY: "k".repeat(64),
    METADATA_FALLBACK_POLICY: "off",
    EMBED_DIM: "2",
    FETCH_TIMEOUT_MS: "100",
  }, async () => {
    const { embed } = await import("./embeddings.ts");
    const { embeddingContract } = await import("./embedding_runtime.ts");
    const original = globalThis.fetch;
    let mode = "ok";
    let digest = "1".repeat(64);
    let captured: Record<string, unknown> = {};
    globalThis.fetch = ((url, init) => {
      if (String(url).endsWith("/version")) {
        return Promise.resolve(Response.json({ version: "fixture-1" }));
      }
      if (String(url).endsWith("/tags")) {
        return Promise.resolve(
          Response.json({
            models: [{ name: "nomic-embed-text:latest", digest }],
          }),
        );
      }
      captured = JSON.parse(init?.body as string);
      if (mode === "overflow") {
        return Promise.resolve(
          Response.json({
            error: "the input length exceeds the context length",
          }, { status: 400 }),
        );
      }
      if (mode === "other400") {
        return Promise.resolve(
          Response.json({ error: "private payload must never be returned" }, {
            status: 400,
          }),
        );
      }
      if (mode === "badJSON") {
        return Promise.resolve(new Response("private payload is not JSON"));
      }
      if (mode === "large") {
        return Promise.resolve(new Response("x".repeat(65537)));
      }
      if (mode === "stall") {
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          )
        );
      }
      return Promise.resolve(Response.json({
        embeddings: mode === "collision"
          ? [[1, 0]]
          : captured.input === "QUARTZ ZEPHYR WALRUS"
          ? [[0, 1]]
          : [[1, 0]],
      }));
    }) as typeof fetch;
    try {
      const source = "x".repeat(9000);
      assertEquals(await embed(source), [1, 0]);
      assertEquals(captured.input, source);
      assertEquals(captured.truncate, false);
      mode = "overflow";
      await assertRejects(() => embed("small"), EmbeddingContextError);
      mode = "other400";
      const other = await assertRejects(
        () => embed("small"),
        Error,
        "HTTP 400",
      );
      assert(!other.message.includes("private payload"));
      mode = "badJSON";
      await assertRejects(() => embed("small"), Error, "not valid JSON");
      mode = "large";
      await assertRejects(() => embed("small"), Error, "exceeds 65536 bytes");
      mode = "stall";
      const start = performance.now();
      await assertRejects(
        () =>
          buildEmbeddingIndex(
            "source",
            ["content"],
            embed,
            "fixture",
            performance.now() + 10,
          ),
        Error,
        "timed out",
      );
      assert(
        performance.now() - start < 200,
        "remaining document budget must bound the request",
      );
      mode = "collision";
      await assertRejects(() => embeddingContract(), Error, "canary collision");
      mode = "ok";
      const first = await embeddingContract();
      assertEquals(first.length, 64);
      digest = "2".repeat(64);
      assert(
        (await embeddingContract()) !== first,
        "model identity changes the contract even with unchanged source",
      );
    } finally {
      globalThis.fetch = original;
    }
  }),
);
