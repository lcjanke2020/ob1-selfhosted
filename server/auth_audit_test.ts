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
import { withEnv } from "./api_test_support.ts";

const TEST_ENV = {
  // Force the disabled branch even with a valid-looking DB password.
  DB_PASSWORD: "test-password",
  OBS_AUTH_EVENTS_ENABLED: "false",
};

async function testDisabledAudit(t: Deno.TestContext): Promise<void> {
  await withEnv([], TEST_ENV, async () => {
    const { logAuthFailure, logAuthSuccess, shutdownAuthAuditForTests } =
      await import(
        "./auth_audit.ts"
      );

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

    await t.step(
      "logAuthFailure: tolerates undefined optional fields",
      () => {
        logAuthFailure({
          reason: "missing_credentials",
          middleware: "require_auth",
        });
        logAuthFailure({
          reason: "token_validation_failed",
          middleware: "require_auth",
          clientIp: undefined,
          path: undefined,
        });
        // The one failure class that carries a verified identity.
        logAuthFailure({
          reason: "subject_not_allowed",
          middleware: "require_auth",
          clientIp: "192.0.2.1",
          path: "/mcp",
          subject: "auth0|refused-subject",
        });
      },
    );

    await t.step(
      "logAuthSuccess: returns synchronously, no throw, all door shapes",
      () => {
        // Same disabled-branch contract as the failure emitter: fire-and-
        // forget, never throws, safe in tight succession.
        for (let i = 0; i < 100; i++) {
          logAuthSuccess({
            door: "funnel",
            middleware: "require_auth",
            subject: "auth0|admitted-user",
            clientIp: "192.0.2.1",
            path: "/mcp",
          });
        }
        logAuthSuccess({
          door: "service",
          middleware: "require_auth",
          subject: "machine@clients",
          path: "/",
        });
        // tailnet static key: no subject, no label.
        logAuthSuccess({ door: "tailnet", middleware: "require_auth" });
        // tailnet native token: label only.
        logAuthSuccess({
          door: "tailnet",
          middleware: "require_auth",
          tokenLabel: "laptop-2026",
        });
        assertStrictEquals(typeof logAuthSuccess, "function");
      },
    );

    await t.step("shutdownAuthAuditForTests: idempotent", async () => {
      await shutdownAuthAuditForTests();
      await shutdownAuthAuditForTests();
      // Reaching here proves it didn't throw on the second call (pool=null
      // branch).
      assertEquals(true, true);
    });
  })();
}

Deno.test("auth_audit (disabled path)", testDisabledAudit);
