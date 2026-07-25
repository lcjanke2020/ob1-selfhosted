// Contract test for the schema that MCP clients actually receive from
// tools/list. This intentionally goes through the SDK's registration and
// in-memory transport instead of asserting z.toJSONSchema output directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals } from "@std/assert";
import type { Pool } from "postgres";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
];

Deno.test("MCP tools/list advertises non-empty strict provenance claims", async () => {
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
    // tools/list only inspects registrations, so no pool method is invoked.
    const server = createMcpServer({} as Pool, {
      door: "tailnet",
      sub: null,
    });
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
