// Connection-pool resilience helper, shared by every pool in the server
// (the MCP query pool, the audit pool, and the log-ingester pool).
//
// Why this exists
// ---------------
// deno-postgres pools do NOT self-heal after the database restarts. When the
// database goes away and comes back (e.g. the DB host reboots), the pooled
// TCP sockets are dead but the driver still reports each client as
// `connected === true`, so the pool hands a dead client straight back out.
// The first query on it fails at the socket layer ("Broken pipe (os error
// 32)" / "Connection reset by peer (os error 104)"), and the driver's
// error path then calls `Client.end()`, which sets a *permanent* terminated
// flag — every later query on that client throws "Connection to the database
// has been terminated". The connection is bricked until the process restarts.
//
// The fix
// -------
// `getClient()` is a drop-in replacement for `pool.connect()` that validates
// the borrowed connection with a cheap `SELECT 1` before handing it to the
// caller. If that probe trips a connection-level error, it calls `end()` on
// the client — which flips the driver's internal `connected` flag to false —
// and releases it, so the pool's own borrow path (`DeferredAccessStack.pop`)
// re-establishes the connection on the next attempt and clears the terminated
// flag. A short bounded retry loop covers the window where the database is
// still finishing its restart.
//
// Validate-on-borrow (rather than retry-the-caller's-query) is deliberate:
// the recovery happens on a throwaway probe, so callers never risk a
// mutation running twice. The extra round-trip is negligible against a
// same-host / local-tailnet database.

import { ConnectionError, type Pool, type PoolClient } from "postgres";

const VALIDATION_QUERY = "SELECT 1";
const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 150;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when `e` indicates a dead/unusable connection (as opposed to a normal
 * SQL error such as a constraint violation, which must propagate unchanged).
 * Matches both the driver's typed `ConnectionError` and the raw OS-level
 * socket errors the driver sometimes surfaces verbatim.
 */
export function isConnectionError(e: unknown): boolean {
  if (e instanceof ConnectionError) return true;
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    return (
      m.includes("broken pipe") ||
      m.includes("connection reset") ||
      m.includes("connection refused") ||
      m.includes("connection closed") ||
      m.includes("bad resource") || // underlying socket already closed
      m.includes("os error 32") || // broken pipe
      m.includes("os error 104") || // connection reset by peer
      // deno-postgres terminated-client states:
      m.includes("has been terminated") ||
      m.includes("session was terminated")
    );
  }
  return false;
}

/**
 * Borrow a *validated, live* client from the pool. Drop-in replacement for
 * `pool.connect()`: the caller still owns the returned client and must
 * `release()` it (typically in a `finally`).
 *
 * On a dead pooled connection it evicts and lets the pool reconnect, retrying
 * up to `attempts` times with a small backoff. Non-connection errors (e.g. a
 * SQL error from the probe, which would be unexpected) propagate immediately.
 * Throws if no live connection can be obtained within `attempts`.
 */
export async function getClient(
  pool: Pool,
  attempts: number = DEFAULT_ATTEMPTS,
): Promise<PoolClient> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.queryArray(VALIDATION_QUERY);
      return client; // healthy
    } catch (e) {
      lastErr = e;
      if (client && !isConnectionError(e)) {
        client.release();
        throw e; // a real error from the probe — don't mask it
      }
      // Dead/stale socket (or the pool couldn't establish one). Force the
      // driver's `connected` flag to false via end() so the pool's pop()
      // re-establishes this client on the next borrow, then release it back.
      if (client) {
        try {
          await client.end();
        } catch { /* already closed — ignore */ }
        client.release();
      }
      if (i < attempts - 1) await delay(BASE_BACKOFF_MS * (i + 1));
    }
  }
  throw lastErr;
}
