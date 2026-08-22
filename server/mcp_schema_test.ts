// Contract tests for the schemas MCP clients actually receive from tools/list
// and the validation they observe through tools/call. These intentionally use
// the SDK's registration and in-memory transport instead of asserting
// z.toJSONSchema output directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals } from "@std/assert";
import {
  asPool,
  FAKE_VECTOR,
  FakePool,
  makeDeps,
  type QueryHandler,
  type RecordingDeps,
  withEnv,
} from "./api_test_support.ts";
import { MAX_SCOPE_ID_CHARS, MAX_SEARCH_QUERY_BYTES } from "./schemas.ts";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "k".repeat(64),
  METADATA_FALLBACK_POLICY: "off",
};

const FOUND_THOUGHT_ID = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
const MISSING_THOUGHT_ID = "11111111-1111-4111-8111-111111111111";

const { createMcpServer } = await withEnv(
  [],
  TEST_ENV,
  () => import("./mcp-server.ts"),
)();

interface McpFixture {
  client: Client;
  pool: FakePool;
  deps: RecordingDeps;
}

async function withMcpFixture(
  handler: QueryHandler,
  run: (fixture: McpFixture) => Promise<void>,
): Promise<void> {
  const pool = new FakePool(handler);
  const deps = makeDeps();
  const server = createMcpServer(
    asPool(pool),
    { door: "tailnet", sub: null, tokenLabel: null },
    deps,
  );
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run({ client, pool, deps });
  } finally {
    await client.close();
    await server.close();
  }
}

Deno.test("MCP publishes server and session-lifecycle metadata", async () => {
  await withMcpFixture(() => undefined, async ({ client }) => {
    assertEquals(client.getServerVersion(), {
      name: "open-brain-homelab",
      version: "1.22.0",
    });
    const listed = await client.listTools();
    const sessionLookup = listed.tools.find((tool) =>
      tool.name === "session_lookup"
    );
    assert(
      sessionLookup?.description?.includes("effective freshness"),
      "session_lookup must publish the effective-freshness rule",
    );
    const sessionList = listed.tools.find((tool) =>
      tool.name === "session_list"
    );
    assert(
      sessionList?.description?.includes("effective freshness"),
      "session_list must publish the effective-freshness rule",
    );
    const sessionUpdateStatus = listed.tools.find((tool) =>
      tool.name === "session_update_status"
    );
    assert(
      sessionUpdateStatus?.description?.includes(
        "advances effective freshness",
      ),
      "session_update_status must publish its effective-freshness effect",
    );
    assertEquals(
      sessionUpdateStatus?.annotations?.idempotentHint,
      false,
      "session_update_status must not advertise retries as idempotent",
    );
  });
});

Deno.test("capture_thought publishes provenance and scope contracts", async () => {
  await withMcpFixture(() => undefined, async ({ client }) => {
    const listed = await client.listTools();
    const capture = listed.tools.find((tool) =>
      tool.name === "capture_thought"
    );
    assert(capture, "capture_thought must be published");
    const properties = capture.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    assert(properties, "capture_thought must publish object properties");
    const provenance = properties.provenance;
    assert(provenance, "capture_thought must publish provenance");
    assertEquals(provenance.type, "object");
    assertEquals(provenance.minProperties, 1);
    assertEquals(provenance.additionalProperties, false);
    assertEquals(
      Object.keys(provenance.properties as Record<string, unknown>).sort(),
      ["agent", "author", "branch", "repo"],
    );
    const scope = properties.scope;
    assert(scope, "capture_thought must publish scope");
    assertEquals(scope.type, "object");
    assertEquals(scope.additionalProperties, false);
    assertEquals(
      Object.keys(scope.properties as Record<string, unknown>).sort(),
      ["project_id", "visibility", "workspace_id"],
    );
    const scopeProperties = scope.properties as Record<
      string,
      Record<string, unknown>
    >;
    assertEquals(scopeProperties.workspace_id.minLength, 1);
    assertEquals(scopeProperties.workspace_id.maxLength, MAX_SCOPE_ID_CHARS);
    const projectIdString = (
      scopeProperties.project_id.anyOf as Array<Record<string, unknown>>
    ).find((variant) => variant.type === "string");
    assert(projectIdString, "project_id must publish its string alternative");
    assertEquals(projectIdString.minLength, 1);
    assertEquals(projectIdString.maxLength, MAX_SCOPE_ID_CHARS);
  });
});

