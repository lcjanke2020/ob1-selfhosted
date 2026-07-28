import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  MAX_MCP_TOOL_RESULT_BYTES,
  mcpJsonCollection,
  mcpJsonRecord,
  mcpText,
  mcpTextRecords,
  serializedMcpResultBytes,
} from "./mcp_result.ts";

const textOf = (result: ReturnType<typeof mcpText>) => result.content[0].text;

Deno.test("MCP result budget: ordinary text and JSON remain byte-for-byte stable", () => {
  assertEquals(mcpText("ordinary"), {
    content: [{ type: "text", text: "ordinary" }],
  });

  const rows = [{ id: 1, title: "small" }];
  const result = mcpJsonCollection(rows, {
    fullPayload: (values) => values,
    id: (row) => row.id,
    recovery: "lookup by id",
  });
  assertEquals(textOf(result), JSON.stringify(rows));
});

Deno.test("MCP result budget: text aggregation keeps whole records and recovery IDs", () => {
  const records = [
    { id: "thought-1", content: "a".repeat(100_000) },
    { id: "thought-2", content: "b".repeat(100_000) },
  ];
  const result = mcpTextRecords(records, {
    fullHeading: (total) => `Found ${total} thoughts:`,
    truncatedHeading: (included, total) =>
      `Showing ${included} of ${total} thoughts:`,
    renderRecord: (record) => `${record.id}\n${record.content}`,
    id: (record) => record.id,
    recovery: "Call fetch with each omitted ID.",
  });
  const output = textOf(result);

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertStringIncludes(output, "thought-1");
  assertStringIncludes(output, '"returned_records":1');
  assertStringIncludes(output, '"omitted_ids":["thought-2"]');
  assertFalse(output.includes("b".repeat(1_000)));
});

Deno.test("MCP result budget: serialized escaping can omit one oversized record", () => {
  const result = mcpTextRecords(
    [{ id: "quoted", content: '"'.repeat(70_000) }],
    {
      fullHeading: () => "One thought:",
      truncatedHeading: (included, total) =>
        `Showing ${included} of ${total} thoughts:`,
      renderRecord: (record) => record.content,
      id: (record) => record.id,
      recovery: "Use REST for the full record.",
    },
  );
  const output = textOf(result);

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertStringIncludes(output, '"returned_records":0');
  assertStringIncludes(output, '"omitted_ids":["quoted"]');
  assertFalse(output.includes('"'.repeat(1_000)));
});

Deno.test("MCP result budget: JSON aggregation is byte-counted for multibyte rows", () => {
  const records = [
    { id: 1, content: "é".repeat(45_000) },
    { id: 2, content: "é".repeat(45_000) },
  ];
  const result = mcpJsonCollection(records, {
    fullPayload: (values) => values,
    id: (record) => record.id,
    recovery: "Call lookup for each omitted ID.",
  });
  const payload = JSON.parse(textOf(result));

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertEquals(payload.results, [records[0]]);
  assertEquals(payload.truncation, {
    truncated: true,
    returned_records: 1,
    total_records: 2,
    omitted_records: 1,
    omitted_ids: [2],
    recovery: "Call lookup for each omitted ID.",
  });
});

Deno.test("MCP result budget: lookup drops duplicated raw TOML before prose", () => {
  const summary = "s".repeat(99_000);
  const record = {
    id: 7,
    title: "budget fixture",
    summary,
    raw_toml: `title = "budget fixture"\nsummary = "${summary}"\n`,
    artifacts: [],
  };
  const result = mcpJsonRecord(record, {
    reductions: [
      { field: "raw_toml", action: "omit" },
      { field: "summary", action: "omit" },
    ],
    recovery: "Structured fields are authoritative; use REST for raw TOML.",
  });
  const payload = JSON.parse(textOf(result));

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertEquals(payload.summary, summary);
  assertFalse("raw_toml" in payload);
  assertEquals(payload.truncation, {
    truncated: true,
    omitted_fields: ["raw_toml"],
    recovery: "Structured fields are authoritative; use REST for raw TOML.",
  });
});

Deno.test("MCP result budget: generic truncation preserves valid multibyte text", () => {
  const result = mcpText('💥"\\'.repeat(50_000));
  const output = textOf(result);

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertStringIncludes(output, "MCP result truncation");
  assertFalse(output.includes("\ud83d\n"), "must not split a surrogate pair");
});
