// Caddy JSON access log → Postgres ingester.
//
// Tails the two Caddy access log files written by the Caddyfile's
// `log file ... format json` directives, parses each JSON line, scrubs
// any header values that shouldn't ever land in the DB, and inserts
// into `funnel_access_log`.
//
// Design notes:
// - Polling not inotify: simple, portable, and Caddy's rotation cadence
//   is once per ~10MB which is the dominant write event, so we're not
//   missing meaningful resolution by checking every 5s.
// - One ingester process handles both files. Caddy assigns separate
//   loggers per listener (`logger_names`) so the `socket` column is
//   derived from the file we're reading, not from the JSON itself.
// - Cursor (byte offset) persisted to `/var/log/caddy/<file>.cursor`
//   so a restart doesn't re-ingest everything. The cursor lives next
//   to the log files (same shared volume) so it survives container
//   restart without needing a second volume.
// - Rotation handling: if file size < cursor, treat as rotated and
//   reset cursor to 0. Caddy rolls via rename (`*.log` → `*.log.1`)
//   so the inode changes; we don't follow renames — we just keep
//   reading the path and accept the small risk of skipping a partial
//   final read of the rotated-out file. Acceptable trade-off for
//   personal-scale observability.
// - Sensitive-data discipline: this code is the LAST line of defense
//   before per-request data lands in Postgres. Caddy's default JSON
//   format does NOT include header values OR request bodies — but if
//   a future Caddyfile change adds `request>headers` we want to keep
//   stripping. See the `scrub*` helpers.

import { Pool } from "postgres";
import { parseInetCandidate } from "./inet.ts";

// Local env reads only — intentionally NOT importing from ./config.ts so
// the ingester doesn't get tangled in the mcp server's startup validation
// (MCP_ACCESS_KEY required, AUTH0_* tri-state check, etc.). The ingester
// needs only the DB connection vars; missing them is a fatal startup error
// here too, just with a smaller surface.
function required(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function optional(name: string, fallback: string): string {
  return Deno.env.get(name)?.trim() || fallback;
}
function optionalInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid integer env var ${name}: "${raw}"`);
  }
  return n;
}

const DB_HOST = optional("DB_HOST", "postgres");
const DB_PORT = optionalInt("DB_PORT", 5432);
const DB_NAME = optional("DB_NAME", "openbrain");
// Default to the observability-only role. The compose env wires
// this explicitly; the default is here so a direct `deno run` invocation
// (dev / one-off) picks up the right role too.
const DB_USER = optional("DB_USER", "openbrain_ingester");
const DB_PASSWORD = required("DB_PASSWORD");

// Where Caddy writes the JSON access logs. See Caddyfile log directives.
const LOG_DIR = optional("CADDY_LOG_DIR", "/var/log/caddy");

// Which files to tail, and which socket they correspond to. The socket
// label is the source-of-truth for the `socket` column since the JSON
// row's `logger_names` field is a single-element array of an internal
// identifier we'd otherwise have to map back.
const FILES: ReadonlyArray<{ path: string; socket: "funnel" | "tailnet" }> = [
  { path: `${LOG_DIR}/funnel-access.log`, socket: "funnel" },
  { path: `${LOG_DIR}/tailnet-access.log`, socket: "tailnet" },
];

// Polling cadence. 5s gives near-real-time visibility without busy-looping.
// Bump via env for testing or for very low-volume installs.
const POLL_INTERVAL_MS = optionalInt("INGESTER_POLL_INTERVAL_MS", 5000);

// Defensive user-agent truncation. Real bots send multi-kilobyte UAs.
const UA_MAX_LEN = 200;

// Connection pool — small (size 2) because this is a single-process tail-and-
// insert loop with no concurrency to speak of.
const pool = new Pool(
  {
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  },
  2,
  true,
);

// Caddy's access log JSON shape (only the fields we care about).
// See https://caddyserver.com/docs/logging for the full schema.
interface CaddyAccessRow {
  ts?: number; // unix seconds, float
  duration?: number; // seconds, float
  size?: number; // bytes
  status?: number;
  logger_names?: string[];
  request?: {
    // `client_ip` is populated by Caddy when `servers {
    // trusted_proxies ... client_ip_headers X-Forwarded-For }` is
    // configured (see Caddyfile global block). It's the XFF-resolved
    // public origin IP, NOT the direct peer (which would be loopback
    // since Tailscale fronts both listeners). Prefer this over
    // remote_ip/remote_addr when present.
    client_ip?: string;
    remote_ip?: string;
    remote_addr?: string;
    proto?: string;
    method?: string;
    host?: string;
    uri?: string; // full request-target including query string
    headers?: Record<string, string[]>;
    tls?: {
      server_name?: string;
    };
  };
}

