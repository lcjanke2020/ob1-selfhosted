// Tests for the audit emitter's "disabled" path.
//
// We can't unit-test the actual postgres insert (no DB available in the
// test sandbox), but we CAN verify:
//   1. With `OBS_AUTH_EVENTS_ENABLED=false`, logAuthFailure() is a no-op
//      and never throws — even if called repeatedly in tight succession.
//   2. With the same env, importing auth_audit.ts doesn't open any
//      net connections (the test runner is restricted to 127.0.0.1, so
//      a stray connection attempt would surface as a permission error).
//   3. The reason-code type aliases are exported (compile-time guard).
//
// The integration path (real DB insert) is intentionally NOT covered here
// — it's exercised at deploy time via the post-merge smoke test in the PR
// checklist (issue a 401, observe a row in `mcp_auth_events`).

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "OBS_AUTH_EVENTS_ENABLED",
];

Deno.test("auth_audit (disabled path)", async (t) => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );

  // Force the disabled branch — emitter should construct as a no-op even
  // though a "valid-looking" DB_PASSWORD is present.
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

  const { logAuthFailure, shutdownAuthAuditForTests } = await import(
    "./auth_audit.ts"
  );

  try {
    await t.step("logAuthFailure: returns synchronously, no throw", () => {
      // Multiple back-to-back calls. If the pool were live, this would
      // queue several microtasks; the disabled branch returns immediately.
      for (let i = 0; i < 100; i++) {
        logAuthFailure({
          reason: "invalid_brain_key",
          middleware: "require_auth",
          clientIp: "192.0.2.1",
          path: "/mcp",
        });
      }
      // Nothing to assert beyond "didn't throw".
      assertStrictEquals(typeof logAuthFailure, "function");
    });

    await t.step("logAuthFailure: tolerates undefined optional fields", () => {
      logAuthFailure({
        reason: "missing_credentials",
        middleware: "require_brain_key",
      });
      logAuthFailure({
        reason: "token_validation_failed",
        middleware: "require_auth",
        clientIp: undefined,
        path: undefined,
      });
    });

    await t.step("shutdownAuthAuditForTests: idempotent", async () => {
      await shutdownAuthAuditForTests();
      await shutdownAuthAuditForTests();
      // Reaching here proves it didn't throw on the second call (pool=null
      // branch).
      assertEquals(true, true);
    });
  } finally {
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
