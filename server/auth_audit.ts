// Lightweight, non-blocking auth-event audit emitter.
//
// `requireAuth` and `requireBrainKey` in auth.ts call `logAuthFailure()`
// from their 401 branches. Calls are fire-and-forget (queueMicrotask + a
// promise we don't await) so the 401 response goes out at the same
// latency as before — Postgres downtime can't extend an auth-failure
// response.
//
// The emitter is a no-op when:
//   - The audit pool can't be constructed (e.g., DB_PASSWORD missing in a
//     test env). config.ts validates DB_PASSWORD at module load, so this
//     branch is mostly for unit tests that dynamic-import auth.ts after
//     setting only the minimum env they care about.
//   - `OBS_AUTH_EVENTS_ENABLED` is set to "false". Defaults to enabled
//     in production; tests opt out so they don't need an mcp_auth_events
//     table to assert against the response shape.
//
// Sensitive-data discipline: this module accepts a finite-set `reason`
// code (not user-controlled text), the matched Hono route `path`, and
// the client IP from an X-Forwarded-For-style header. NO bodies, NO
// header values beyond the IP itself.

import { Pool, type PoolClient } from "postgres";

// Read env locally rather than importing config.ts so this module can be
// loaded by tests that haven't set the full mcp env (e.g., AUTH0_*).
const DB_HOST = Deno.env.get("DB_HOST")?.trim() || "postgres";
// Defensive DB_PORT parse: an empty / malformed value would otherwise yield
// NaN here and cause confusing failures later when the pool tries to
// connect ("dial: invalid port"). Fall back to the well-known port if the
// env var is absent OR malformed; only refuse to start on garbage that
// would otherwise be silently swallowed.
function parseDbPortOr5432(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return 5432;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid DB_PORT: "${trimmed}" (expected integer 1-65535)`);
  }
  return n;
}
const DB_PORT = parseDbPortOr5432(Deno.env.get("DB_PORT"));
const DB_NAME = Deno.env.get("DB_NAME")?.trim() || "openbrain";
const DB_USER = Deno.env.get("DB_USER")?.trim() || "openbrain_app";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD")?.trim() ?? "";

const FORCE_DISABLED =
  (Deno.env.get("OBS_AUTH_EVENTS_ENABLED")?.trim().toLowerCase() ?? "true") ===
    "false";

// In-flight cap on the audit insert microtask queue. Each
// call to logAuthFailure() schedules one microtask that pool.connect()s
// + INSERTs + releases. Without a cap, a sustained 401 flood against
// the Funnel door (public internet) lets postgres lag drive V8's
// microtask queue to unbounded memory growth, OOMing the mcp container
// (no `mem_limit` set in compose). 500 in-flight is generous — at the
// pool size of 2 and Postgres's local insert latency, normal traffic
// never approaches it. Tunable via env for stress-test scenarios.
function readMaxInFlight(): number {
  const raw = Deno.env.get("OBS_AUTH_EVENTS_MAX_IN_FLIGHT")?.trim();
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid OBS_AUTH_EVENTS_MAX_IN_FLIGHT: "${raw}" (expected positive integer)`,
    );
  }
  return n;
}
// Gate the parse behind the same condition as the pool construction
// below — a typo'd OBS_AUTH_EVENTS_MAX_IN_FLIGHT shouldn't take the
// whole server down if audit emission is disabled or DB_PASSWORD is
// missing (i.e. the audit insert path is dead anyway). Per Copilot
// round-2 review on PR #18.
const MAX_IN_FLIGHT = (!FORCE_DISABLED && DB_PASSWORD)
  ? readMaxInFlight()
  : 500;

let inFlight = 0;
let droppedTotal = 0;
let droppedSinceLastWarn = 0;
let lastDropWarnMs = 0;
function maybeWarnDrop(): void {
  const now = Date.now();
  if (now - lastDropWarnMs > 60_000) {
    if (droppedSinceLastWarn > 0) {
      console.warn(
        `[auth_audit] backpressure: dropped ${droppedSinceLastWarn} audit events ` +
          `in last interval (in-flight cap ${MAX_IN_FLIGHT}, ${droppedTotal} total)`,
      );
      droppedSinceLastWarn = 0;
    }
    lastDropWarnMs = now;
  }
}

