import type { Pool, PoolClient } from "postgres";
import { getClient } from "./db_pool.ts";
import { embeddingContract } from "./embedding_runtime.ts";
import { requireEmbeddingReady } from "./embedding_queries.ts";

export async function verifyEmbeddingStartup(pool: Pool): Promise<void> {
  const contract = await embeddingContract();
  let client: PoolClient | undefined;
  let transactionOpen = false;
  try {
    client = await getClient(pool);
    await client.queryArray("BEGIN");
    transactionOpen = true;
    await requireEmbeddingReady(client, contract);
    await client.queryArray("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.queryArray("ROLLBACK");
      } catch { /* preserve the original startup/transaction failure */ }
    }
    throw new Error(
      "embedding startup gate: apply db/15-embedding-index.sql, validate the runtime, and complete the offline backfill/cutover; " +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  } finally {
    client?.release();
  }
}
