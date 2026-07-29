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

const EMPTY_TEXT_RESULT_BYTES = serializedMcpResultBytes(rawTextResult(""));

// JSON.stringify is the exact transformation the outer CallToolResult applies
// to text content. Removing the surrounding quotes leaves a byte count that is
// additive across our generated sections (all joins use ASCII separators, so a
// surrogate pair can never straddle a section boundary).
function serializedTextContentBytes(value: string): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength - 2;
}

function textResultBytes(contentBytes: number): number {
  return EMPTY_TEXT_RESULT_BYTES + contentBytes;
}

function jsonValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("MCP result values must be JSON-serializable.");
  }
  return serialized;
}

function joinedPrefixContentBytes(
  values: readonly string[],
  separator: string,
): number[] {
  const separatorBytes = serializedTextContentBytes(separator);
  const prefixes = new Array<number>(values.length + 1).fill(0);
  for (let index = 0; index < values.length; index++) {
    prefixes[index + 1] = prefixes[index] +
      (index > 0 ? separatorBytes : 0) +
      serializedTextContentBytes(values[index]);
  }
  return prefixes;
}

function joinedSuffixContentBytes(
  values: readonly string[],
  separator: string,
): number[] {
  const separatorBytes = serializedTextContentBytes(separator);
  const suffixes = new Array<number>(values.length + 1).fill(0);
  for (let index = values.length - 1; index >= 0; index--) {
    suffixes[index] = serializedTextContentBytes(values[index]) +
      (index + 1 < values.length ? separatorBytes + suffixes[index + 1] : 0);
  }
  return suffixes;
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

function collectionMetadata(
  ids: readonly (string | number)[],
  included: number,
  recovery: string,
): McpCollectionTruncation {
  return {
    truncated: true,
    returned_records: included,
    total_records: ids.length,
    omitted_records: ids.length - included,
    omitted_ids: ids.slice(included),
    recovery,
  };
}

function collectionMetadataJson(
  serializedIds: readonly string[],
  included: number,
  recovery: string,
): string {
  const total = serializedIds.length;
  return `{"truncated":true,"returned_records":${included},` +
    `"total_records":${total},"omitted_records":${total - included},` +
    `"omitted_ids":[${serializedIds.slice(included).join(",")}],` +
    `"recovery":${jsonValue(recovery)}}`;
}

function collectionMetadataContentBytes(
  serializedIds: readonly string[],
  omittedIdSuffixBytes: readonly number[],
  included: number,
  recoveryTail: string,
): number {
  const total = serializedIds.length;
  const prefix = `{"truncated":true,"returned_records":${included},` +
    `"total_records":${total},"omitted_records":${total - included},` +
    `"omitted_ids":[`;
  return serializedTextContentBytes(prefix) + omittedIdSuffixBytes[included] +
    serializedTextContentBytes(recoveryTail);
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

  const ids = records.map(options.id);
  const serializedIds = ids.map(jsonValue);
  const renderedPrefixBytes = joinedPrefixContentBytes(rendered, "\n\n");
  const omittedIdSuffixBytes = joinedSuffixContentBytes(serializedIds, ",");
  const sectionSeparatorBytes = serializedTextContentBytes("\n\n");
  const footerHeadingBytes = serializedTextContentBytes(
    `${TRUNCATION_HEADING}\n`,
  );
  const recoveryTail = `],"recovery":${jsonValue(options.recovery)}}`;

  // Scan only integer byte totals. Each record and ID is serialized exactly
  // once above; this remains O(total serialized input + record count), even at
  // the schema maximum. Do not consider `records.length`: the direct all-record
  // representation already failed, and a truncation envelope with zero omitted
  // records would be misleading.
  let bestIncluded = -1;
  for (let included = 0; included < records.length; included++) {
    const headingBytes = serializedTextContentBytes(
      options.truncatedHeading(included, records.length),
    );
    const bodyBytes = headingBytes +
      (included > 0
        ? sectionSeparatorBytes + renderedPrefixBytes[included]
        : 0);
    const metadataBytes = collectionMetadataContentBytes(
      serializedIds,
      omittedIdSuffixBytes,
      included,
      recoveryTail,
    );
    const candidateBytes = textResultBytes(
      bodyBytes + sectionSeparatorBytes + footerHeadingBytes + metadataBytes,
    );
    if (candidateBytes <= MAX_MCP_TOOL_RESULT_BYTES) bestIncluded = included;
  }

  if (bestIncluded >= 0) {
    const body = textSections(
      options.truncatedHeading(bestIncluded, records.length),
      rendered.slice(0, bestIncluded),
    );
    const metadataJson = collectionMetadataJson(
      serializedIds,
      bestIncluded,
      options.recovery,
    );
    const candidate = rawTextResult(
      `${body}\n\n${TRUNCATION_HEADING}\n${metadataJson}`,
    );
    if (fits(candidate)) return candidate;
  }

  return mcpText(
    truncationFooter(
      collectionMetadata(ids, 0, options.recovery),
    ),
    { recovery: options.recovery },
  );
}

export function mcpJsonCollection<T>(
  records: readonly T[],
  options: {
    fullPayload: (records: readonly T[]) => unknown;
    id: (record: T) => string | number;
    recovery: string;
  },
): McpTextResult {
  const full = rawTextResult(jsonValue(options.fullPayload(records)));
  if (fits(full)) return full;

  const ids = records.map(options.id);
  const serializedIds = ids.map(jsonValue);
  const serializedRecords = records.map(jsonValue);
  const recordPrefixBytes = joinedPrefixContentBytes(serializedRecords, ",");
  const omittedIdSuffixBytes = joinedSuffixContentBytes(serializedIds, ",");
  const resultsPrefixBytes = serializedTextContentBytes(`{"results":[`);
  const truncationSeparatorBytes = serializedTextContentBytes(
    `],"truncation":`,
  );
  const payloadEndBytes = serializedTextContentBytes("}");
  const recoveryTail = `],"recovery":${jsonValue(options.recovery)}}`;

  let bestIncluded = -1;
  for (let included = 0; included < records.length; included++) {
    const metadataBytes = collectionMetadataContentBytes(
      serializedIds,
      omittedIdSuffixBytes,
      included,
      recoveryTail,
    );
    const candidateBytes = textResultBytes(
      resultsPrefixBytes + recordPrefixBytes[included] +
        truncationSeparatorBytes + metadataBytes + payloadEndBytes,
    );
    if (candidateBytes <= MAX_MCP_TOOL_RESULT_BYTES) bestIncluded = included;
  }

  if (bestIncluded >= 0) {
    const metadataJson = collectionMetadataJson(
      serializedIds,
      bestIncluded,
      options.recovery,
    );
    const payload = `{"results":[${
      serializedRecords.slice(0, bestIncluded).join(",")
    }],"truncation":${metadataJson}}`;
    const candidate = rawTextResult(payload);
    if (fits(candidate)) return candidate;
  }

  return mcpText(
    JSON.stringify({
      truncation: collectionMetadata(ids, 0, options.recovery),
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
  const applied: Array<{
    reduction: McpRecordReduction;
    originalValue: unknown;
  }> = [];
  const omittedFields = (): string[] =>
    applied.map(({ reduction }) => reduction.field);
  const tryCurrent = (): McpTextResult | null => {
    const candidate = rawTextResult(JSON.stringify({
      ...working,
      truncation: recordMetadata(omittedFields(), options.recovery),
    }));
    return fits(candidate) ? candidate : null;
  };

  const applyReduction = (reduction: McpRecordReduction): void => {
    if (reduction.action === "omit") delete working[reduction.field];
    else working[reduction.field] = reduction.value;
  };

  // Reductions are ordered from least to most valuable. Once a combination
  // fits, restore applied fields in reverse order whenever exact byte accounting
  // permits it. This avoids needlessly discarding metadata (or structured
  // session prose) just because a later, larger field was the true offender.
  const restoreWhatFits = (initial: McpTextResult): McpTextResult => {
    let best = initial;
    for (let index = applied.length - 1; index >= 0; index--) {
      const [entry] = applied.splice(index, 1);
      working[entry.reduction.field] = entry.originalValue;
      const candidate = tryCurrent();
      if (candidate) {
        best = candidate;
        continue;
      }
      applyReduction(entry.reduction);
      applied.splice(index, 0, entry);
    }
    return best;
  };

  for (const reduction of options.reductions) {
    if (!(reduction.field in working)) continue;
    if (applied.some((entry) => entry.reduction.field === reduction.field)) {
      continue;
    }
    applied.push({
      reduction,
      originalValue: working[reduction.field],
    });
    applyReduction(reduction);
    const candidate = tryCurrent();
    if (candidate) return restoreWhatFits(candidate);
  }

  // Legacy rows can predate current input bounds. Deterministically shed any
  // remaining non-identity fields so even those rows cannot overflow MCP.
  const identityFields = new Set(options.identityFields ?? ["id"]);
  for (const field of Object.keys(working).sort()) {
    if (
      identityFields.has(field) ||
      applied.some((entry) => entry.reduction.field === field)
    ) continue;
    const originalValue = working[field];
    delete working[field];
    applied.push({
      reduction: { field, action: "omit" },
      originalValue,
    });
    const candidate = tryCurrent();
    if (candidate) return restoreWhatFits(candidate);
  }

  return mcpText(
    JSON.stringify({
      ...working,
      truncation: recordMetadata(omittedFields(), options.recovery),
    }),
    { recovery: options.recovery },
  );
}
