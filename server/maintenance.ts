// Shared guards for maintenance-only operator tools (embedding_backfill.ts,
// metadata_reclassify.ts). They run with an explicitly selected PostgreSQL
// superuser connection, never the request server's app credentials.
import type { PoolClient } from "postgres";

// Forced RLS hides rows outside the installed audience even from the table
// owner, so a tool that must see every audience requires rolsuper itself.
export async function requireSuperuser(client: PoolClient, tool: string) {
  const access = await client.queryObject<{ owner: boolean }>(
    "SELECT rolsuper AS owner FROM pg_roles WHERE rolname = current_user",
  );
  if (!access.rows[0]?.owner) {
    throw new Error(
      `${tool} requires a PostgreSQL superuser (rolsuper) to include every audience; database ownership alone is insufficient`,
    );
  }
}
