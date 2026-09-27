// Runs only in the disposable corpus CI fixture, after the embedding index
// smoke has activated a generation. Captures its own single- and two-passage
// records through the real service, rewrites the corpus labels to a server
// 1.28 (runtime-inclusive) generation, then proves the real relabel tool
// converts it without re-embedding. The reverse relabel is executed verbatim
// from docs/embedding-limits.md, including its not-ready refusal.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool, type PoolClient } from "postgres";
const hostname = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
assertEquals(hostname, "127.0.0.1");
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const password = Deno.env.get("OPENBRAIN_APP_PASSWORD")!;
Deno.env.set("DB_PASSWORD", password);
Deno.env.set("MCP_ACCESS_KEY", "relabel-ci-only-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");
const { relabelEmbeddingGeneration } = await import("./embedding_backfill.ts");
const { captureThoughtWithMetadata } = await import("./services.ts");
const { contractFor, legacyContractFor } = await import(
  "./embedding_runtime.ts"
);
const { buildEmbeddingIndex } = await import("./embedding_index.ts");
const adminPool = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "postgres",
  password: Deno.env.get("POSTGRES_PASSWORD"),
}, 1);
const appPool = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "openbrain_app",
  password,
}, 1);
const admin = await adminPool.connect();
const identity = {
  runtime: "0.35.0",
  model: "nomic-embed-text:latest",
  digest: "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f",
};
const legacy = await legacyContractFor(identity, "0.34.1");
const current = await contractFor(identity);

const generation = async () =>
  (await admin.queryObject<{ contract: string | null }>(
    "SELECT contract FROM memory_scope.embedding_generation WHERE singleton",
  )).rows[0]?.contract ?? null;
const ready = async (client: PoolClient, contract: string) =>
  (await client.queryObject<{ ready: boolean }>(
    "SELECT memory_scope.embedding_ready($1) AS ready",
    [contract],
  )).rows[0]?.ready;
// Fixture setup and cleanup relabel (the documented reverse runs below).
const relabelSql = async (from: string, to: string) => {
  await admin.queryArray("BEGIN");
  try {
    await admin.queryArray(
      "LOCK TABLE public.thoughts, sessions.session, public.thought_embedding_index, sessions.embedding_index IN SHARE MODE",
    );
    for (
      const table of [
        "public.thought_embedding_index",
        "sessions.embedding_index",
      ]
    ) {
      await admin.queryArray(
        `UPDATE ${table} SET contract = $1 WHERE contract = $2`,
        [to, from],
      );
    }
    await admin.queryArray(
      "UPDATE memory_scope.embedding_generation SET contract = $1 WHERE singleton AND contract = $2",
      [to, from],
    );
    assertEquals(await ready(admin, to), true);
    await admin.queryArray("COMMIT");
  } catch (error) {
    await admin.queryArray("ROLLBACK");
    throw error;
  }
};
// The reverse relabel exactly as documented, minus psql meta-commands, with
// its psql variables substituted. Parameterless text runs as one simple query.
const docs = await Deno.readTextFile(
  new URL("../docs/embedding-limits.md", import.meta.url),
);
const reverseBlock = docs
  .slice(docs.indexOf("## Upgrading a 1.28 generation to 1.29"))
  .match(/```sql\n([\s\S]*?)```/)?.[1];