Deno.test("fetch publishes and executes the thought-id contract", async () => {
  const fetchedIds: string[] = [];
  await withMcpFixture(
    (sql, params) => {
      if (!sql.includes("FROM thoughts WHERE id = $1")) return undefined;
      const id = params[0] as string;
      fetchedIds.push(id);
      return id === FOUND_THOUGHT_ID
        ? {
          rows: [{
            id,
            content: "release checklist",
            metadata: {},
            workspace_id: "default",
            project_id: null,
            visibility: "workspace",
            created_at: "2026-07-25T00:00:00Z",
            updated_at: null,
          }],
        }
        : { rows: [] };
    },
    async ({ client, pool }) => {
      const listed = await client.listTools();
      const fetch = listed.tools.find((tool) => tool.name === "fetch");
      assert(fetch, "fetch must be published");
      const properties = fetch.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(properties, "fetch must publish properties");
      assertEquals(properties.id.type, "string");
      assertEquals(properties.id.format, "uuid");
      assertEquals(fetch.inputSchema.additionalProperties, false);

      const connectionsBeforeInvalidFetches = pool.connectCalls;
      const invalidArguments: Array<Record<string, unknown>> = [
        {},
        { id: "" },
        { id: "42" },
        { id: "not-a-uuid" },
        { id: "6f6c0d3a-9a0b-4e3e-8f4a" },
        { id: 42 },
        { id: null },
      ];
      for (const args of invalidArguments) {
        const invalid = await client.callTool({
          name: "fetch",
          arguments: args,
        });
        assertEquals(invalid.isError, true);
        assert(
          JSON.stringify(invalid.content).includes("Input validation error"),
        );
      }
      assertEquals(fetchedIds, []);
      assertEquals(
        pool.connectCalls,
        connectionsBeforeInvalidFetches,
        "invalid fetch ids must fail before scope resolution or DB borrowing",
      );

      const found = await client.callTool({
        name: "fetch",
        arguments: { id: FOUND_THOUGHT_ID },
      });
      assertEquals(found.isError, undefined);
      assert(JSON.stringify(found.content).includes(FOUND_THOUGHT_ID));

      const missing = await client.callTool({
        name: "fetch",
        arguments: { id: MISSING_THOUGHT_ID },
      });
      assertEquals(missing.isError, true);
      assert(JSON.stringify(missing.content).includes("No thought found"));
      assertEquals(fetchedIds, [FOUND_THOUGHT_ID, MISSING_THOUGHT_ID]);
    },
  );
});

Deno.test("search_thoughts publishes and executes its filter contract", async () => {
  let capturedSql = "";
  let capturedParams: unknown[] = [];
  await withMcpFixture(
    (sql, params) => {
      if (!sql.includes("search_thought_candidates")) return undefined;
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          id: FOUND_THOUGHT_ID,
          content: "release checklist",
          metadata: {},
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
          created_at: "2026-07-25T00:00:00Z",
          similarity: "0.2",
          vector_rank: null,
          lexical_rank: 1,
          lexical_source_priority: 0,
        }],
      };
    },
    async ({ client, deps }) => {
      const listed = await client.listTools();
      const search = listed.tools.find((tool) =>
        tool.name === "search_thoughts"
      );
      assert(search, "search_thoughts must be published");
      const properties = search.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(properties, "search_thoughts must publish properties");
      const filter = properties.filter;
      assert(filter, "search_thoughts must publish filter");
      assertEquals(filter.type, "object");
      assertEquals(filter.minProperties, 1);
      assertEquals(filter.additionalProperties, false);
      assertEquals(
        Object.keys(filter.properties as Record<string, unknown>).sort(),
        ["exclude", "include"],
      );

      const result = await client.callTool({
        name: "search_thoughts",
        arguments: {
          query: "release checklist",
          limit: 2,
          threshold: 0.6,
          filter: {
            include: { repo: "example/open-brain" },
            exclude: { author: "release engineering", agent: "codex" },
          },
        },
      });
      assertEquals(result.isError, undefined);
      assert(
        JSON.stringify(result.content).includes("exact-text match"),
        "below-threshold lexical results must not be labeled by cosine score",
      );
      assertEquals(deps.embedCalls, ["release checklist"]);
      assertEquals(
        capturedSql.includes("memory_scope.search_thought_candidates("),
        true,
      );
      assertEquals(capturedParams, [
        `[${FAKE_VECTOR.join(",")}]`,
        0.6,
        "release checklist",
        "release checklist",
        true,
        JSON.stringify({
          provenance: { caller_asserted: { repo: "example/open-brain" } },
        }),
        JSON.stringify([
          {
            provenance: {
              caller_asserted: { author: "release engineering" },
            },
          },
          {
            provenance: { caller_asserted: { agent: "codex" } },
          },
        ]),
        50,
      ]);

      const invalidEnvelope = await client.callTool({
        name: "search_thoughts",
        arguments: {
          query: "release checklist",
          filters: { include: { author: "alice" } },
        },
      });
      assertEquals(invalidEnvelope.isError, true);
      const invalidContent = JSON.stringify(invalidEnvelope.content);
      assert(
        invalidContent.includes("Input validation error") &&
          invalidContent.includes("filters"),
        invalidContent,
      );

      const misspelledScope = await client.callTool({
        name: "search_thoughts",
        arguments: {
          query: "release checklist",
          scop: { workspace_id: "sensitive" },
        },
      });
      assertEquals(misspelledScope.isError, true);
      assert(JSON.stringify(misspelledScope.content).includes("scop"));
      assertEquals(
        deps.embedCalls,
        ["release checklist"],
        "invalid MCP envelopes must fail before embedding",
      );
    },
  );
});

