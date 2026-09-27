import { assertEquals } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

// Casing/accent invariance is a property of Nomic's uncased tokenizer. Another
// configured model may be cased, so it gets only the model-agnostic check.
Deno.test(
  "a non-Nomic model skips the uncased-tokenizer canaries",
  withEnv([], {
    DB_PASSWORD: "test-password",
    MCP_ACCESS_KEY: "k".repeat(64),
    METADATA_FALLBACK_POLICY: "off",
    EMBED_MODEL: "cased-embed",
    EMBED_DIM: "2",
    FETCH_TIMEOUT_MS: "100",
  }, async () => {
    const { embeddingContract } = await import("./embedding_runtime.ts");
    const original = globalThis.fetch;
    const inputs: string[] = [];
    globalThis.fetch = ((url, init) => {
      if (String(url).endsWith("/version")) {
        return Promise.resolve(Response.json({ version: "fixture-1" }));
      }
      if (String(url).endsWith("/tags")) {
        return Promise.resolve(
          Response.json({
            models: [{ name: "cased-embed:latest", digest: "4".repeat(64) }],
          }),
        );
      }
      const input = String(JSON.parse(init?.body as string).input);
      inputs.push(input);
      // Case-sensitive: the lowercase variant would fail the casing canary.
      return Promise.resolve(Response.json({
        embeddings: [input === "QUARTZ ZEPHYR WALRUS" ? [0, 1] : [1, 0]],
      }));
    }) as typeof fetch;
    try {
      assertEquals((await embeddingContract()).length, 64);
      assertEquals(inputs, ["QUARTZ ZEPHYR WALRUS", "BANANA ENGINE COSMOS"]);
    } finally {
      globalThis.fetch = original;
    }
  }),
);
