import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { PoolClient } from "postgres";
import { FakeClient, withEnv } from "./api_test_support.ts";

Deno.test(
  "embedding backfill preserves the first failure when rollback also fails",
  withEnv([], {
    DB_PASSWORD: "test-password",
    MCP_ACCESS_KEY: "k".repeat(64),
    METADATA_FALLBACK_POLICY: "off",
  }, async (t) => {
    const { backfillEmbeddingIndex } = await import("./embedding_backfill.ts");
    for (
      const failureAt of [
        "index write",
        "index commit",
        "activation readiness",
        "activation commit",
      ]
    ) {
      await t.step(failureAt, async () => {
        const original = new Error(`${failureAt} connection reset`);
        const rowFailure = failureAt.startsWith("index");
        const client = new FakeClient((sql, params) => {
          if (sql.includes("rolsuper AS owner")) {
            return { rows: [{ owner: true }] };
          }
          if (sql.includes("FROM public.thoughts t")) {
            return {
              rows: rowFailure && params[0] === null
                ? [{ id: "fixture", content: "complete source" }]
                : [],
            };
          }
          if (sql.includes("FROM sessions.session t")) return { rows: [] };
          if (
            (failureAt === "index write" &&
              sql.startsWith("INSERT INTO public.thought_embedding_index")) ||
            (failureAt.endsWith("commit") && sql === "COMMIT") ||
            (failureAt === "activation readiness" &&
              sql.includes("embedding_ready("))
          ) throw original;
          if (sql === "ROLLBACK") throw new Error("rollback connection lost");
          if (
            sql.startsWith("LOCK TABLE ") ||
            sql.startsWith("UPDATE memory_scope.embedding_generation ")
          ) return { rows: [] };
        });
        const error = await assertRejects(() =>
          backfillEmbeddingIndex(client as unknown as PoolClient, true, {
            contract: () => Promise.resolve("fixture-contract"),
            embed: () => Promise.resolve([1, 0]),
          })
        );
        assertStrictEquals(error, original);
        assertEquals(
          client.queryArrayCalls.filter(({ sql }) => sql === "ROLLBACK").length,
          1,
        );
        if (rowFailure) {
          assertEquals(
            client.queryArrayCalls.some(({ sql }) =>
              sql.startsWith("UPDATE memory_scope.embedding_generation ")
            ),
            false,
            "a failed row must stop before generation activation",
          );
        }
      });
    }
  }),
);
