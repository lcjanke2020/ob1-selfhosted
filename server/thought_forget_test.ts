// Hermetic tests for forget_thought / restore_thought through services.ts and
// the MCP transport. FakePool scripts the SQL the query layer emits
// (api_test_support.ts). The database-side guarantees — the restrictive
// forgotten_at policy, the live-rows fingerprint index, the SECURITY DEFINER
// helpers' visibility checks, history, and conflicts — are proven against a
// real PostgreSQL by db/forget-thoughts-smoke.sql and
// server/thought_forget_db_smoke.ts in CI.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  asPool,
  FakePool,
  makeDeps,
  type QueryHandler,
  withEnv,
} from "./api_test_support.ts";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  METADATA_FALLBACK_POLICY: "off",
};

const THOUGHT_ID = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
const OTHER_ID = "0b3d2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const FORGOTTEN_AT = "2026-10-08T12:00:00.000Z";
const OAUTH_AUTH = {
  door: "funnel" as const,
  sub: "auth0|alice",
  tokenLabel: null,
};
const NATIVE_AUTH = {
  door: "tailnet" as const,
  sub: "svc|indexer",
  tokenLabel: "indexer-2026",
};

type Call = { sql: string; params: unknown[] };

function forgetScript(outcome: "forgotten" | "unchanged" | null) {
  const calls: Call[] = [];
  const handler: QueryHandler = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("memory_scope.forget_thought(")) {
      if (!outcome) return { rows: [] };
      return {
        rows: [{
          outcome,
          revision: 1,
          forgotten_at: FORGOTTEN_AT,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
        }],
      };
    }
    return undefined;
  };
  return { calls, handler };
}

function restoreScript(
  outcome: "restored" | "unchanged" | "conflict" | null,
) {
  const calls: Call[] = [];
  const handler: QueryHandler = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("memory_scope.restore_thought(")) {
      if (!outcome) return { rows: [] };
      return {
        rows: [{
          outcome,
          conflict_thought_id: outcome === "conflict" ? OTHER_ID : null,
          revision: outcome === "conflict" ? null : 2,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
        }],
      };
    }
    return undefined;
  };
  return { calls, handler };
}

