// Pool-safety tests for transaction-local audience state.

import { assertEquals, assertRejects } from "@std/assert";
import type { Pool } from "postgres";
import { withScopeClient } from "./scoped_db.ts";
import type { ResolvedReadScope } from "./scope_contract.ts";

const SCOPE: ResolvedReadScope = {
  workspaceId: "sensitive",
  projectId: null,
  visibilities: ["personal"],
  principal: "auth0|alice",
};

class RecordingClient {
  statements: Array<{ sql: string; params: unknown[] }> = [];
  releases = 0;

  queryArray(sql: string, params: unknown[] = []) {
    this.statements.push({ sql: sql.trim(), params });
    return Promise.resolve({ rows: [] });
  }

  release() {
    this.releases++;
  }
}

function asPool(client: RecordingClient): Pool {
  return {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;
}

Deno.test("withScopeClient commits transaction-local audience state before release", async () => {
  const client = new RecordingClient();
  const result = await withScopeClient(
    asPool(client),
    SCOPE,
    async (borrowed) => {
      await borrowed.queryArray("SELECT 42");
      return "ok";
    },
  );

  assertEquals(result, "ok");
  assertEquals(client.statements.map(({ sql }) => sql), [
    "SELECT 1",
    "BEGIN",
    "SELECT\n         set_config('openbrain.workspace_id', $1::text, true),\n         set_config('openbrain.project_id', $2::text, true),\n         set_config('openbrain.principal', $3::text, true),\n         set_config('openbrain.visibilities', $4::text, true)",
    "SELECT 42",
    "COMMIT",
  ]);
  assertEquals(client.statements[2].params, [
    "sensitive",
    "",
    "auth0|alice",
    "personal",
  ]);
  assertEquals(client.releases, 1);
});

Deno.test("withScopeClient rolls back failed work before pooled release", async () => {
  const client = new RecordingClient();
  await assertRejects(
    () =>
      withScopeClient(asPool(client), SCOPE, () => {
        throw new Error("operation failed");
      }),
    Error,
    "operation failed",
  );

  assertEquals(client.statements.map(({ sql }) => sql), [
    "SELECT 1",
    "BEGIN",
    "SELECT\n         set_config('openbrain.workspace_id', $1::text, true),\n         set_config('openbrain.project_id', $2::text, true),\n         set_config('openbrain.principal', $3::text, true),\n         set_config('openbrain.visibilities', $4::text, true)",
    "ROLLBACK",
  ]);
  assertEquals(client.releases, 1);
});
