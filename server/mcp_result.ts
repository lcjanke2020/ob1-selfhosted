// MCP-only response budgeting. Hosted connector clients document an
// approximately 150,000-character tool-result limit. Cap the serialized
// `CallToolResult` object at 120,000 UTF-8 bytes: bytes are a stricter unit for
// multibyte text, and the remaining 30,000 leaves room for JSON-RPC / transport
// framing plus client-side variance.

export const MAX_MCP_TOOL_RESULT_BYTES = 120_000;

const UTF8_ENCODER = new TextEncoder();
const TRUNCATION_HEADING = "--- MCP result truncation ---";
const GENERIC_RECOVERY =
  "Retry with a smaller limit or narrower filters, or use the corresponding REST endpoint for the full response.";

export type McpTextResult = {
  content: [{ type: "text"; text: string }];
  isError?: true;
};

export type McpCollectionTruncation = {
  truncated: true;
  returned_records: number;
  total_records: number;
  omitted_records: number;
  omitted_ids: Array<string | number>;
  recovery: string;
};

export type McpRecordTruncation = {
  truncated: true;
  omitted_fields: string[];
  recovery: string;
};

export type McpRecordReduction =
  | { field: string; action: "omit" }
  | { field: string; action: "replace"; value: unknown };

function rawTextResult(text: string, isError = false): McpTextResult {
  const result: McpTextResult = {
    content: [{ type: "text", text }],
  };
  if (isError) result.isError = true;
  return result;
}

export function serializedMcpResultBytes(result: McpTextResult): number {
  return UTF8_ENCODER.encode(JSON.stringify(result)).byteLength;
}

function fits(result: McpTextResult): boolean {
  return serializedMcpResultBytes(result) <= MAX_MCP_TOOL_RESULT_BYTES;
}

function truncationFooter(
  metadata:
    | McpCollectionTruncation
    | McpRecordTruncation
    | Record<string, unknown>,
): string {
  return `${TRUNCATION_HEADING}\n${JSON.stringify(metadata)}`;
}

function safePrefixEnd(value: string, requestedEnd: number): number {
  let end = Math.max(0, Math.min(requestedEnd, value.length));
  if (
    end > 0 && end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end--;
  }
  return end;
}

// Last-resort guard for small one-off textual responses and errors. Collection
// and lookup handlers use the record-aware helpers below so they omit complete
// records/fields instead of cutting through them.
export function mcpText(
  value: string,
  options: { isError?: boolean; recovery?: string } = {},
): McpTextResult {
  const direct = rawTextResult(value, options.isError);
  if (fits(direct)) return direct;

  const footer = truncationFooter({
    truncated: true,
    omitted: "response_tail",
    recovery: options.recovery ?? GENERIC_RECOVERY,
  });
  const delimiter = "\n\n";
  // Every UTF-16 code unit needs at least one serialized byte. Capping the
  // binary-search window avoids repeatedly encoding an arbitrarily large tail.
  let low = 0;
  let high = Math.min(value.length, MAX_MCP_TOOL_RESULT_BYTES);
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const end = safePrefixEnd(value, mid);
    const prefix = value.slice(0, end);
    const candidate = rawTextResult(
      prefix ? `${prefix}${delimiter}${footer}` : footer,
      options.isError,
    );
    if (fits(candidate)) {
      best = candidate.content[0].text;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best) return rawTextResult(best, options.isError);
  return rawTextResult(
    "MCP result exceeded the response budget; retry with a narrower request.",
    options.isError,
  );
}

export function mcpError(message: string): McpTextResult {
  return mcpText(`Error: ${message}`, {
    isError: true,
    recovery: "Retry after correcting the request or upstream failure.",
  });
}

function collectionMetadata<T>(
  records: readonly T[],
  included: number,
  id: (record: T) => string | number,
  recovery: string,
): McpCollectionTruncation {
  return {
    truncated: true,
    returned_records: included,
    total_records: records.length,
    omitted_records: records.length - included,
    omitted_ids: records.slice(included).map(id),
    recovery,
  };
}

function textSections(heading: string, records: readonly string[]): string {
  return records.length ? `${heading}\n\n${records.join("\n\n")}` : heading;
}

