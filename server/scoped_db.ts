// Transaction wrapper that installs the resolved audience for PostgreSQL RLS.
// Kept separate from scope.ts so low-level query modules and their pure tests do
// not import environment-driven configuration merely to use the DB helper.

import type { Pool, PoolClient } from "postgres";
import { getClient } from "./db_pool.ts";
import type { ResolvedReadScope } from "./scope_contract.ts";

export async function withScopeClient<T>(
  pool: Pool,
  scope: ResolvedReadScope,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient(pool);
  let transactionOpen = false;
  try {
    await client.queryArray("BEGIN");
    transactionOpen = true;
    await client.queryArray(
      `SELECT
         set_config('openbrain.workspace_id', $1::text, true),
         set_config('openbrain.project_id', $2::text, true),
         set_config('openbrain.principal', $3::text, true),
         set_config('openbrain.visibilities', $4::text, true)`,
      [
        scope.workspaceId,
        scope.projectId ?? "",
        scope.principal ?? "",
        scope.visibilities.join(","),
      ],
    );
    const result = await operation(client);
    await client.queryArray("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.queryArray("ROLLBACK");
      } catch { /* surface the original operation/transaction error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
