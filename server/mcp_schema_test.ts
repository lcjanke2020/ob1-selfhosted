// Contract test for the schema that MCP clients actually receive from
// tools/list. This intentionally goes through the SDK's registration and
// in-memory transport instead of asserting z.toJSONSchema output directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals } from "@std/assert";
import { asPool, FAKE_VECTOR, FakePool, makeDeps } from "./api_test_support.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
];

Deno.test("MCP publishes and executes the thought provenance contracts", async () => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));

  try {
    const { createMcpServer } = await import("./mcp-server.ts");
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = new FakePool((sql, params) => {
      if (sql.includes("FROM thoughts")) {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [{
            id: "uuid-1",
            content: "release checklist",
            metadata: {},
            created_at: "2026-07-25T00:00:00Z",
            similarity: "0.9",
            vector_rank: 1,
            lexical_rank: 1,
          }],
        };
      }
      return undefined;
    });
    const deps = makeDeps();
    const server = createMcpServer(
      asPool(pool),
      { door: "tailnet", sub: null },
      deps,
    );
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport
      .createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
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
        Object.keys(
          provenance.properties as Record<string, unknown>,
        ).sort(),
        ["agent", "author", "branch", "repo"],
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
      assertEquals(deps.embedCalls, ["release checklist"]);
      assertEquals(capturedSql.includes("metadata @> $5::jsonb"), true);
      assertEquals(
        capturedSql.includes("NOT (metadata @> $6::jsonb)"),
        true,
      );
      assertEquals(
        capturedSql.includes("NOT (metadata @> $7::jsonb)"),
        true,
      );
      assertEquals(capturedParams, [
        `[${FAKE_VECTOR.join(",")}]`,
        0.6,
        "release checklist",
        "release checklist",
        JSON.stringify({
          provenance: { caller_asserted: { repo: "example/open-brain" } },
        }),
        JSON.stringify({
          provenance: {
            caller_asserted: { author: "release engineering" },
          },
        }),
        JSON.stringify({
          provenance: { caller_asserted: { agent: "codex" } },
        }),
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