Deno.test("session_search publishes bounds and rejects invalid queries", async () => {
  await withMcpFixture(() => undefined, async ({ client, pool, deps }) => {
    const listed = await client.listTools();
    const search = listed.tools.find((tool) => tool.name === "session_search");
    assert(search, "session_search must be published");
    const properties = search.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    assert(properties, "session_search must publish properties");
    assertEquals(properties.query.maxLength, MAX_SEARCH_QUERY_BYTES);
    assertEquals(properties.threshold.minimum, 0);
    assertEquals(properties.threshold.maximum, 1);
    assertEquals(properties.threshold.default, 0.5);
    assert(
      search.description?.includes("{results, truncation}"),
      "session_search must document its truncated response envelope",
    );
    assert(
      search.description?.includes("default 0.5"),
      "session_search must document its default similarity floor",
    );

    const invalidQueries = [
      "",
      "   \t\n",
      "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
      "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
    ];
    for (const query of invalidQueries) {
      const invalid = await client.callTool({
        name: "session_search",
        arguments: { query },
      });
      assertEquals(invalid.isError, true);
      assert(
        JSON.stringify(invalid.content).includes("Input validation error"),
      );
    }
    assertEquals(deps.embedCalls, []);
    assertEquals(
      pool.connectCalls,
      0,
      "invalid session queries must fail before embedding or DB borrowing",
    );
  });
});

Deno.test("session_capture rejects invalid TOML before work", async () => {
  await withMcpFixture(() => undefined, async ({ client, pool, deps }) => {
    const invalid = await client.callTool({
      name: "session_capture",
      arguments: {
        toml_text: 'title = "typed"\ntags = "not-an-array"',
      },
    });
    assertEquals(invalid.isError, true);
    assert(
      JSON.stringify(invalid.content).includes(
        "tags must be an array of strings",
      ),
    );
    assertEquals(
      pool.connectCalls,
      0,
      "schema-invalid session TOML must fail before DB borrowing",
    );
    assertEquals(
      deps.embedCalls,
      [],
      "schema-invalid session TOML must fail before embedding",
    );
  });
});

Deno.test("session_list publishes date bounds and rejects invalid dates", async () => {
  await withMcpFixture(() => undefined, async ({ client, pool }) => {
    const listed = await client.listTools();
    const sessionList = listed.tools.find((tool) =>
      tool.name === "session_list"
    );
    assert(sessionList, "session_list must be published");
    assert(
      sessionList.description?.includes("{results, truncation}"),
      "session_list must document its truncated response envelope",
    );
    const properties = sessionList.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    assert(properties, "session_list must publish properties");
    assert(
      String(properties.since.description).includes("midnight UTC"),
      "session_list must disclose date-only lower-bound expansion",
    );
    assert(
      String(properties.until.description).includes("start of that day"),
      "session_list must disclose date-only upper-bound semantics",
    );

    const invalid = await client.callTool({
      name: "session_list",
      arguments: { since: "2026-02-30" },
    });
    assertEquals(invalid.isError, true);
    assert(JSON.stringify(invalid.content).includes("Input validation error"));
    assertEquals(
      pool.connectCalls,
      0,
      "invalid session-list bounds must fail before DB borrowing",
    );
  });
});
