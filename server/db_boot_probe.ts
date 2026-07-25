// Boot-time DB reachability probe.
//
// deno-postgres's Pool constructor starts connecting every client at
// construction time as a fire-and-forget promise (`#ready = #initialize()`).
// Nothing awaits that promise until the first `pool.connect()` call, so when
// Postgres is unreachable at boot the rejection is unhandled and Deno kills
// the process with a bare ConnectionRefused stack — after the server has
// already printed its boot posture and bound the port.
//
// This probe is the app-owned handler for that failure: `pool.connect()`
// awaits the constructor's init promise, so calling the probe synchronously
// right after `new Pool(...)` adopts the rejection before it can become
// unhandled. On failure it rejects with an operator-facing message naming
// the target and the env vars to check; the caller (db.ts) decides the
// policy (fail-fast exit). Mirrors auth.ts `probeJwksReachability`.
//
// The probe MUST be invoked synchronously after Pool construction — an
// intervening `await` (e.g. another module's top-level probe) would leave a
// window where the constructor's rejection fires unobserved.

import type { Pool } from "postgres";

// A refused connection rejects near-instantly, but a blackholed host (tailnet
// down, qubes-firewall closed) hangs in TCP connect for minutes with nothing
// in the log. Warn once so the operator sees what boot is stuck on.
const DEFAULT_SLOW_WARN_AFTER_MS = 10_000;

/**
 * Borrow one client from `pool` and validate it with `SELECT 1`, surfacing
 * any boot-time connection failure as a rejection the caller owns.
 *
 * `target` is the human-readable `host:port` used in messages. Resolves on
 * success; rejects with operator guidance on failure. Never exits — policy
 * belongs to the caller.
 */
export async function probeDbAtBoot(
  pool: Pool,
  target: string,
  slowWarnAfterMs: number = DEFAULT_SLOW_WARN_AFTER_MS,
): Promise<void> {
  const slowWarn = setTimeout(() => {
    console.warn(
      `[db] still trying to reach Postgres at ${target} after ` +
        `${Math.round(slowWarnAfterMs / 1000)}s — check DB_HOST/DB_PORT and ` +
        `the network path (tailnet up? firewall open? DB host booted?)`,
    );
  }, slowWarnAfterMs);
  try {
    const client = await pool.connect();
    try {
      await client.queryArray("SELECT 1");
    } finally {
      client.release();
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[db] Postgres at ${target} is unreachable or rejected the ` +
        `connection: ${reason}. Check DB_HOST/DB_PORT (server up? reachable ` +
        `from this container/qube?) and DB_USER/DB_PASSWORD/DB_NAME.`,
    );
  } finally {
    clearTimeout(slowWarn);
  }
}