Deno.test("forget/restore thought (services + MCP)", async (t) => {
  await withEnv([], TEST_ENV, async () => {
    const {
      ConflictError,
      forgetThoughtInScope,
      restoreThoughtInScope,
      ValidationError,
    } = await import("./services.ts");
    const { createMcpServer } = await import("./mcp-server.ts");

    await t.step(
      "forget: installs the CURRENT scope and passes the verified door and token label, never a subject",
      async () => {
        const { calls, handler } = forgetScript("forgotten");
        const out = await forgetThoughtInScope(asPool(new FakePool(handler)), {
          id: THOUGHT_ID,
          auth: NATIVE_AUTH,
        });
        assertEquals(out, {
          outcome: "forgotten",
          revision: 1,
          forgotten_at: FORGOTTEN_AT,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
        });
        const settings = calls.find((c) =>
          c.sql.includes("set_config('openbrain.workspace_id'")
        )!;
        assertEquals(settings.params, [
          "default",
          "",
          "svc|indexer",
          "personal,workspace",
        ]);
        const forget = calls.find((c) =>
          c.sql.includes("memory_scope.forget_thought(")
        )!;
        assertEquals(forget.params, [THOUGHT_ID, "tailnet", "indexer-2026"]);
      },
    );

    await t.step(
      "forget: invisible id → null; unchanged passes through; malformed id never reaches the database",
      async () => {
        assertEquals(
          await forgetThoughtInScope(
            asPool(new FakePool(forgetScript(null).handler)),
            { id: THOUGHT_ID, auth: OAUTH_AUTH },
          ),
          null,
        );
        const unchanged = await forgetThoughtInScope(
          asPool(new FakePool(forgetScript("unchanged").handler)),
          { id: THOUGHT_ID, auth: OAUTH_AUTH },
        );
        assertEquals(unchanged?.outcome, "unchanged");

        const { calls, handler } = forgetScript("forgotten");
        await assertRejects(
          () =>
            forgetThoughtInScope(asPool(new FakePool(handler)), {
              id: "not-a-uuid",
              auth: OAUTH_AUTH,
            }),
          ValidationError,
        );
        assertEquals(calls.length, 0);
      },
    );

    await t.step(
      "restore: conflict → ConflictError naming the live copy; unchanged and null pass through",
      async () => {
        const { calls, handler } = restoreScript("restored");
        const out = await restoreThoughtInScope(asPool(new FakePool(handler)), {
          id: THOUGHT_ID,
          auth: OAUTH_AUTH,
        });
        assertEquals(out?.outcome, "restored");
        assertEquals(out?.revision, 2);
        const restore = calls.find((c) =>
          c.sql.includes("memory_scope.restore_thought(")
        )!;
        assertEquals(restore.params, [THOUGHT_ID, "funnel", null]);

        const err = await assertRejects(
          () =>
            restoreThoughtInScope(
              asPool(new FakePool(restoreScript("conflict").handler)),
              { id: THOUGHT_ID, auth: OAUTH_AUTH },
            ),
          ConflictError,
        );
        assert(err.message.includes(OTHER_ID));

        assertEquals(
          (await restoreThoughtInScope(
            asPool(new FakePool(restoreScript("unchanged").handler)),
            { id: THOUGHT_ID, auth: OAUTH_AUTH },
          ))?.outcome,
          "unchanged",
        );
        assertEquals(
          await restoreThoughtInScope(
            asPool(new FakePool(restoreScript(null).handler)),
            { id: THOUGHT_ID, auth: OAUTH_AUTH },
          ),
          null,
        );
      },
    );

    await t.step(
      "MCP publishes both tools with explicit contracts and executes them",
      async () => {
        const forget = forgetScript("forgotten");
        const restore = restoreScript("conflict");
        const pool = new FakePool((sql, params) =>
          sql.includes("restore_thought(")
            ? restore.handler(sql, params)
            : forget.handler(sql, params)
        );
        const server = createMcpServer(asPool(pool), OAUTH_AUTH, makeDeps());
        const client = new Client({ name: "forget-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport
          .createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const listed = await client.listTools();

          const forgetTool = listed.tools.find((tool) =>
            tool.name === "forget_thought"
          );
          assert(forgetTool, "forget_thought must be published");
          assertEquals(forgetTool.inputSchema.required, ["id"]);
          assertEquals(forgetTool.inputSchema.additionalProperties, false);
          assertEquals(forgetTool.annotations?.readOnlyHint, false);
          // Removes the thought from every reader's recall: not additive,
          // even though restore_thought can bring it back.
          assertEquals(forgetTool.annotations?.destructiveHint, true);
          assertEquals(forgetTool.annotations?.idempotentHint, true);
          assert(forgetTool.description?.includes("NOT erasure"));

          const restoreTool = listed.tools.find((tool) =>
            tool.name === "restore_thought"
          );
          assert(restoreTool, "restore_thought must be published");
          assertEquals(restoreTool.inputSchema.required, ["id"]);
          assertEquals(restoreTool.annotations?.readOnlyHint, false);
          assertEquals(restoreTool.annotations?.destructiveHint, false);
          assertEquals(restoreTool.annotations?.idempotentHint, true);

          const forgotten = await client.callTool({
            name: "forget_thought",
            arguments: { id: THOUGHT_ID },
          });
          const forgottenText =
            (forgotten.content as { text: string }[])[0].text;
          assertEquals(forgotten.isError ?? false, false, forgottenText);
          assertEquals(JSON.parse(forgottenText), {
            id: THOUGHT_ID,
            outcome: "forgotten",
            revision: 1,
            forgotten_at: FORGOTTEN_AT,
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
          });

          const conflicted = await client.callTool({
            name: "restore_thought",
            arguments: { id: THOUGHT_ID },
          });
          assertEquals(conflicted.isError, true);
          assert(
            (conflicted.content as { text: string }[])[0].text.includes(
              OTHER_ID,
            ),
          );

          // A misspelled envelope key is rejected, never stripped.
          const rejected = await client.callTool({
            name: "forget_thought",
            arguments: { id: THOUGHT_ID, scop: { workspace_id: "default" } },
          });
          assertEquals(rejected.isError, true);
        } finally {
          await client.close();
          await server.close();
        }
      },
    );
  })();
});