// Construct a small dedicated pool (size 2). Lazy/eager doesn't matter
// here — we just need the pool object before the first audit insert.
// If DB_PASSWORD is missing, skip construction; the emitter becomes a
// no-op and never throws on call.
const pool: Pool | null = !FORCE_DISABLED && DB_PASSWORD
  ? new Pool(
    {
      hostname: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
    },
    2,
    true,
  )
  : null;

// Stable codes for the `reason` column. The human-readable strings in
// auth.ts's `unauthorized()` are operator-facing; these codes are the
// versionable identifier we use for long-term aggregation. Mapping:
//   'Invalid x-brain-key'              → 'invalid_brain_key'
//   'Token validation failed'          → 'token_validation_failed'
//   'Invalid credentials'              → 'invalid_credentials'
//   'Missing or unsupported credentials' → 'missing_credentials'
//   'Invalid or missing access key'    → 'invalid_brain_key' (require_brain_key)
export type AuthFailureReason =
  | "invalid_brain_key"
  | "token_validation_failed"
  | "invalid_credentials"
  | "missing_credentials";

export type AuthMiddleware = "require_auth" | "require_brain_key";

export interface AuthFailureRecord {
  reason: AuthFailureReason;
  middleware: AuthMiddleware;
  clientIp?: string | null;
  path?: string | null;
}

// Best-effort insert. Errors are logged once per minute (via the simple
// rate-limiter below) and never propagate to the caller.
let lastErrorLogMs = 0;
function logRateLimited(msg: string): void {
  const now = Date.now();
  if (now - lastErrorLogMs > 60_000) {
    console.warn(`[auth_audit] ${msg}`);
    lastErrorLogMs = now;
  }
}

async function doInsert(rec: AuthFailureRecord): Promise<void> {
  if (!pool) return;
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.queryArray(
      `INSERT INTO mcp_auth_events (reason, middleware, client_ip, path)
       VALUES ($1, $2, $3::inet, $4)`,
      [
        rec.reason,
        rec.middleware,
        rec.clientIp ?? null,
        rec.path ?? null,
      ],
    );
  } catch (e) {
    logRateLimited(`insert failed: ${(e as Error).message}`);
  } finally {
    if (client) client.release();
  }
}

// Public entry. Fire-and-forget; never throws.
export function logAuthFailure(rec: AuthFailureRecord): void {
  if (!pool) return;
  // Synchronous backpressure check. If too many inserts are
  // already in flight (postgres is lagging or briefly unavailable), drop
  // this audit event instead of letting the microtask queue grow without
  // bound. The check is synchronous-before-queueMicrotask so a sustained
  // sync-loop flood (e.g. one 401 per request handler turn) hits the cap
  // deterministically. The 401 response shape is unaffected.
  if (inFlight >= MAX_IN_FLIGHT) {
    droppedTotal++;
    droppedSinceLastWarn++;
    maybeWarnDrop();
    return;
  }
  inFlight++;
  // Don't await — the 401 response should not wait for postgres. queueMicrotask
  // schedules the work after the current sync turn so the response.send
  // chain isn't disturbed. inFlight is decremented in the finally regardless
  // of insert success/failure.
  queueMicrotask(() => {
    doInsert(rec)
      .catch((e) => {
        logRateLimited(`unexpected throw: ${(e as Error).message}`);
      })
      .finally(() => {
        inFlight--;
      });
  });
}

// Test helper — read-only view of the backpressure metrics. This is a
// regular module export (TypeScript has no "internal" visibility); no
// production import call site is intended. The `ForTests` suffix is the
// in-file convention for "do not call from production code" — also used
// by `shutdownAuthAuditForTests` immediately below. Not (yet) an
// established cross-module convention; if it propagates, a deno-lint
// rule on imports of `*ForTests` names from outside test files would
// be the natural way to enforce it.
export function getAuditMetricsForTests(): {
  cap: number;
  inFlight: number;
  droppedTotal: number;
} {
  return { cap: MAX_IN_FLIGHT, inFlight, droppedTotal };
}

// Test helper. Drains the pool so tests don't leak connections.
export async function shutdownAuthAuditForTests(): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch {
    // ignore
  }
}