// Strip everything after the first `?` so query-string credentials never
// reach the DB even though our policy is header-only. Defense in depth.
function pathFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const q = uri.indexOf("?");
  return q === -1 ? uri : uri.slice(0, q);
}

// Caddy's request.headers map has the raw values verbatim. We never want
// any of these in the DB. The Caddyfile uses `format filter` to delete
// these fields BEFORE they hit the on-disk JSON, but if the Caddyfile is
// ever changed (or this ingester points at a differently-configured Caddy),
// observing one of these keys is a "Caddyfile drift" canary worth surfacing.
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "x-brain-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);
// Warn-once-per-process per offending header so we get a signal on drift
// without spamming the log on every request.
const warnedForbiddenHeaders = new Set<string>();

// Extract just the User-Agent (truncated) from the headers map. Anything
// else from `request.headers` is explicitly NOT looked at.
function userAgentFrom(
  headers: Record<string, string[]> | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "user-agent" && v.length > 0) {
      return v[0].slice(0, UA_MAX_LEN);
    }
  }
  return undefined;
}

// Pull Host header (the client-supplied target hostname). Useful for
// spotting probes that ignore Host or set a vhost we don't serve.
function hostFrom(req: CaddyAccessRow["request"]): string | undefined {
  if (!req) return undefined;
  if (req.host) return req.host.slice(0, 200);
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host" && v.length > 0) return v[0].slice(0, 200);
    }
  }
  return undefined;
}

// Convert Caddy's float seconds → integer milliseconds.
function durationMs(d: number | undefined): number | undefined {
  if (d === undefined || !Number.isFinite(d)) return undefined;
  return Math.round(d * 1000);
}

// Cursor files live in a SEPARATE volume from the log files. The Caddy
// container writes the log files as root into the `caddy_logs` named
// volume; the ingester runs as the non-root `deno` user and would
// otherwise fail to write `.cursor` companions next to root-owned logs
// (EACCES → silently re-read from offset 0 on every poll → duplicate
// inserts every 5s). Splitting cursor storage into its own volume
// (`caddy_cursors`, RW only to the ingester) also resolves the
// audit-integrity concern about the ingester having RW access to the caddy
// log files themselves — `caddy_logs` is now mounted :ro for the
// ingester.
//
// Path layout: cursors live at `/var/lib/ingester/cursors/` rather
// than nested under `/var/log/caddy/cursors/`. Reason: the ingester
// container has `read_only: true` rootfs, and nesting a writable
// volume inside an already-mounted read-only volume (caddy_logs:ro
// at /var/log/caddy) fails at container init because Docker can't
// create the nested mountpoint directory on the RO rootfs. Putting
// the cursors at a sibling path under /var/lib avoids the nest.
// The cursor filename derives from the log file's basename.
const CURSOR_DIR = "/var/lib/ingester/cursors";
function cursorPath(logFilePath: string): string {
  const sep = logFilePath.lastIndexOf("/");
  const base = sep === -1 ? logFilePath : logFilePath.slice(sep + 1);
  return `${CURSOR_DIR}/${base}.cursor`;
}

// Read the cursor (byte offset) for a given log file. 0 if absent.
async function readCursor(logFilePath: string): Promise<number> {
  try {
    const raw = await Deno.readTextFile(cursorPath(logFilePath));
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return 0;
    throw e;
  }
}

async function writeCursor(
  logFilePath: string,
  offset: number,
): Promise<void> {
  await Deno.writeTextFile(cursorPath(logFilePath), String(offset));
}

