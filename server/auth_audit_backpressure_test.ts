// Backpressure tests for the audit emitter.
//
// Lives in a separate test file from auth_audit_test.ts because Deno
// caches the module after first import: the disabled-path test sets
// OBS_AUTH_EVENTS_ENABLED=false at module load, which permanently
// fixes `pool = null` and `FORCE_DISABLED = true` for the lifetime of
// that test-runner process. Putting the backpressure tests in their
// own file gives them a fresh module graph with the enabled-path
// config (pool != null, FORCE_DISABLED = false).
//
// SCOPE: only the synchronous side of the backpressure logic is
// asserted here. Verifying that the pool's connect() eventually fails
// and decrements inFlight requires a deterministic connection-error
// path, which the test sandbox doesn't provide. The drain-side is
// exercised by the production smoke test instead (verification step 4
// in the rollup plan).
//
// We deliberately pin DB_HOST=127.0.0.1 and DB_PORT=1 (an unprivileged
// port that is never expected to have a listener) so the pool's
// queued connect() attempts get an immediate ECONNREFUSED instead of
// hanging on DNS resolution for the default "postgres" hostname. On
// CI hosts or developer machines where "postgres" doesn't resolve
// quickly, the default would have introduced multi-second DNS
// timeouts on every queued microtask.

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "OBS_AUTH_EVENTS_ENABLED",
  "OBS_AUTH_EVENTS_MAX_IN_FLIGHT",
];

Deno.test("auth_audit backpressure (synchronous)", async (t) => {
  // Snapshot env BEFORE setting anything that could throw at import, and
  // enter the try/finally before the dynamic import so an import-time
  // failure still restores the env.
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  try {
    // Force the enabled path with a low cap so a small burst trips it.
    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "true");
    Deno.env.set("OBS_AUTH_EVENTS_MAX_IN_FLIGHT", "3");
    // Guaranteed-fast-fail target for the pool's connect() attempts so
    // the test never hangs on DNS lookup for the default "postgres"
    // hostname (see file-level doc).
    Deno.env.set("DB_HOST", "127.0.0.1");
    Deno.env.set("DB_PORT", "1");

    const {
      logAuthFailure,
      getAuditMetricsForTests,
      shutdownAuthAuditForTests,
    } = await import("./auth_audit.ts");

    await t.step("cap is read from env at module load", () => {
      const m = getAuditMetricsForTests();
      assertStrictEquals(m.cap, 3);
    });

    await t.step(
      "burst beyond cap admits up to cap and drops the rest; cumulative across bursts",
      () => {
        // The burst-of-10 and the cumulative-drop check MUST live in the
        // same sync turn (one t.step body).
        // `t.step` returns an awaited promise; between two steps the event
        // loop yields and the microtasks queued by the first burst run,
        // letting pool.connect() to 127.0.0.1:1 fast-fail and decrement
        // `inFlight`. The second burst then can't assume `inFlight` is
        // still at cap. Folding both assertions into one synchronous body
        // means no intervening await, so the cap-check semantics are
        // deterministic.

        const before = getAuditMetricsForTests();

        // First burst: 10 sync calls in one turn — the first 3 admit
        // (inFlight 0→1→2→3), the remaining 7 see inFlight >= cap and
        // drop. Microtasks don't run between iterations of a synchronous
        // for-loop.
        for (let i = 0; i < 10; i++) {
          logAuthFailure({
            reason: "invalid_brain_key",
            middleware: "require_auth",
            clientIp: "192.0.2.1",
            path: "/mcp",
          });
        }
        const afterFirstBurst = getAuditMetricsForTests();
        // 7 dropped this burst (10 - cap of 3).
        assertEquals(afterFirstBurst.droppedTotal - before.droppedTotal, 7);
        // 3 admitted are now in flight.
        assertEquals(afterFirstBurst.inFlight - before.inFlight, 3);

        // Second burst, same sync turn: inFlight is still at cap because
        // we haven't yielded. All 4 new calls hit the cap-check and drop.
        for (let i = 0; i < 4; i++) {
          logAuthFailure({
            reason: "token_validation_failed",
            middleware: "require_auth",
          });
        }
        const afterSecondBurst = getAuditMetricsForTests();
        // All 4 dropped this burst; cumulative total grew by 11 (7 + 4).
        assertEquals(
          afterSecondBurst.droppedTotal - afterFirstBurst.droppedTotal,
          4,
        );
        assertEquals(afterSecondBurst.droppedTotal - before.droppedTotal, 11);
      },
    );

    await t.step("shutdown is idempotent", async () => {
      await shutdownAuthAuditForTests();
      await shutdownAuthAuditForTests();
      assertEquals(true, true);
    });
  } finally {
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
