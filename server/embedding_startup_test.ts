import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  asPool,
  FakeClient,
  makeFakePool,
  withEnv,
} from "./api_test_support.ts";

Deno.test(
  "embedding startup preserves failures and recovers stale pooled connections",
  withEnv([], {
    DB_PASSWORD: "test-password",
    MCP_ACCESS_KEY: "k".repeat(64),
    METADATA_FALLBACK_POLICY: "off",
    EMBED_DIM: "2",
  }, async (t) => {
    const { verifyEmbeddingStartup } = await import("./embedding_startup.ts");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url, init) => {
      if (String(url).endsWith("/version")) {
        return Promise.resolve(Response.json({ version: "fixture-1" }));
      }
      if (String(url).endsWith("/tags")) {
        return Promise.resolve(Response.json({
          models: [{ name: "nomic-embed-text:latest", digest: "1".repeat(64) }],
        }));
      }
      const input = JSON.parse(init?.body as string).input;
      return Promise.resolve(Response.json({
        embeddings: input === "QUARTZ ZEPHYR WALRUS" ? [[1, 0]] : [[0, 1]],
      }));
    }) as typeof fetch;
    try {
      await t.step("reconnect before beginning on a stale client", async () => {
        const stale = new FakeClient(() => {
          throw new Error("connection reset by peer");
        }, { scriptValidation: true });
        const healthy = new FakeClient(() => undefined);
        let borrows = 0;
        const pool = asPool({
          connect: () => Promise.resolve(++borrows === 1 ? stale : healthy),
        });
        await verifyEmbeddingStartup(pool);
        assertEquals(borrows, 2);
        assertEquals(stale.endCalls, 1);
        assertEquals(stale.releaseCalls, 1);
        assertEquals(stale.queryArrayCalls.map(({ sql }) => sql), ["SELECT 1"]);
        assertEquals(healthy.releaseCalls, 1);
        assertEquals(healthy.queryArrayCalls.at(-1)?.sql, "COMMIT");
      });

      for (const failureAt of ["BEGIN", "readiness", "COMMIT"]) {
        await t.step(`preserve ${failureAt} failure`, async () => {
          const original = new Error(`${failureAt} connection reset`);
          const { pool, client } = makeFakePool((sql) => {
            if (
              sql === failureAt ||
              (failureAt === "readiness" && sql.includes("embedding_ready("))
            ) throw original;
            if (sql === "ROLLBACK") throw new Error("rollback connection lost");
          });
          const error = await assertRejects(
            () => verifyEmbeddingStartup(pool),
            Error,
            `embedding startup gate: apply db/15-embedding-index.sql`,
          );
          assertEquals(error.message.endsWith(original.message), true);
          assertStrictEquals(error.cause, original);
          assertEquals(
            client.queryArrayCalls.filter(({ sql }) => sql === "ROLLBACK")
              .length,
            failureAt === "BEGIN" ? 0 : 1,
          );
          assertEquals(client.releaseCalls, 1);
        });
      }

      await t.step(
        "pool acquisition failures retain the gate diagnostic",
        async () => {
          const original = new Error("pool unavailable");
          const pool = asPool({ connect: () => Promise.reject(original) });
          const error = await assertRejects(
            () => verifyEmbeddingStartup(pool),
            Error,
            "embedding startup gate:",
          );
          assertStrictEquals(error.cause, original);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);
