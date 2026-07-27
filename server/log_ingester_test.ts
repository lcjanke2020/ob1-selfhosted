// Unit tests for the log ingester's file-reading contract: byte-level
// cursor math, rename/recreate rotation detection via file identity
// (audit finding PR55-OPS-002), same-file truncation handling, and the
// cursor-file format round-trip (JSON + legacy offset-only).
//
// log_ingester.ts requires DB_PASSWORD at module load (the ingester is
// a separate process with the same fail-fast discipline as mcp). Set
// it before importing so the pool can be constructed; the pool itself
// is idle for the duration of the tests (main() only runs under
// `import.meta.main`).
//
// CURSOR_DIR is likewise read at module load. All tests in this file
// share the single cached module instance, so the override below must
// run BEFORE the first dynamic import — hence module scope, not a
// per-test env dance. Tests use distinct log-file basenames because the
// cursor filename derives from the basename alone. The final
// "cleanup" test below removes the temp dir and restores the env var
// (Deno.test bodies run in declaration order, so it runs last).
const ORIG_CURSOR_DIR = Deno.env.get("INGESTER_CURSOR_DIR");
const CURSOR_TMP = await Deno.makeTempDir({ prefix: "log_ingester_cursors_" });
Deno.env.set("INGESTER_CURSOR_DIR", CURSOR_TMP);

import { assert, assertEquals, assertNotEquals } from "@std/assert";

const ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
];

