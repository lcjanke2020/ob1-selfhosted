// Native-token authentication without an OIDC issuer. The verifier is injected
// so this unit test exercises request middleware without importing db.ts (whose
// production boot probe deliberately opens a real PostgreSQL connection).

import { assertEquals } from "@std/assert";
import type { AppVariables } from "./auth.ts";
import { makeAuthTestApp, withEnv } from "./api_test_support.ts";

const TOKEN = `ob1_AAECAwQF_${"s".repeat(43)}`;
const TEST_ENV = {
  DB_PASSWORD: "test-password",
  ENABLE_NATIVE_TOKENS: "true",
  MCP_ACCESS_KEY_PRINCIPAL: "local-operator",
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
};

async function testNativeTokenAuth(t: Deno.TestContext): Promise<void> {
  await withEnv([], TEST_ENV, async () => {
    const { createRequireAuth, requireAuth } = await import("./auth.ts");
    let active = true;
    let lookups = 0;
    const middleware = createRequireAuth((presented) => {
      lookups++;
      return Promise.resolve(
        active && presented === TOKEN ? { label: "nightly agent" } : null,
      );
    });
    const app = makeAuthTestApp<{ Variables: AppVariables }>(
      middleware,
      (c) =>
        c.json({
          door: c.get("door"),
          sub: c.get("sub"),
          tokenLabel: c.get("tokenLabel"),
        }),
    );

    await t.step(
      "active token carries its server-verified label",
      async () => {
        const response = await app.request("/", {
          headers: { "x-brain-key": TOKEN },
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), {
          door: "tailnet",
          sub: null,
          tokenLabel: "nightly agent",
        });
      },
    );

    await t.step(
      "revoked token fails on the next request without a cache",
      async () => {
        active = false;
        const response = await app.request("/", {
          headers: { "x-brain-key": TOKEN },
        });
        assertEquals(response.status, 401);
        assertEquals(lookups, 2);
      },
    );

    await t.step("store failure fails closed", async () => {
      const failingApp = makeAuthTestApp<{ Variables: AppVariables }>(
        createRequireAuth(() =>
          Promise.reject(new Error("database unavailable"))
        ),
      );
      const response = await failingApp.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 401);
    });

    await t.step("malformed verifier identity fails closed", async () => {
      const malformedApp = makeAuthTestApp<{ Variables: AppVariables }>(
        createRequireAuth(() => Promise.resolve({ label: "bad\nlabel" })),
      );
      const response = await malformedApp.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 401);
    });

    await t.step(
      "missing verifier cannot accidentally authorize",
      async () => {
        const unwiredApp = makeAuthTestApp<{ Variables: AppVariables }>(
          requireAuth,
        );
        const response = await unwiredApp.request("/", {
          headers: { "x-brain-key": TOKEN },
        });
        assertEquals(response.status, 401);
      },
    );
  })();
}

Deno.test(
  "requireAuth accepts native tokens and observes revocation on the next request",
  testNativeTokenAuth,
);
