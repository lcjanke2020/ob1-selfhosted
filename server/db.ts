import { Pool } from "postgres";
import {
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

probeDbAtBoot(pool, `${DB_HOST}:${DB_PORT}`).then(
  () => console.log(`[db] postgres reachable at ${DB_HOST}:${DB_PORT}`),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(
      "[db] exiting; the deploy supervisor (compose restart policy) will retry",
    );
    Deno.exit(1);
  },
);

export type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

export type ThoughtMatch = ThoughtRecord & { similarity: number };