export function mcpTextRecords<T>(
  records: readonly T[],
  options: {
    fullHeading: (total: number) => string;
    truncatedHeading: (included: number, total: number) => string;
    renderRecord: (record: T, index: number) => string;
    id: (record: T) => string | number;
    recovery: string;
  },
): McpTextResult {
  const rendered = records.map(options.renderRecord);
  const full = rawTextResult(
    textSections(options.fullHeading(records.length), rendered),
  );
  if (fits(full)) return full;

  let best: McpTextResult | null = null;
  for (let included = 0; included <= records.length; included++) {
    const metadata = collectionMetadata(
      records,
      included,
      options.id,
      options.recovery,
    );
    const body = textSections(
      options.truncatedHeading(included, records.length),
      rendered.slice(0, included),
    );
    const candidate = rawTextResult(
      `${body}\n\n${truncationFooter(metadata)}`,
    );
    if (fits(candidate)) best = candidate;
  }

  return best ?? mcpText(
    truncationFooter(
      collectionMetadata(records, 0, options.id, options.recovery),
    ),
    { recovery: options.recovery },
  );
}

export function mcpJsonCollection<T>(
  records: readonly T[],
  options: {
    fullPayload: (records: readonly T[]) => unknown;
    truncatedPayload?: (
      included: readonly T[],
      metadata: McpCollectionTruncation,
    ) => unknown;
    id: (record: T) => string | number;
    recovery: string;
  },
): McpTextResult {
  const full = rawTextResult(JSON.stringify(options.fullPayload(records)));
  if (fits(full)) return full;

  const truncatedPayload = options.truncatedPayload ??
    ((included: readonly T[], metadata: McpCollectionTruncation) => ({
      results: included,
      truncation: metadata,
    }));
  let best: McpTextResult | null = null;
  for (let included = 0; included <= records.length; included++) {
    const metadata = collectionMetadata(
      records,
      included,
      options.id,
      options.recovery,
    );
    const candidate = rawTextResult(
      JSON.stringify(truncatedPayload(records.slice(0, included), metadata)),
    );
    if (fits(candidate)) best = candidate;
  }

  return best ?? mcpText(
    JSON.stringify({
      truncation: collectionMetadata(records, 0, options.id, options.recovery),
    }),
    { recovery: options.recovery },
  );
}

function recordMetadata(
  omittedFields: readonly string[],
  recovery: string,
): McpRecordTruncation {
  return {
    truncated: true,
    omitted_fields: [...omittedFields],
    recovery,
  };
}

export function mcpJsonRecord(
  record: object,
  options: {
    reductions: readonly McpRecordReduction[];
    recovery: string;
    identityFields?: readonly string[];
  },
): McpTextResult {
  const full = rawTextResult(JSON.stringify(record));
  if (fits(full)) return full;

  const working = Object.fromEntries(Object.entries(record));
  const omittedFields: string[] = [];
  const tryCurrent = (): McpTextResult | null => {
    const candidate = rawTextResult(JSON.stringify({
      ...working,
      truncation: recordMetadata(omittedFields, options.recovery),
    }));
    return fits(candidate) ? candidate : null;
  };

  for (const reduction of options.reductions) {
    if (!(reduction.field in working)) continue;
    if (reduction.action === "omit") delete working[reduction.field];
    else working[reduction.field] = reduction.value;
    if (!omittedFields.includes(reduction.field)) {
      omittedFields.push(reduction.field);
    }
    const candidate = tryCurrent();
    if (candidate) return candidate;
  }

  // Legacy rows can predate current input bounds. Deterministically shed any
  // remaining non-identity fields so even those rows cannot overflow MCP.
  const identityFields = new Set(options.identityFields ?? ["id"]);
  for (const field of Object.keys(working).sort()) {
    if (identityFields.has(field)) continue;
    delete working[field];
    if (!omittedFields.includes(field)) omittedFields.push(field);
    const candidate = tryCurrent();
    if (candidate) return candidate;
  }

  return mcpText(
    JSON.stringify({
      ...working,
      truncation: recordMetadata(omittedFields, options.recovery),
    }),
    { recovery: options.recovery },
  );
}