// Snapshot + restore the env around a test body, with DB_PASSWORD set so
// the dynamic import of log_ingester.ts succeeds. (Only the first import
// actually evaluates the module; the env hygiene keeps every test honest
// regardless of execution order.)
async function withIngesterEnv(
  body: (mod: typeof import("./log_ingester.ts")) => Promise<void>,
): Promise<void> {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  try {
    Deno.env.set("DB_PASSWORD", "test-password");
    const mod = await import("./log_ingester.ts");
    await body(mod);
  } finally {
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const FRESH = { offset: 0, dev: null, ino: null };

Deno.test("readNewLines: cursor uses raw byte count, not re-encoded string length", async () => {
  await withIngesterEnv(async ({ readNewLines }) => {
    let tmpDir: string | null = null;
    try {
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
      const tmpPath = `${tmpDir}/bytemath.log`;
      await Deno.writeFile(tmpPath, contentBytes);

      const result = await readNewLines(tmpPath, { ...FRESH });

      // Cursor MUST equal the exact byte length of the consumed region.
      // The historical bug advanced the cursor by
      // `TextEncoder.encode(decoded).length + 1`, which equals
      // contentBytes.length for valid UTF-8 — so the failure mode here is
      // the boundary-split case below. This first assertion is the
      // happy-path "valid UTF-8 round-trips" baseline.
      assertEquals(result.cursor.offset, contentBytes.length);
      assertEquals(result.lines, lines);
      // The read stamps the file's identity into the cursor.
      assertNotEquals(result.cursor.ino, null);
      assertNotEquals(result.cursor.dev, null);

      // Now exercise the boundary-split path. Truncate the file after the
      // first complete line PLUS the first byte of the next line's
      // multi-byte char ("Δ" is 0xCE 0x94 — keep just 0xCE). Decoding
      // 0xCE alone yields U+FFFD (3 bytes when re-encoded), which is
      // exactly the drift case the bug produced.
      const firstNl = content.indexOf("\n");
      const truncatedEnd = firstNl + 1 + 'unicode line with "'.length + 1; // +1 byte of "Δ"
      const truncated = contentBytes.subarray(0, truncatedEnd);
      await Deno.writeFile(tmpPath, truncated);

      const partial = await readNewLines(tmpPath, { ...FRESH });
      // Only the first line is complete (terminated by '\n'); the
      // unicode line is partial. The cursor should advance by exactly
      // firstNl + 1 bytes, NOT by some re-encoded round-trip count.
      assertEquals(partial.cursor.offset, firstNl + 1);
      assertEquals(partial.lines, [lines[0]]);
    } finally {
      if (tmpDir !== null) {
        try {
          await Deno.remove(tmpDir, { recursive: true });
        } catch { /* ignore cleanup failure */ }
      }
    }
  });
});

Deno.test("readNewLines: rename/recreate rotation is detected by file identity, not size", async () => {
  await withIngesterEnv(async ({ readNewLines }) => {
    let tmpDir: string | null = null;
    try {
      tmpDir = await Deno.makeTempDir({ prefix: "log_ingester_test_" });
      const tmpPath = `${tmpDir}/rotation.log`;

      // The PR55-OPS-002 reproduction: read a one-line file to EOF, then
      // replace it (rename over the path — new inode, Caddy's rotation
      // shape) with a file whose size is GREATER THAN the old cursor.
      // The size<cursor heuristic can't see this; only file identity can.
      const oldContent = "old row one\n";
      await Deno.writeTextFile(tmpPath, oldContent);
      const first = await readNewLines(tmpPath, { ...FRESH });
      assertEquals(first.lines, ["old row one"]);
      assertEquals(first.cursor.offset, oldContent.length);

      const replacementLines = [
        "replacement row one — must not be skipped",
        "replacement row two",
      ];
      const replacement = replacementLines.join("\n") + "\n";
      assert(
        replacement.length > oldContent.length,
        "test setup: replacement must be larger than the old cursor",
      );
      // Create-then-rename mirrors rotation: the replacement gets its own
      // inode before it lands at the tailed path.
      const staging = `${tmpDir}/rotation.log.new`;
      await Deno.writeTextFile(staging, replacement);
      await Deno.rename(staging, tmpPath);

      const second = await readNewLines(tmpPath, first.cursor);
      // Pre-fix behavior: seek to first.cursor.offset inside the
      // replacement → only the tail after byte 12 comes back and the
      // complete leading row is silently lost.
      assertEquals(second.lines, replacementLines);
      assertEquals(
        second.cursor.offset,
        new TextEncoder().encode(replacement).length,
      );
      assertNotEquals(
        `${second.cursor.dev}:${second.cursor.ino}`,
        `${first.cursor.dev}:${first.cursor.ino}`,
        "replacement file must carry a new identity",
      );

      // Equal-BYTE-size replacement — the sharpest edge: size === cursor
      // reads as "no new data" without identity tracking. ASCII-only so
      // byte length equals char length.
      const replacementBytes = new TextEncoder().encode(replacement).length;
      const equalSized = "e".repeat(replacementBytes - 1) + "\n";
      assertEquals(
        new TextEncoder().encode(equalSized).length,
        replacementBytes,
      );
      const staging2 = `${tmpDir}/rotation.log.new2`;
      await Deno.writeTextFile(staging2, equalSized);
      await Deno.rename(staging2, tmpPath);

      const third = await readNewLines(tmpPath, second.cursor);
      assertEquals(third.lines, ["e".repeat(replacementBytes - 1)]);
      assertEquals(third.cursor.offset, replacementBytes);
    } finally {
      if (tmpDir !== null) {
        try {
          await Deno.remove(tmpDir, { recursive: true });
        } catch { /* ignore cleanup failure */ }
      }
    }
  });
});

Deno.test("readNewLines: same-file truncation still resets to 0 (identity unchanged)", async () => {
  await withIngesterEnv(async ({ readNewLines }) => {
    let tmpDir: string | null = null;
    try {
      tmpDir = await Deno.makeTempDir({ prefix: "log_ingester_test_" });
      const tmpPath = `${tmpDir}/truncate.log`;

      await Deno.writeTextFile(tmpPath, "line one\nline two\n");
      const first = await readNewLines(tmpPath, { ...FRESH });
      assertEquals(first.lines, ["line one", "line two"]);

      // Overwrite IN PLACE (O_TRUNC keeps the inode): size < cursor with
      // the same identity → the pre-existing shrink heuristic applies.
      await Deno.writeTextFile(tmpPath, "new\n");
      const second = await readNewLines(tmpPath, first.cursor);
      assertEquals(second.lines, ["new"]);
      assertEquals(second.cursor.offset, 4);
      assertEquals(second.cursor.ino, first.cursor.ino);
    } finally {
      if (tmpDir !== null) {
        try {
          await Deno.remove(tmpDir, { recursive: true });
        } catch { /* ignore cleanup failure */ }
      }
    }
  });
});

Deno.test("cursor files: JSON round-trip, legacy offset-only, and garbage fallback", async () => {
  await withIngesterEnv(async ({ readCursor, writeCursor }) => {
    // Absent cursor file → fresh cursor.
    assertEquals(await readCursor("/nowhere/fresh.log"), { ...FRESH });

    // JSON round-trip preserves offset + identity.
    const rtLog = "/nowhere/roundtrip.log";
    await writeCursor(rtLog, { offset: 123, dev: 5, ino: 42 });
    assertEquals(await readCursor(rtLog), { offset: 123, dev: 5, ino: 42 });

    // Legacy offset-only cursor (pre-identity format: bare integer text,
    // as written by the previous writeCursor) parses as offset with
    // unknown identity — an upgrade must neither re-ingest nor skip.
    await Deno.writeTextFile(`${CURSOR_TMP}/legacy.log.cursor`, "9876");
    assertEquals(await readCursor("/nowhere/legacy.log"), {
      offset: 9876,
      dev: null,
      ino: null,
    });

    // Garbage falls back to a fresh cursor rather than throwing (matches
    // the historical parse-failure behavior of returning 0).
    await Deno.writeTextFile(`${CURSOR_TMP}/garbage.log.cursor`, "not json");
    assertEquals(await readCursor("/nowhere/garbage.log"), { ...FRESH });

    // Negative / non-integer fields are rejected field-wise.
    await Deno.writeTextFile(
      `${CURSOR_TMP}/badfields.log.cursor`,
      JSON.stringify({ offset: -5, dev: 1.5, ino: 7 }),
    );
    assertEquals(await readCursor("/nowhere/badfields.log"), {
      offset: 0,
      dev: null,
      ino: 7,
    });
  });
});

// Declared last so it runs after every test above: drop the shared
// module-scope cursor temp dir and restore INGESTER_CURSOR_DIR to
// whatever the process had before this file's module setup ran.
Deno.test("cleanup: remove shared cursor temp dir and restore env", async () => {
  try {
    await Deno.remove(CURSOR_TMP, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (ORIG_CURSOR_DIR === undefined) Deno.env.delete("INGESTER_CURSOR_DIR");
  else Deno.env.set("INGESTER_CURSOR_DIR", ORIG_CURSOR_DIR);
});
