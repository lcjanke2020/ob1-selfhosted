import type { Pool } from "postgres";
import { embeddingContract } from "./embedding_runtime.ts";
import { requireEmbeddingReady } from "./embedding_queries.ts";

export async function verifyEmbeddingStartup(pool: Pool): Promise<void> {
  const contract = await embeddingContract();
  const client = await pool.connect();
  try {
    await client.queryArray("BEGIN");
    await requireEmbeddingReady(client, contract);
    await client.queryArray("COMMIT");
  } catch (error) {
    await client.queryArray("ROLLBACK");
    throw new Error(
      "embedding startup gate: apply db/15-embedding-index.sql, validate the runtime, and complete the offline backfill/cutover; " +
        (error as Error).message,
    );
  } finally {
    client.release();
  }
}