// Stream new bytes from `filePath` starting at `offset`. Returns the new
// offset and a flat array of complete JSON lines that were appended.
// Exported for unit testing of the cursor-byte math .
export async function readNewLines(
  filePath: string,
  offset: number,
): Promise<{ offset: number; lines: string[] }> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(filePath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { offset, lines: [] };
    throw e;
  }

  // File shrank → almost certainly rotated. Reset to 0 and read fresh.
  let startOffset = offset;
  if (stat.size < offset) {
    console.log(
      `[ingester] ${filePath}: size ${stat.size} < cursor ${offset}; treating as rotated`,
    );
    startOffset = 0;
  }

  if (stat.size === startOffset) return { offset: startOffset, lines: [] };

  using f = await Deno.open(filePath, { read: true });
  await f.seek(startOffset, Deno.SeekMode.Start);
  const buf = new Uint8Array(stat.size - startOffset);
  const n = await f.read(buf);
  if (n === null) return { offset: startOffset, lines: [] };

  // Find the last '\n' in the RAW byte buffer, not in the
  // decoded string. The previous implementation re-encoded the decoded
  // text via `new TextEncoder().encode(consumable).length + 1` to
  // compute the new cursor, which drifts when the read boundary
  // splits a multi-byte UTF-8 sequence (TextDecoder substitutes U+FFFD
  // — 3 bytes — for the truncated trailing bytes, inflating the
  // re-encoded length). Drift → next poll re-reads overlapping bytes
  // (duplicate inserts) or skips bytes (lost rows). Working in bytes
  // throughout eliminates the round-trip entirely.
  const consumed = buf.subarray(0, n);
  let lastNlByte = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (consumed[i] === 0x0A) {
      lastNlByte = i;
      break;
    }
  }
  // Don't process a partial trailing line — leave its bytes "for next time".
  if (lastNlByte === -1) return { offset: startOffset, lines: [] };

  // Decode only the bytes up to (and not including) the trailing newline.
  // Splitting on '\n' over the decoded string is safe — '\n' is U+000A,
  // which encodes to the single byte 0x0A in UTF-8 and never appears as
  // a continuation byte inside any other multi-byte sequence.
  const consumable = new TextDecoder().decode(consumed.subarray(0, lastNlByte));
  const lines = consumable.split("\n").filter((l) => l.length > 0);
  const newOffset = startOffset + lastNlByte + 1; // +1 for the trailing newline
  return { offset: newOffset, lines };
}

// Result of attempting to insert one Caddy access-log line.
//   "ok":    inserted into funnel_access_log.
//   "skip":  the line is permanently bad (e.g. invalid JSON). Logged
//            and dropped. Cursor advances past it ONCE THE REST OF THE
//            BATCH finishes without a "retry"; if a later line in the
//            same batch returns "retry", earlier skipped lines are
//            re-read on the next tick (and just keep skipping). Per-PR
//            #21 follow-up: per-line cursor tracking would let skips
//            persist independently and stop the re-read.
//   "retry": the line is well-formed but the DB call failed. Caller
//            stops the batch and does NOT advance the cursor — next
//            tick re-reads these bytes and tries again. This is the
//            failure mode that previously silently dropped audit rows
//            (cursor advanced before the insert, so a transient DB
//            outage left holes in the access-log evidence).
type InsertResult = "ok" | "skip" | "retry";