assert(reverseBlock, "documented reverse relabel block");
const documentedReverse = async (legacyLabel: string, currentLabel: string) => {
  const sql = reverseBlock.split("\n").filter((line) => !line.startsWith("\\"))
    .join("\n").replaceAll(":'legacy'", `'${legacyLabel}'`)
    .replaceAll(":'current'", `'${currentLabel}'`);
  assert(!sql.includes(":'"), "every documented psql variable is substituted");
  try {
    await admin.queryArray(sql);
  } catch (error) {
    await admin.queryArray("ROLLBACK");
    throw error;
  }
};
// Fresh embeddings reproduce every stored passage exactly, as an unchanged
// model/runtime would; `drift` models a runtime that moved vectors.
const stored = new Map<string, string>();
const deps = (drift = false) => ({
  contract: () => contractFor(identity),
  identity: () => Promise.resolve(identity),
  embed: (text: string) => {
    const vector = stored.get(text);
    if (!vector) throw new Error("relabel sampled an unexpected passage");
    const values = JSON.parse(vector) as number[];
    // A rotated vector is orthogonal to a basis-vector fixture passage.
    return Promise.resolve(
      drift ? [values.at(-1)!, ...values.slice(0, -1)] : values,
    );
  },
});
const reports = async (run: () => Promise<void>) => {
  const lines: Record<string, unknown>[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(JSON.parse(line));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines;
};

const original = await generation();
assert(original, "the index smoke must leave an activated generation");
assertEquals(await ready(admin, original), true);
const workspace = "relabel-smoke";
try {
  await admin.queryArray(
    "INSERT INTO memory_scope.workspace(id,default_visibility,personal_only) VALUES ($1,'workspace',false) ON CONFLICT DO NOTHING",
    [workspace],
  );
  const capture = (content: string) =>
    captureThoughtWithMetadata(appPool, {
      content,
      scope: { workspace_id: workspace, visibility: "workspace" },
      auth: { door: "funnel", sub: "relabel-smoke", tokenLabel: null },
      via: "rest",
    }, {
      contract: () => Promise.resolve(original),
      embed: () =>
        Promise.resolve(
          Array.from({ length: 768 }, (_, i) => i === 3 ? 1 : 0),
        ),
      extractMetadata: () =>
        Promise.resolve({
          metadata: {},
          classifier: {
            schema_version: 1 as const,
            endpoint: "stub" as const,
          },
          degradation_events: [],
        }),
    });
  const short = await capture("relabel smoke single passage");
  // Over the 4096-unit initial target, so the index holds two passages.
  await capture("relabel smoke two passages ".repeat(200));
  await runRelabel(original, String(short.id));
} finally {
  await admin.queryArray("DELETE FROM thoughts WHERE workspace_id=$1", [
    workspace,
  ]);
  await admin.queryArray("DELETE FROM memory_scope.workspace WHERE id=$1", [
    workspace,
  ]);
  const now = await generation();
  if (now && now !== original) await relabelSql(now, original);
  assertEquals(await generation(), original);
  assertEquals(await ready(admin, original), true);
  admin.release();
  await Promise.all([adminPool.end(), appPool.end()]);
}
console.log("embedding relabel smoke passed");

async function runRelabel(activated: string, shortId: string) {
  // Map every stored passage's exact text to its vector by rebuilding each
  // record's passages with a recording embedder.
  for (const kind of ["thought", "session"] as const) {
    const rows = (await admin.queryObject<Record<string, unknown>>(
      kind === "thought"
        ? `SELECT t.content, (SELECT jsonb_agg(v::text ORDER BY n)
             FROM unnest(i.vectors) WITH ORDINALITY AS u(v, n)) AS vectors
           FROM public.thought_embedding_index i
           JOIN public.thoughts t ON t.id = i.thought_id`
        : `SELECT s.title, s.goal, s.summary, s.resume_context,
             (SELECT jsonb_agg(v::text ORDER BY n)
              FROM unnest(i.vectors) WITH ORDINALITY AS u(v, n)) AS vectors
           FROM sessions.embedding_index i
           JOIN sessions.session s ON s.id = i.session_id`,
    )).rows;
    for (const row of rows) {
      const source = kind === "thought"
        ? String(row.content)
        : [row.title, row.goal, row.summary, row.resume_context]
          .map((field) => field ?? "").join("\u0000");
      const passages: string[] = [];
      await buildEmbeddingIndex(
        source,
        ["fixture"],
        (text) => {
          passages.push(text);
          return Promise.resolve([1]);
        },
        "fixture",
        performance.now() + 15_000,
      );
      const vectors = row.vectors as string[];
      assertEquals(passages.length, vectors.length);
      passages.forEach((text, i) => stored.set(text, vectors[i]));
    }
  }
  const multi = await admin.queryObject<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.thought_embedding_index
     WHERE cardinality(vectors) > 1`,
  );
  assert(
    multi.rows[0].n > 0,
    "the fixture must include a multi-passage thought",
  );

  // A server 1.28 generation built by runtime 0.34.1 with the pinned manifest.
  await relabelSql(activated, legacy);

  await assertRejects(
    () => relabelEmbeddingGeneration(admin, "0.34.1", true, deps(true)),
    Error,
    "differ from the current runtime",
  );
  assertEquals(await generation(), legacy, "a refused relabel changes nothing");

  const [plan] = await reports(() =>
    relabelEmbeddingGeneration(admin, "auto", false, deps())
  );
  assertEquals(plan.previous_runtime, "0.34.1");
  assertEquals(plan.from, legacy);
  assertEquals(plan.to, current);
  assert((plan.sampled as { thought: number }).thought > 0);
  assert((plan.passages_compared as number) > 0);
  assertEquals(plan.uncovered, []);
  assertEquals(plan.min_cosine, 1);
  assertEquals(await generation(), legacy, "the plan writes nothing");

  const applied = await reports(() =>
    relabelEmbeddingGeneration(admin, "0.34.1", true, deps())
  );
  assertEquals(applied.at(-1), { relabeled: current });
  assertEquals(await generation(), current);
  const labels = async (contract: string) =>
    (await admin.queryObject<{ n: number }>(
      `SELECT (SELECT count(*) FROM public.thought_embedding_index WHERE contract <> $1)::int +
              (SELECT count(*) FROM sessions.embedding_index WHERE contract <> $1)::int AS n`,
      [contract],
    )).rows[0].n;
  assertEquals(await labels(current), 0);
  const app = await appPool.connect();
  try {
    assertEquals(await ready(app, current), true);
    assertEquals(await ready(app, legacy), false);
  } finally {
    app.release();
  }
  const [again] = await reports(() =>
    relabelEmbeddingGeneration(admin, "auto", true, deps())
  );
  assertEquals(again.relabel, "already_current");

  // The documented reverse must refuse an incomplete corpus: nothing commits.
  await admin.queryArray(
    "DELETE FROM public.thought_embedding_index WHERE thought_id = $1",
    [shortId],
  );
  await assertRejects(() => documentedReverse(legacy, current));
  assertEquals(
    await generation(),
    current,
    "a refused reverse commits nothing",
  );
  assertEquals(await labels(current), 0);
  await admin.queryArray("DELETE FROM thoughts WHERE id = $1", [shortId]);

  // On a complete corpus it restores the 1.28 label.
  await documentedReverse(legacy, current);
  assertEquals(await generation(), legacy);
  assertEquals(await labels(legacy), 0);
  assertEquals(await ready(admin, legacy), true);
}
