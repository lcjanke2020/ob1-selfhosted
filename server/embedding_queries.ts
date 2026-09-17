import type { PoolClient } from "postgres";
import type { EmbeddingIndex } from "./embedding_index.ts";
import { UpstreamError } from "./errors.ts";

export const EMBEDDING_INDEX_UNAVAILABLE_MESSAGE =
  "embedding index unavailable: runtime/model contract differs or full-corpus backfill is incomplete; search not executed";

export async function setEmbeddingStatementTimeout(
  client: PoolClient,
): Promise<void> {
  await client.queryArray(
    "SELECT set_config('statement_timeout', '5000', true)",
  );
}

export async function requireEmbeddingReady(
  client: PoolClient,
  contract: string,
): Promise<void> {
  await setEmbeddingStatementTimeout(client);
  const result = await client.queryObject<{ ready: boolean }>(
    "SELECT memory_scope.embedding_ready($1) AS ready",
    [contract],
  );
  if (result.rows[0]?.ready !== true) {
    throw new UpstreamError(EMBEDDING_INDEX_UNAVAILABLE_MESSAGE);
  }
}

export async function putEmbeddingIndex(
  client: PoolClient,
  kind: "thought" | "session",
  id: string | number,
  index: EmbeddingIndex,
): Promise<void> {
  const table = kind === "thought"
    ? "public.thought_embedding_index"
    : "sessions.embedding_index";
  const key = kind === "thought" ? "thought_id" : "session_id";
  await client.queryArray(
    `INSERT INTO ${table} (${key}, contract, source_hash, vectors)
     VALUES ($1, $2, $3, ARRAY(SELECT value::text::vector FROM jsonb_array_elements($4::jsonb)))
     ON CONFLICT (${key}) DO UPDATE SET
       contract = EXCLUDED.contract, source_hash = EXCLUDED.source_hash, vectors = EXCLUDED.vectors`,
    [id, index.contract, index.sourceHash, JSON.stringify(index.vectors)],
  );
}
