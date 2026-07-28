// End-to-end MCP transport coverage for the result budget. The pure helper
// tests pin byte accounting; this suite proves every read-handler family is
// actually routed through it while the underlying services stay unchanged.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals, assertFalse } from "@std/assert";
import { asPool, FakePool, makeDeps } from "./api_test_support.ts";
import { MAX_MCP_TOOL_RESULT_BYTES } from "./mcp_result.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
];

const THOUGHT_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const LARGE_THOUGHTS = ["a".repeat(100_000), "b".repeat(100_000)];
const LARGE_SESSION_TITLES = ["c".repeat(80_000), "d".repeat(80_000)];

function resultText(result: unknown): string {
  const parsed = result as {
    content: Array<{ type: string; text?: string }>;
  };
  assertEquals(parsed.content[0]?.type, "text");
  assert(typeof parsed.content[0].text === "string");
  return parsed.content[0].text;
}

function assertWithinBudget(result: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  assert(
    bytes <= MAX_MCP_TOOL_RESULT_BYTES,
    `${bytes} serialized bytes exceeded ${MAX_MCP_TOOL_RESULT_BYTES}`,
  );
}

Deno.test("MCP read tools enforce one serialized result budget", async () => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");

  try {
    const { createMcpServer } = await import("./mcp-server.ts");
    const summary = "s".repeat(99_000);
    const rawToml = `title = "budget fixture"\nsummary = "${summary}"\n`;
    const pool = new FakePool((sql) => {
      if (sql.includes("search_thought_candidates")) {
        return {
          rows: THOUGHT_IDS.map((id, index) => ({
            id,
            content: LARGE_THOUGHTS[index],
            metadata: {},
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
            created_at: "2026-07-28T00:00:00Z",
            similarity: "0.9",
            vector_rank: index + 1,
            lexical_rank: null,
            lexical_source_priority: null,
          })),
        };
      }
      if (sql.includes("FROM thoughts WHERE id = $1")) {
        return {
          rows: [{
            id: THOUGHT_IDS[0],
            content: LARGE_THOUGHTS[0],
            metadata: {},
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
            created_at: "2026-07-28T00:00:00Z",
            updated_at: "2026-07-28T00:00:00Z",
          }],
        };
      }
      if (
        sql.includes("FROM thoughts") && sql.includes("ORDER BY created_at")
      ) {
        return {
          rows: THOUGHT_IDS.map((id, index) => ({
            id,
            content: LARGE_THOUGHTS[index],
            metadata: {},
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
            created_at: `2026-07-2${8 - index}T00:00:00Z`,
            updated_at: null,
          })),
        };
      }
      if (
        sql.includes("1 - (embedding") &&
        sql.includes("FROM sessions.session")
      ) {
        return {
          rows: LARGE_SESSION_TITLES.map((title, index) => ({
            id: BigInt(11 + index),
            session_id: null,
            title,
            status: "active",
            last_update: "2026-07-28T00:00:00Z",
            score: "0.9",
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
          })),
        };
      }
      if (
        sql.includes(
          "SELECT id, session_id, title, status, repo_url, branch, last_update",
        )
      ) {
        return {
          rows: LARGE_SESSION_TITLES.map((title, index) => ({
            id: BigInt(11 + index),
            session_id: null,
            title,
            status: "active",
            repo_url: null,
            branch: null,
            last_update: "2026-07-28T00:00:00Z",
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
          })),
        };
      }
      if (sql.includes("FROM sessions.session WHERE id = $1")) {
        return {
          rows: [{
            id: 7n,
            session_id: null,
            title: "budget fixture",
            session_date: null,
            goal: null,
            agent: null,
            agent_version: null,
            harness: null,
            machine: null,
            working_dir: null,
            repo_url: null,
            branch: null,
            head: null,
            worktree: null,
            started_at: null,
            last_update: null,
            ended_at: null,
            status: "active",
            tags: [],
            linked_issues: [],
            related_sessions: [],
            next_actions: [],
            blockers: [],
            resume_context: null,
            summary,
            source: "tailnet",
            source_node: null,
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
            raw_toml: rawToml,
            content_hash: "fixture-hash",
            created_at: "2026-07-28T00:00:00Z",
            updated_at: "2026-07-28T00:00:00Z",
          }],
        };
      }
      if (sql.includes("FROM sessions.artifact")) return { rows: [] };
      return undefined;
    });
    const server = createMcpServer(
      asPool(pool),
      { door: "tailnet", sub: null },
      makeDeps(),
    );
    const client = new Client({ name: "budget-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const compatibilitySearch = await client.callTool({
        name: "search",
        arguments: { query: "budget" },
      });
      assertWithinBudget(compatibilitySearch);
      assertFalse(
        "truncation" in JSON.parse(resultText(compatibilitySearch)),
        "small compatibility search metadata must remain unchanged",
      );

      const fetch = await client.callTool({
        name: "fetch",
        arguments: { id: THOUGHT_IDS[0] },
      });
      assertWithinBudget(fetch);
      assertEquals(JSON.parse(resultText(fetch)).text.length, 100_000);

      for (
        const [name, args] of [
          ["search_thoughts", { query: "budget", limit: 2 }],
          ["list_thoughts", { limit: 2 }],
        ] as const
      ) {
        const result = await client.callTool({ name, arguments: args });
        assertWithinBudget(result);
        const output = resultText(result);
        assert(output.includes('"returned_records":1'));
        assert(output.includes(`"omitted_ids":["${THOUGHT_IDS[1]}"]`));
        assertFalse(output.includes("b".repeat(1_000)));
      }

      const lookup = await client.callTool({
        name: "session_lookup",
        arguments: { id: 7 },
      });
      assertWithinBudget(lookup);
      const lookupPayload = JSON.parse(resultText(lookup));
      assertEquals(lookupPayload.summary, summary);
      assertFalse("raw_toml" in lookupPayload);
      assertEquals(lookupPayload.truncation.omitted_fields, ["raw_toml"]);

      for (
        const [name, args] of [
          ["session_search", { query: "budget", limit: 2 }],
          ["session_list", { limit: 2 }],
        ] as const
      ) {
        const result = await client.callTool({ name, arguments: args });
        assertWithinBudget(result);
        const payload = JSON.parse(resultText(result));
        assertEquals(payload.results.length, 1);
        assertEquals(payload.truncation.omitted_ids, [12]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const [key, value] of origEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
