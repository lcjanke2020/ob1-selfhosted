// Maintenance-only operator tool. Default is read-only planning. --apply
// requires an offline corpus and the database owner; never use app credentials
// or turn this into an automatically run migration.
import { Pool, type PoolClient } from "postgres";
import { DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER } from "./config.ts";
import { embeddingContract } from "./embedding_runtime.ts";
import {
  buildEmbeddingIndex,
  type EmbedOne,
  MAX_EMBEDDING_DURATION_MS,
  sourceHash,
} from "./embedding_index.ts";
import { embed } from "./embeddings.ts";
import { putEmbeddingIndex } from "./embedding_queries.ts";

export async function backfillEmbeddingIndex(
  client: PoolClient,
  apply = false,
  deps: { contract: typeof embeddingContract; embed: EmbedOne } = {
    contract: embeddingContract,
    embed,
  },
): Promise<void> {
  const access = await client.queryObject<{ owner: boolean }>(
    "SELECT rolsuper AS owner FROM pg_roles WHERE rolname = current_user",
  );
  if (!access.rows[0]?.owner) {
    throw new Error(
      "backfill requires the corpus database owner/superuser to include every audience",
    );
  }
  const contract = await deps.contract();
  console.log(JSON.stringify({ mode: apply ? "apply" : "plan", contract }));
  // Cursor-style keyset batches avoid loading the corpus or all vectors into
  // memory. One row's complete vectors are built before opening its write tx.
  for (const kind of ["thought", "session"] as const) {
    let after: string | number | null = null;
    let checked = 0;
    let rebuilt = 0;
    while (true) {
      const table = kind === "thought" ? "public.thoughts" : "sessions.session";
      const indexTable = kind === "thought"
        ? "public.thought_embedding_index"
        : "sessions.embedding_index";
      const key = kind === "thought" ? "thought_id" : "session_id";
      const type = kind === "thought" ? "uuid" : "bigint";
      const projection = kind === "thought"
        ? "t.content"
        : "t.title, t.goal, t.summary, t.resume_context";
      const result = await client.queryObject<Record<string, unknown>>(
        `SELECT t.id::text AS id, ${projection}, i.contract, i.source_hash FROM ${table} t
         LEFT JOIN ${indexTable} i ON i.${key} = t.id
         WHERE ($1::${type} IS NULL OR t.id > $1::${type}) ORDER BY t.id LIMIT 1`,
        [after],
      );
      const row = result.rows[0];
      if (!row) break;
      const id = row.id as string;
      after = id;
      const fields = kind === "thought"
        ? ["content"]
        : ["title", "goal", "summary", "resume_context"];
      const source = fields.map((field) => row[field] ?? "").join(
        kind === "thought" ? "" : "\u0000",
      );
      const hash = await sourceHash(source);
      checked++;
      if (row.contract === contract && row.source_hash === hash) continue;
      rebuilt++;
      if (!apply) continue;
      const deadline = performance.now() + MAX_EMBEDDING_DURATION_MS;
      const index = await buildEmbeddingIndex(
        source,
        fields,
        deps.embed,
        contract,
        deadline,
      );
      if (await deps.contract({ deadline }) !== contract) {
        throw new Error(
          "runtime/model changed; backfill stopped before this write",
        );
      }
      await client.queryArray("BEGIN");
      try {
        // The index trigger locks the parent and rechecks the full source
        // hash; concurrent edits cannot install a stale index.
        await putEmbeddingIndex(client, kind, id, index);
        await client.queryArray("COMMIT");
      } catch (error) {
        await client.queryArray("ROLLBACK");
        throw error;
      }
    }
    console.log(
      JSON.stringify({
        kind,
        checked,
        [apply ? "rebuilt" : "needs_rebuild"]: rebuilt,
      }),
    );
  }
  if (apply) {
    if (await deps.contract() !== contract) {
      throw new Error("runtime/model changed; generation not activated");
    }
    await client.queryArray("BEGIN");
    try {
      await client.queryArray(
        "LOCK TABLE public.thoughts, sessions.session IN SHARE MODE",
      );
      await client.queryArray(
        "UPDATE memory_scope.embedding_generation SET contract = $1 WHERE singleton",
        [contract],
      );
      const ready = await client.queryObject<{ ready: boolean }>(
        "SELECT memory_scope.embedding_ready($1) AS ready",
        [contract],
      );
      if (!ready.rows[0]?.ready) {
        throw new Error("incomplete corpus; generation not activated");
      }
      await client.queryArray("COMMIT");
      console.log(JSON.stringify({ activated: contract }));
    } catch (error) {
      await client.queryArray("ROLLBACK");
      throw error;
    }
  }
}

if (import.meta.main) {
  const apply = Deno.args.length === 1 && Deno.args[0] === "--apply";
  if (Deno.args.length && !apply) {
    throw new Error("usage: embedding_backfill.ts [--apply]");
  }
  const pool = new Pool({
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  }, 1);
  const client = await pool.connect();
  try {
    await backfillEmbeddingIndex(client, apply);
  } finally {
    client.release();
    await pool.end();
  }
}
