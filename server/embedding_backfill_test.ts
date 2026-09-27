import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
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

const BACKFILL_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  METADATA_FALLBACK_POLICY: "off",
};
const NOMIC = {
  model: "nomic-embed-text:latest",
  digest: "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f",
};

Deno.test(
  "embedding contracts ignore the runtime; legacy contracts keep the 1.28 hash",
  withEnv([], BACKFILL_ENV, async () => {
    const { contractFor, legacyContractFor } = await import(
      "./embedding_runtime.ts"
    );
    // Generations activated by server 1.28 with the pinned Nomic manifest.
    assertEquals(
      await legacyContractFor(NOMIC, "0.34.1"),
      "ab5681147ac1b45f65f99c175c86de9a75899fa8f6ce405aad7c0f464adb9c28",
    );
    assertEquals(
      await legacyContractFor(NOMIC, "0.30.10"),
      "446f0dfb63e42b83b13334306ecc9944a7f7647cbf484d7c9d43c664349a53df",
    );
    const pinned = { runtime: "0.34.1", ...NOMIC };
    const upgraded = { runtime: "0.99.0", ...NOMIC };
    const current = await contractFor(pinned);
    assertEquals(await contractFor(upgraded), current);
    assertNotEquals(await legacyContractFor(NOMIC, "0.34.1"), current);
    assertNotEquals(
      await contractFor({ ...NOMIC, digest: "1".repeat(64) }),
      current,
    );
  }),
);

Deno.test(
  "embedding backfill --rebuild re-embeds rows whose contract already matches",
  withEnv([], BACKFILL_ENV, async () => {
    const { backfillEmbeddingIndex } = await import("./embedding_backfill.ts");
    const { sourceHash } = await import("./embedding_index.ts");
    const hash = await sourceHash("complete source");
    for (const rebuild of [false, true]) {
      const client = new FakeClient((sql, params) => {
        if (sql.includes("rolsuper AS owner")) {
          return { rows: [{ owner: true }] };
        }
        if (sql.includes("FROM public.thoughts t")) {
          return {
            rows: params[0] === null
              ? [{
                id: "fixture",
                content: "complete source",
                contract: "fixture-contract",
                source_hash: hash,
              }]
              : [],
          };
        }
        if (sql.includes("FROM sessions.session t")) return { rows: [] };
        if (sql.includes("embedding_ready(")) {
          return { rows: [{ ready: true }] };
        }
        if (
          sql.startsWith("INSERT INTO public.thought_embedding_index") ||
          sql.startsWith("LOCK TABLE ") ||
          sql.startsWith("UPDATE memory_scope.embedding_generation ")
        ) return { rows: [] };
      });
      await backfillEmbeddingIndex(
        client as unknown as PoolClient,
        true,
        {
          contract: () => Promise.resolve("fixture-contract"),
          embed: () => Promise.resolve([1, 0]),
        },
        { rebuild },
      );
      assertEquals(
        client.queryArrayCalls.filter(({ sql }) =>
          sql.startsWith("INSERT INTO public.thought_embedding_index")
        ).length,
        rebuild ? 1 : 0,
      );
    }
  }),
);

Deno.test(
  "embedding backfill arguments",
  withEnv([], BACKFILL_ENV, async () => {
    const { parseBackfillArgs } = await import("./embedding_backfill.ts");
    assertEquals(parseBackfillArgs([]), {
      apply: false,
      rebuild: false,
      relabel: undefined,
    });
    assertEquals(parseBackfillArgs(["--rebuild", "--apply"]), {
      apply: true,
      rebuild: true,
      relabel: undefined,
    });
    assertEquals(parseBackfillArgs(["--apply", "--relabel", "auto"]), {
      apply: true,
      rebuild: false,
      relabel: "auto",
    });
    assertEquals(parseBackfillArgs(["--relabel", "0.34.1"]), {
      apply: false,
      rebuild: false,
      relabel: "0.34.1",
    });
    for (
      const bad of [
        ["--relabel"],
        ["--relabel", "--apply"],
        ["--relabel", "0.34.1", "--rebuild"],
        ["--relabel", "0.34.1 --apply"],
        ["--apply", "--apply"],
        ["--force"],
      ]
    ) assertThrows(() => parseBackfillArgs(bad), Error, "usage:");
  }),
);

