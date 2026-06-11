// Unit test for the byte-level cursor math in readNewLines().
//
// The earlier implementation computed the new cursor offset by
// re-encoding the decoded string via TextEncoder, which drifts when
// the read boundary splits a multi-byte UTF-8 sequence (the truncated
// trailing bytes decode to a 3-byte U+FFFD replacement that inflates
// the re-encoded length). This test pins the contract that the new
// cursor advances by exactly the byte count consumed up through the
// last full line, regardless of multi-byte content inside that span.
//
// log_ingester.ts requires DB_PASSWORD at module load (the ingester is
// a separate process with the same fail-fast discipline as mcp). Set
// it before importing so the pool can be constructed; the pool itself
// is idle for the duration of the test (main() only runs under
// `import.meta.main`).

import { assertEquals } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
];

Deno.test("readNewLines: cursor uses raw byte count, not re-encoded string length", async () => {
  // Snapshot env BEFORE doing anything that could throw, and enter the
  // outer try/finally before the dynamic import: if
  // `await import("./log_ingester.ts")` were outside the try, an
  // import-time failure would leave DB_PASSWORD set in the test runner's
  // env, polluting later tests.
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  let tmpDir: string | null = null;
  try {
    Deno.env.set("DB_PASSWORD", "test-password");

    const { readNewLines } = await import("./log_ingester.ts");

    // Three lines, the middle one with non-ASCII multi-byte UTF-8 in a
    // User-Agent-like field. Encoded length differs from JS-string length
    // because each non-ASCII char is 2+ UTF-8 bytes but counts as 1 JS-
    // string char (or 2 for codepoints outside the BMP).
    //   "Δoc/1.0 — Tëst" → 19 UTF-8 bytes, 14 JS chars
    const lines = [
      "ascii line 1",
      'unicode line with "Δoc/1.0 — Tëst" inside it',
      "ascii line 3",
    ];
    const content = lines.join("\n") + "\n";
    const contentBytes = new TextEncoder().encode(content);

    tmpDir = await Deno.makeTempDir({ prefix: "log_ingester_test_" });
    const tmpPath = `${tmpDir}/access.log`;
    await Deno.writeFile(tmpPath, contentBytes);

    const result = await readNewLines(tmpPath, 0);

    // Cursor MUST equal the exact byte length of the consumed region.
    // The previous (buggy) implementation would have advanced the cursor
    // by `TextEncoder.encode(decoded).length + 1`, which equals
    // contentBytes.length for valid UTF-8 — so the failure mode here is
    // the boundary-split case below. This first assertion is the
    // happy-path "valid UTF-8 round-trips" baseline.
    assertEquals(result.offset, contentBytes.length);
    assertEquals(result.lines, lines);

    // Now exercise the boundary-split path. Truncate the file after the
    // first complete line PLUS the first byte of the next line's
    // multi-byte char ("Δ" is 0xCE 0x94 — keep just 0xCE). Decoding
    // 0xCE alone yields U+FFFD (3 bytes when re-encoded), which is
    // exactly the drift case the bug produced.
    const firstNl = content.indexOf("\n");
    const truncatedEnd = firstNl + 1 + 'unicode line with "'.length + 1; // +1 byte of "Δ"
    const truncated = contentBytes.subarray(0, truncatedEnd);
    await Deno.writeFile(tmpPath, truncated);

    const partial = await readNewLines(tmpPath, 0);
    // Only the first line is complete (terminated by '\n'); the
    // unicode line is partial. The cursor should advance by exactly
    // firstNl + 1 bytes, NOT by some re-encoded round-trip count.
    assertEquals(partial.offset, firstNl + 1);
    assertEquals(partial.lines, [lines[0]]);
  } finally {
    if (tmpDir !== null) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore cleanup failure */ }
    }
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