// Parse one Caddy JSON line and insert it. See `InsertResult` for semantics.
async function insertLine(
  socket: "funnel" | "tailnet",
  line: string,
): Promise<InsertResult> {
  let row: CaddyAccessRow;
  try {
    row = JSON.parse(line);
  } catch {
    console.warn(`[ingester] ${socket}: JSON parse failed; line dropped`);
    return "skip";
  }

  // Forbidden-header drift canary. The Caddyfile's `format filter` block
  // should be deleting these fields before the JSON is written, so seeing
  // one here means either (a) the Caddyfile was changed, or (b) this ingester
  // is reading a log from a differently-configured Caddy. Warn once per
  // offending key per process — loud enough to investigate, quiet enough
  // not to flood. We do NOT extract the value (userAgentFrom / hostFrom are
  // allowlist-based — they only read user-agent / host), so even if a
  // forbidden header value leaks through, it doesn't reach the DB.
  if (row.request?.headers) {
    for (const k of Object.keys(row.request.headers)) {
      const kLower = k.toLowerCase();
      if (
        FORBIDDEN_HEADERS.has(kLower) && !warnedForbiddenHeaders.has(kLower)
      ) {
        warnedForbiddenHeaders.add(kLower);
        console.warn(
          `[ingester] ${socket}: forbidden header "${kLower}" present in access log — Caddyfile \`format filter\` may have drifted; verify the redaction set`,
        );
      }
    }
  }

  // The field-extraction block below
  // sits OUTSIDE the DB try/catch and can throw on malformed input
  // (e.g. `new Date(NaN).toISOString()` if `row.ts` is non-finite).
  // Such a throw would escape `insertLine`, abort `tickOnce` without
  // advancing the cursor, and put the ingester into an infinite
  // reprocess loop on the same bad batch — the cursor-integrity bug
  // class again, in a non-DB code path. Wrapping in a try
  // here that returns "skip" on any extraction failure keeps the
  // batch progressing past permanently malformed rows. The explicit
  // `Number.isFinite(tsMs)` guard covers the specific row.ts case;
  // the surrounding catch is the belt to those suspenders.
  let ts: string;
  // `path` matches pathFromUri's return type (string | undefined). The SQL
  // bind below coalesces with `?? null` so the wire-level value is still
  // NULL on missing — keeping the local type aligned with the helper
  // avoids a TS2322 widening to `string | null` here.
  let path: string | undefined;
  let clientIp: string | null;
  let userAgent: string | undefined;
  let hostHeader: string | undefined;
  let dms: number | undefined;
  let proto: string | undefined;
  let tlsSni: string | undefined;
  let caddyLogger: string | undefined;
  try {
    // Caddy's `ts` is unix seconds as a float. JS Date wants milliseconds.
    const tsMs = row.ts !== undefined ? Math.round(row.ts * 1000) : Date.now();
    if (!Number.isFinite(tsMs)) {
      console.warn(
        `[ingester] ${socket}: non-finite ts (${row.ts}); line dropped`,
      );
      return "skip";
    }
    ts = new Date(tsMs).toISOString();
    path = pathFromUri(row.request?.uri);
    // prefer `client_ip` (XFF-resolved public origin) over
    // `remote_ip` (direct peer) when the Caddyfile is configured with
    // `trusted_proxies` (production wiring). Falls back to `remote_ip`
    // for older logs or dev rigs without the trusted_proxies block, and
    // to `remote_addr` (some Caddy versions emit `ip:port` form here)
    // as a last resort. All three go through parseInetCandidate so a
    // stray port suffix or `unknown` token doesn't fail the `$3::inet`
    // cast and silently drop the row. NULL if none yield a parseable INET.
    clientIp = parseInetCandidate(row.request?.client_ip) ??
      parseInetCandidate(row.request?.remote_ip) ??
      parseInetCandidate(row.request?.remote_addr) ?? null;
    userAgent = userAgentFrom(row.request?.headers);
    hostHeader = hostFrom(row.request);
    dms = durationMs(row.duration);
    proto = row.request?.proto;
    tlsSni = row.request?.tls?.server_name;
    caddyLogger = row.logger_names?.[0];
  } catch (e) {
    console.warn(
      `[ingester] ${socket}: malformed row field; line dropped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return "skip";
  }

  // pool.connect() must be inside the try so that
  // a pool exhaustion / Postgres-down failure returns "retry" through the
  // documented InsertResult contract rather than throwing out of insertLine
  // and unwinding tickOnce as a generic error. Audit fidelity happens to
  // be preserved either way (writeCursor in the lines case runs only after
  // the loop completes), but routing connect-time failures through "retry"
  // keeps the per-socket warning context and lets tickOnce log a precise
  // "transient failure after N/M rows" message.
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    // Positional params match the rest of queries.ts. inet/timestamptz are
    // cast in-SQL so plain JS strings are accepted.
    await client.queryArray(
      `INSERT INTO funnel_access_log (
         ts, socket, client_ip, method, path, status, duration_ms,
         bytes_out, user_agent, host_header, proto, tls_sni, caddy_logger
       ) VALUES (
         $1::timestamptz, $2, $3::inet,
         $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )`,
      [
        ts,
        socket,
        clientIp,
        row.request?.method ?? null,
        path ?? null,
        row.status ?? null,
        dms ?? null,
        row.size ?? null,
        userAgent ?? null,
        hostHeader ?? null,
        proto ?? null,
        tlsSni ?? null,
        caddyLogger ?? null,
      ],
    );
    return "ok";
  } catch (e) {
    // Treat as transient — caller will retry next tick rather than
    // silently dropping the row. Covers both query-time failures (the
    // original catch) and connect-time failures. If the failure is
    // actually permanent (schema drift, bad
    // data slipping past parseInetCandidate, etc.) it'll keep failing
    // every tick until investigated, which is the intended loud-failure
    // mode for audit-log fidelity.
    // `(e as Error).message` is
    // `undefined` for non-Error throws (e.g. `throw "string"`); the
    // instanceof guard keeps the log line meaningful for any thrown
    // value the pg driver might surface.
    console.warn(
      `[ingester] ${socket}: insert failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return "retry";
  } finally {
    client?.release();
  }
}

async function tickOnce(): Promise<void> {
  for (const { path, socket } of FILES) {
    const cursor = await readCursor(path);
    const { offset: newOffset, lines } = await readNewLines(path, cursor);

    // Case 1: no complete lines arrived this tick. Persist a changed
    // offset immediately — this is the rotation case (readNewLines
    // returns { offset: 0, lines: [] } when the file shrank below the
    // cursor) and the partial-trailing-line case (offset advanced past
    // the complete portion). Without persisting that, we'd be stuck
    // "treating as rotated" every poll forever.
    if (lines.length === 0) {
      if (newOffset !== cursor) {
        await writeCursor(path, newOffset);
      }
      continue;
    }

    // Case 2: we have lines. advance the cursor ONLY after
    // all inserts complete without a transient failure. Previously the
    // cursor was persisted before any insert ran, so a DB outage
    // silently dropped audit rows.
    //
    // On "retry": stop the batch, leave cursor at the original value,
    // re-read the same bytes next tick. May re-insert lines that
    // already succeeded (funnel_access_log has no natural unique key
    // yet), but audit-log over-counting beats under-counting.
    let inserted = 0;
    let skipped = 0;
    let mustRetry = false;
    for (const line of lines) {
      const result = await insertLine(socket, line);
      if (result === "ok") {
        inserted++;
      } else if (result === "skip") {
        skipped++;
      } else {
        mustRetry = true;
        break;
      }
    }

    if (mustRetry) {
      // Include `skipped` so a "0 ok / 2 skipped /
      // 1 retry" batch isn't misread as "nothing happened."
      console.warn(
        `[ingester] ${socket}: transient insert failure after ${inserted}/${lines.length} rows (${skipped} skipped); cursor=${cursor} retained for retry next tick`,
      );
    } else {
      await writeCursor(path, newOffset);
      console.log(
        `[ingester] ${socket}: ${inserted}/${lines.length} rows inserted (${skipped} skipped); cursor=${newOffset}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `[ingester] starting; LOG_DIR=${LOG_DIR}, POLL_INTERVAL_MS=${POLL_INTERVAL_MS}`,
  );
  // Graceful shutdown — release the pool on SIGTERM (docker compose down).
  const shutdown = async () => {
    console.log("[ingester] shutdown signal received; closing pool");
    try {
      await pool.end();
    } catch (e) {
      console.warn(`[ingester] pool.end failed: ${(e as Error).message}`);
    }
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);

  // Tick-loop forever. Errors in tickOnce are caught + logged so a single
  // bad batch doesn't crash the process.
  // deno-lint-ignore no-constant-condition
  while (true) {
    try {
      await tickOnce();
    } catch (e) {
      console.error(`[ingester] tick failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

if (import.meta.main) {
  main();
}
