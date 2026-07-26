import { Pool } from "postgres";
import {
  DB_BOOT_PROBE_TIMEOUT_MS,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_POOL_SIZE,
  DB_PORT,
  DB_USER,
} from "./config.ts";
import { probeDbAtBoot } from "./db_boot_probe.ts";

// The pool is EAGER (no `lazy` third arg) on purpose, and the boot probe
// below exists because of that:
//
//  * The constructor starts connecting all DB_POOL_SIZE clients as a
//    fire-and-forget promise. With Postgres unreachable at boot, that
//    rejection is unhandled → Deno kills the process with a bare
//    ConnectionRefused stack. The probe adopts the init promise
//    (pool.connect() awaits it) and turns the failure into a clear
//    fail-fast: one actionable error line + Deno.exit(1), retried by the
//    deploy supervisor (compose `restart: unless-stopped`). This matches
//    the config.ts / auth.ts JWKS-probe posture: misconfiguration crashes
//    fast with a clear message.
//
//  * `lazy: true` looks like the one-line alternative but is a trap in
//    deno-postgres v0.19.3: when a lazy borrow's connect() fails inside
//    DeferredAccessStack.pop(), the popped client is never pushed back —
//    the slot leaks. Under traffic with the DB down (the /ready
//    healthcheck alone borrows via getClient), the pool drains slot by
//    slot until every borrow parks forever in the stack's wait-queue: a
//    hung server that `restart: unless-stopped` will never restart.
//    Post-boot blips stay owned by db_pool.ts getClient().
export const pool = new Pool(
  {
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  },
  DB_POOL_SIZE,
);

// Top-level await: the probe is a STARTUP GATE, not a background check.
// Module evaluation (and therefore index.ts — posture lines, Deno.serve)
// cannot proceed until the probe settles, exactly like auth.ts's awaited
// JWKS probe; the two top-level awaits evaluate concurrently, so boot
// latency is max(probes), not the sum. The deadline bounds the await —
// without it, a connect that hangs (driver has no client-side connect
// timeout) would hang boot forever, a state the restart policy can't see.
try {
  await probeDbAtBoot(pool, `${DB_HOST}:${DB_PORT}`, {
    deadlineMs: DB_BOOT_PROBE_TIMEOUT_MS,
  });
  console.log(
    `[db] postgres reachable and hybrid-search schema ready at ${DB_HOST}:${DB_PORT}`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(
    "[db] exiting; the deploy supervisor (compose restart policy) will retry",
  );
  Deno.exit(1);
}

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtMatch = ThoughtRecord & {
  // Cosine similarity is retained for compatibility and diagnostics. Hybrid
  // ordering is driven by rrf_score, so a lexical-only hit may be returned
  // even when this value is below the vector-leg threshold.
  similarity: number;
  rrf_score: number;
};
