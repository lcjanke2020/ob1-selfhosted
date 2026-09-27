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
    let version = "fixture-1";
    let digest = "1".repeat(64);
    let canaryRuns = 0;
    let captured: Record<string, unknown> = {};
    // A correct uncased runtime lowercases and strips accents; the defect
    // modes skip one of those steps.
    const tokens = (input: string) => {
      const lowered = mode === "cased" ? input : input.toLowerCase();
      return mode === "accented"
        ? lowered
        : lowered.normalize("NFD").replace(/\p{M}/gu, "");
    };
    globalThis.fetch = ((url, init) => {
      if (String(url).endsWith("/version")) {
        return Promise.resolve(Response.json({ version }));
      }
      if (String(url).endsWith("/tags")) {
        return Promise.resolve(
          Response.json({
            models: [{ name: "nomic-embed-text:latest", digest }],
          }),
        );
      }
      captured = JSON.parse(init?.body as string);
      if (captured.input === "QUARTZ ZEPHYR WALRUS") canaryRuns++;
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
      const key = tokens(String(captured.input));
      return Promise.resolve(Response.json({
        embeddings: mode === "collision"
          ? [[1, 0]]
          : key === "quartz zephyr walrus"
          ? [[0, 1]]
          : key === "QUARTZ ZEPHYR WALRUS"
          ? [[0.8, 0.6]]
          : key.includes("café")
          ? [[0.6, 0.8]]
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
      const validated = canaryRuns;
      assertEquals(await embeddingContract(), first);
      assertEquals(canaryRuns, validated, "a validated runtime is not rerun");

      // An unmanaged runtime upgrade keeps the contract (and the corpus)
      // usable; only the canary reruns for the newly observed version.
      version = "fixture-2";
      assertEquals(await embeddingContract(), first);
      assertEquals(canaryRuns, validated + 1);

      // A later swap to a proven-defective build fails closed, including at a
      // job's end-of-work identity check, without forgetting the good build.
      version = "fixture-3";
      mode = "collision";
      await assertRejects(() => embeddingContract(), Error, "canary collision");
      version = "fixture-2";
      mode = "ok";
      const beforeReturn = canaryRuns;
      assertEquals(await embeddingContract(), first);
      assertEquals(canaryRuns, beforeReturn);

      // The uncased model's casing and accent invariants are proven defects
      // too, checked for every newly observed version.
      version = "fixture-cased";
      mode = "cased";
      await assertRejects(() => embeddingContract(), Error, "casing canary");
      version = "fixture-accented";
      mode = "accented";
      await assertRejects(() => embeddingContract(), Error, "accent canary");
      version = "fixture-2";
      mode = "ok";
      assertEquals(await embeddingContract(), first);

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

Deno.test(
  "a runtime swap during the canary never validates an untested version",
  withEnv([], {
    DB_PASSWORD: "test-password",
    MCP_ACCESS_KEY: "k".repeat(64),
    METADATA_FALLBACK_POLICY: "off",
    EMBED_DIM: "2",
    FETCH_TIMEOUT_MS: "100",
  }, async () => {
    const { embeddingContract } = await import("./embedding_runtime.ts");
    const original = globalThis.fetch;
    // The runtime actually serving requests; a broken build collides.
    let serving = { version: "good-x", broken: false };
    let swapOnEmbed: typeof serving | undefined;
    globalThis.fetch = ((url, init) => {
      if (String(url).endsWith("/version")) {
        return Promise.resolve(Response.json({ version: serving.version }));
      }
      if (String(url).endsWith("/tags")) {
        return Promise.resolve(
          Response.json({
            models: [{
              name: "nomic-embed-text:latest",
              digest: "3".repeat(64),
            }],
          }),
        );
      }
      if (swapOnEmbed) {
        serving = swapOnEmbed;
        swapOnEmbed = undefined;
      }
      const key = String(JSON.parse(init?.body as string).input)
        .toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      return Promise.resolve(Response.json({
        embeddings: [
          serving.broken || key !== "quartz zephyr walrus" ? [1, 0] : [0, 1],
        ],
      }));
    }) as typeof fetch;
    try {
      await embeddingContract();
      // The identity read sees broken-y, but good-z serves the canary pair.
      serving = { version: "broken-y", broken: true };
      swapOnEmbed = { version: "good-z", broken: false };
      await embeddingContract();
      // broken-y was never tested, so its return must rerun the canary.
      serving = { version: "broken-y", broken: true };
      await assertRejects(() => embeddingContract(), Error, "canary collision");
    } finally {
      globalThis.fetch = original;
    }
  }),
);
