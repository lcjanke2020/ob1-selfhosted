// Native-token authentication without an OIDC issuer. The verifier is injected
// so this unit test exercises request middleware without importing db.ts (whose
// production boot probe deliberately opens a real PostgreSQL connection).

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import type { AppVariables } from "./auth.ts";

const TOKEN = `ob1_AAECAwQF_${"s".repeat(43)}`;

const ENV_KEYS = [
  "DB_PASSWORD",
  "ENABLE_NATIVE_TOKENS",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "OAUTH_ALLOWED_SUBJECTS",
  "OBS_AUTH_EVENTS_ENABLED",
  "METADATA_FALLBACK_POLICY",
];

Deno.test("requireAuth accepts native tokens and observes revocation on the next request", async (t) => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  );
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("ENABLE_NATIVE_TOKENS", "true");
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.set("MCP_ACCESS_KEY_PRINCIPAL", "local-operator");
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  Deno.env.delete("OAUTH_ALLOWED_SUBJECTS");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");

  try {
    const { createRequireAuth, requireAuth } = await import("./auth.ts");
    let active = true;
    let lookups = 0;
    const middleware = createRequireAuth((presented) => {
      lookups++;
      return Promise.resolve(
        active && presented === TOKEN ? { label: "nightly agent" } : null,
      );
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", middleware);
    app.get("/", (c) =>
      c.json({
        door: c.get("door"),
        sub: c.get("sub"),
        tokenLabel: c.get("tokenLabel"),
      }));

    await t.step("active token carries its server-verified label", async () => {
      const response = await app.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        door: "tailnet",
        sub: null,
        tokenLabel: "nightly agent",
      });
    });

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
      const failingApp = new Hono<{ Variables: AppVariables }>();
      failingApp.use(
        "*",
        createRequireAuth(() =>
          Promise.reject(new Error("database unavailable"))
        ),
      );
      failingApp.get("/", (c) => c.json({ ok: true }));
      const response = await failingApp.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 401);
    });

    await t.step("malformed verifier identity fails closed", async () => {
      const malformedApp = new Hono<{ Variables: AppVariables }>();
      malformedApp.use(
        "*",
        createRequireAuth(() => Promise.resolve({ label: "bad\nlabel" })),
      );
      malformedApp.get("/", (c) => c.json({ ok: true }));
      const response = await malformedApp.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 401);
    });

    await t.step("missing verifier cannot accidentally authorize", async () => {
      const unwiredApp = new Hono<{ Variables: AppVariables }>();
      unwiredApp.use("*", requireAuth);
      unwiredApp.get("/", (c) => c.json({ ok: true }));
      const response = await unwiredApp.request("/", {
        headers: { "x-brain-key": TOKEN },
      });
      assertEquals(response.status, 401);
    });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
