// Contract test for the schema that MCP clients actually receive from
// tools/list. This intentionally goes through the SDK's registration and
// in-memory transport instead of asserting z.toJSONSchema output directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals } from "@std/assert";
import { asPool, FAKE_VECTOR, FakePool, makeDeps } from "./api_test_support.ts";
import { MAX_SEARCH_QUERY_BYTES } from "./schemas.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "METADATA_FALLBACK_POLICY",
];

const FOUND_THOUGHT_ID = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
const MISSING_THOUGHT_ID = "11111111-1111-4111-8111-111111111111";

Deno.test("MCP publishes and executes the shared thought contracts", async () => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");

  try {
    const { createMcpServer } = await import("./mcp-server.ts");
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const fetchedIds: string[] = [];
    const pool = new FakePool((sql, params) => {
      if (sql.includes("search_thought_candidates")) {
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
      }
      if (sql.includes("FROM thoughts WHERE id = $1")) {
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
      }
      return undefined;
    });
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
      const sessionListTool = listed.tools.find((tool) =>
        tool.name === "session_list"
      );
      assert(
        sessionListTool?.description?.includes("effective freshness"),
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
        Object.keys(
          provenance.properties as Record<string, unknown>,
        ).sort(),
        ["agent", "author", "branch", "repo"],
      );
      const captureScope = properties.scope;
      assert(captureScope, "capture_thought must publish scope");
      assertEquals(captureScope.type, "object");
      assertEquals(captureScope.additionalProperties, false);
      assertEquals(
        Object.keys(captureScope.properties as Record<string, unknown>).sort(),
        ["project_id", "visibility", "workspace_id"],
      );

      const search = listed.tools.find((tool) =>
        tool.name === "search_thoughts"
      );
      assert(search, "search_thoughts must be published");
      const searchProperties = search.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(searchProperties, "search_thoughts must publish properties");
      const filter = searchProperties.filter;
      assert(filter, "search_thoughts must publish filter");
      assertEquals(filter.type, "object");
      assertEquals(filter.minProperties, 1);
      assertEquals(filter.additionalProperties, false);
      assertEquals(
        Object.keys(filter.properties as Record<string, unknown>).sort(),
        ["exclude", "include"],
      );

      const fetch = listed.tools.find((tool) => tool.name === "fetch");
      assert(fetch, "fetch must be published");
      const fetchProperties = fetch.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(fetchProperties, "fetch must publish properties");
      assertEquals(fetchProperties.id.type, "string");
      assertEquals(fetchProperties.id.format, "uuid");
      assertEquals(fetch.inputSchema.additionalProperties, false);

      const connectionsBeforeInvalidFetches = pool.connectCalls;
      const invalidFetchArguments: Array<Record<string, unknown>> = [
        {},
        { id: "" },
        { id: "42" },
        { id: "not-a-uuid" },
        { id: "6f6c0d3a-9a0b-4e3e-8f4a" },
        { id: 42 },
        { id: null },
      ];
      for (const args of invalidFetchArguments) {
        const invalidFetch = await client.callTool({
          name: "fetch",
          arguments: args,
        });
        assertEquals(invalidFetch.isError, true);
        assert(
          JSON.stringify(invalidFetch.content).includes(
            "Input validation error",
          ),
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
      assertEquals(
        deps.embedCalls,
        ["release checklist"],
        "invalid MCP envelope must fail before embedding",
      );

      const misspelledScope = await client.callTool({
        name: "search_thoughts",
        arguments: {
          query: "release checklist",
          scop: { workspace_id: "sensitive" },
        },
      });
      assertEquals(misspelledScope.isError, true);
      assert(
        JSON.stringify(misspelledScope.content).includes("scop"),
      );
      assertEquals(
        deps.embedCalls,
        ["release checklist"],
        "misspelled scope must fail before embedding",
      );

      const sessionSearch = listed.tools.find((tool) =>
        tool.name === "session_search"
      );
      assert(sessionSearch, "session_search must be published");
      const sessionSearchProperties = sessionSearch.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(sessionSearchProperties, "session_search must publish properties");
      assertEquals(
        sessionSearchProperties.query.maxLength,
        MAX_SEARCH_QUERY_BYTES,
      );
      assertEquals(sessionSearchProperties.threshold.minimum, 0);
      assertEquals(sessionSearchProperties.threshold.maximum, 1);
      assertEquals(sessionSearchProperties.threshold.default, 0.5);
      assert(
        sessionSearch.description?.includes("{results, truncation}"),
        "session_search must document its truncated response envelope",
      );
      assert(
        sessionSearch.description?.includes("default 0.5"),
        "session_search must document its default similarity floor",
      );

      const connectionsBeforeInvalidCapture = pool.connectCalls;
      const invalidSessionCapture = await client.callTool({
        name: "session_capture",
        arguments: {
          toml_text: 'title = "typed"\ntags = "not-an-array"',
        },
      });
      assertEquals(invalidSessionCapture.isError, true);
      assert(
        JSON.stringify(invalidSessionCapture.content).includes(
          "tags must be an array of strings",
        ),
      );
      assertEquals(
        pool.connectCalls,
        connectionsBeforeInvalidCapture,
        "schema-invalid session TOML must fail before scope resolution or DB borrowing",
      );
      assertEquals(
        deps.embedCalls,
        ["release checklist"],
        "schema-invalid session TOML must fail before embedding",
      );

      const sessionList = listed.tools.find((tool) =>
        tool.name === "session_list"
      );
      assert(sessionList, "session_list must be published");
      assert(
        sessionList.description?.includes("{results, truncation}"),
        "session_list must document its truncated response envelope",
      );
      const sessionListProperties = sessionList.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(sessionListProperties, "session_list must publish properties");
      assert(
        String(sessionListProperties.since.description).includes(
          "midnight UTC",
        ),
        "session_list must disclose date-only lower-bound expansion",
      );
      assert(
        String(sessionListProperties.until.description).includes(
          "start of that day",
        ),
        "session_list must disclose date-only upper-bound semantics",
      );

      const connectionsBeforeInvalidList = pool.connectCalls;
      const invalidSessionList = await client.callTool({
        name: "session_list",
        arguments: { since: "2026-02-30" },
      });
      assertEquals(invalidSessionList.isError, true);
      assert(
        JSON.stringify(invalidSessionList.content).includes(
          "Input validation error",
        ),
      );
      assertEquals(
        pool.connectCalls,
        connectionsBeforeInvalidList,
        "invalid session-list bounds must fail before DB borrowing",
      );

      const invalidSessionQueries = [
        "",
        "   \t\n",
        "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
        "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
      ];
      for (const query of invalidSessionQueries) {
        const invalidSessionSearch = await client.callTool({
          name: "session_search",
          arguments: { query },
        });
        assertEquals(invalidSessionSearch.isError, true);
        assert(
          JSON.stringify(invalidSessionSearch.content).includes(
            "Input validation error",
          ),
        );
      }
      assertEquals(
        deps.embedCalls,
        ["release checklist"],
        "invalid session queries must fail before embedding",
      );
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
