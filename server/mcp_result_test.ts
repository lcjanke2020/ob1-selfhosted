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

Deno.test("MCP result budget: exact serialized boundary fits and one byte over truncates", () => {
  const envelopeBytes = serializedMcpResultBytes(mcpText(""));
  const exactText = "x".repeat(MAX_MCP_TOOL_RESULT_BYTES - envelopeBytes);
  const exact = mcpText(exactText);

  assertEquals(textOf(exact), exactText);
  assertEquals(serializedMcpResultBytes(exact), MAX_MCP_TOOL_RESULT_BYTES);

  const oneOver = mcpText(`${exactText}x`);
  assert(serializedMcpResultBytes(oneOver) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertFalse(textOf(oneOver) === `${exactText}x`);
  assertStringIncludes(textOf(oneOver), "MCP result truncation");
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

Deno.test("MCP result budget: maximum-cardinality collection work stays linear", () => {
  const records = Array.from(
    { length: 200 },
    (_, index) => ({ id: index + 1, content: "x".repeat(1_000) }),
  );
  let jsonIdCalls = 0;
  const jsonResult = mcpJsonCollection(records, {
    fullPayload: (values) => values,
    id: (record) => {
      jsonIdCalls++;
      return record.id;
    },
    recovery: "Call lookup for each omitted ID.",
  });
  const jsonPayload = JSON.parse(textOf(jsonResult));

  assertEquals(jsonIdCalls, records.length);
  assert(jsonPayload.results.length > 0);
  assert(jsonPayload.results.length < records.length);
  assert(serializedMcpResultBytes(jsonResult) <= MAX_MCP_TOOL_RESULT_BYTES);

  let textIdCalls = 0;
  let renderCalls = 0;
  const textResult = mcpTextRecords(records, {
    fullHeading: (total) => `${total} records:`,
    truncatedHeading: (included, total) =>
      `Showing ${included} of ${total} records:`,
    renderRecord: (record) => {
      renderCalls++;
      return `${record.id}: ${record.content}`;
    },
    id: (record) => {
      textIdCalls++;
      return record.id;
    },
    recovery: "Call fetch for each omitted ID.",
  });

  assertEquals(renderCalls, records.length);
  assertEquals(textIdCalls, records.length);
  assertStringIncludes(textOf(textResult), '"truncated":true');
  assert(serializedMcpResultBytes(textResult) <= MAX_MCP_TOOL_RESULT_BYTES);
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

Deno.test("MCP result budget: lookup restores metadata after reducing oversized text", () => {
  const metadata = { topics: ["budgeting"], type: "observation" };
  const result = mcpJsonRecord({
    id: "thought-1",
    text: '"'.repeat(70_000),
    metadata,
  }, {
    reductions: [
      { field: "metadata", action: "replace", value: {} },
      { field: "text", action: "replace", value: "[text omitted]" },
    ],
    recovery: "Use the fully scoped REST path.",
  });
  const payload = JSON.parse(textOf(result));

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertEquals(payload.metadata, metadata);
  assertEquals(payload.text, "[text omitted]");
  assertEquals(payload.truncation.omitted_fields, ["text"]);
});

Deno.test("MCP result budget: generic truncation preserves valid multibyte text", () => {
  const result = mcpText('💥"\\'.repeat(50_000));
  const output = textOf(result);

  assert(serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES);
  assertStringIncludes(output, "MCP result truncation");
  assertFalse(output.includes("\ud83d\n"), "must not split a surrogate pair");
});