Deno.test(
  "relabel converts a proven 1.28 generation without re-embedding",
  withEnv([], BACKFILL_ENV, async (t) => {
    const { relabelEmbeddingGeneration } = await import(
      "./embedding_backfill.ts"
    );
    const { contractFor, legacyContractFor } = await import(
      "./embedding_runtime.ts"
    );
    const { sourceHash } = await import("./embedding_index.ts");
    const identity = { runtime: "0.35.0", ...NOMIC };
    const current = await contractFor(identity);
    const legacy = await legacyContractFor(NOMIC, "0.34.1");
    const hash = await sourceHash("stored thought");
    const deps = (runtimeIdentity = identity) => ({
      contract: () => contractFor(runtimeIdentity),
      identity: () => Promise.resolve(runtimeIdentity),
      embed: () => Promise.resolve([1, 0]),
    });
    const fixture = (
      active: string | null,
      stored: number[] = [2, 0],
      failAt?: string,
    ) => {
      let generation = active;
      return new FakeClient((sql, params) => {
        const compact = sql.replace(/\s+/g, " ").trim();
        if (failAt && compact.startsWith(failAt)) {
          throw new Error("relabel fixture failure");
        }
        if (compact.includes("rolsuper AS owner")) {
          return { rows: [{ owner: true }] };
        }
        if (
          compact.startsWith(
            "SELECT contract FROM memory_scope.embedding_generation",
          )
        ) return { rows: [{ contract: generation }] };
        if (compact.includes("embedding_ready(")) {
          return { rows: [{ ready: params[0] === generation }] };
        }
        if (compact.includes("FROM public.thought_embedding_index i JOIN")) {
          return {
            rows: [{
              content: "stored thought",
              source_hash: hash,
              vector: JSON.stringify(stored),
            }],
          };
        }
        if (compact.includes("FROM sessions.embedding_index i JOIN")) {
          return { rows: [] };
        }
        if (
          compact.startsWith("LOCK TABLE ") ||
          compact.startsWith("UPDATE public.thought_embedding_index ") ||
          compact.startsWith("UPDATE sessions.embedding_index ")
        ) return { rows: [] };
        if (compact.startsWith("UPDATE memory_scope.embedding_generation ")) {
          generation = params[0] as string;
          return { rows: [] };
        }
      });
    };
    const writes = (client: FakeClient) =>
      client.queryArrayCalls.filter(({ sql }) => sql !== "SELECT 1");
    const run = (
      client: FakeClient,
      previous: string,
      apply: boolean,
      runtimeIdentity = identity,
    ) =>
      relabelEmbeddingGeneration(
        client as unknown as PoolClient,
        previous,
        apply,
        deps(runtimeIdentity),
      );

    await t.step(
      "plan proves the previous runtime and writes nothing",
      async () => {
        const client = fixture(legacy);
        await run(client, "0.34.1", false);
        assertEquals(writes(client), []);
      },
    );

    await t.step("apply relabels in one locked transaction", async () => {
      const client = fixture(legacy);
      await run(client, "auto", true);
      assertEquals(writes(client).map(({ sql }) => sql), [
        "BEGIN",
        "LOCK TABLE public.thoughts, sessions.session, public.thought_embedding_index, sessions.embedding_index IN SHARE MODE",
        "UPDATE public.thought_embedding_index SET contract = $1 WHERE contract = $2",
        "UPDATE sessions.embedding_index SET contract = $1 WHERE contract = $2",
        "UPDATE memory_scope.embedding_generation SET contract = $1 WHERE singleton",
        "COMMIT",
      ]);
      for (const call of writes(client).slice(2, 4)) {
        assertEquals(call.params, [current, legacy]);
      }
      // Idempotent: a second run finds the generation already current.
      const again = fixture(current);
      await run(again, "auto", true);
      assertEquals(writes(again), []);
    });

    await t.step("an unproven previous runtime is refused", async () => {
      const client = fixture(legacy);
      await assertRejects(
        () => run(client, "0.33.0", true),
        Error,
        "did not produce the activated generation",
      );
      assertEquals(writes(client), []);
    });

    await t.step("a different model manifest matches no runtime", async () => {
      const client = fixture(legacy);
      await assertRejects(
        () =>
          run(client, "auto", true, { ...identity, digest: "1".repeat(64) }),
        Error,
        "no enumerated runtime version",
      );
      assertEquals(writes(client), []);
    });

    await t.step("drifted stored vectors are refused", async () => {
      const client = fixture(legacy, [0, 1]);
      await assertRejects(
        () => run(client, "0.34.1", true),
        Error,
        "differ from the current runtime",
      );
      assertEquals(writes(client), []);
    });

    await t.step("an inactive generation needs the backfill", async () => {
      const client = fixture(null);
      await assertRejects(
        () => run(client, "auto", true),
        Error,
        "no activated generation",
      );
    });

    await t.step("a failed label update rolls back", async () => {
      const client = fixture(legacy, [2, 0], "UPDATE sessions.embedding_index");
      await assertRejects(
        () => run(client, "0.34.1", true),
        Error,
        "relabel fixture failure",
      );
      const sql = writes(client).map((call) => call.sql);
      assertEquals(sql.filter((s) => s === "ROLLBACK").length, 1);
      assert(!sql.includes("COMMIT"));
      assert(
        !sql.some((s) =>
          s.startsWith("UPDATE memory_scope.embedding_generation")
        ),
      );
    });
  }),
);
