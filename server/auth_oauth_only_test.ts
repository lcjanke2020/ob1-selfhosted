// Tests for the `requireAuth` middleware with ONLY the OAuth door enabled —
// MCP_ACCESS_KEY unset, so the x-brain-key door is OFF. This is the
// compose-tailnet (funnel) + qubes deployment posture: a single OAuth auth path,
// with the static x-brain-key removed entirely.
//
// The load-bearing assertion is that a presented `x-brain-key` is IGNORED when
// the door is disabled — a leaked or stale key from an older deployment can't be
// used against an Auth0-only server, even if Caddy fails to strip the header.
//
// Strategy mirrors auth_oauth_test.ts: mock globalThis.fetch to serve a local
// JWKS, dynamic-import auth.ts after env is set, mint real RS256 JWTs via jose.
// Run with `deno task test`.

import { assertEquals } from "jsr:@std/assert@1";
import { Hono, type MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
  "JWKS_FETCH_TIMEOUT_MS",
];

function makeApp(mw: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

Deno.test("requireAuth (OAuth only — x-brain-key door disabled)", async (t) => {
  const origFetch = globalThis.fetch;
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );

  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key-1";
  publicJwk.use = "sig";
  const jwksBody = JSON.stringify({ keys: [publicJwk] });

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url === JWKS_URL) {
      return Promise.resolve(
        new Response(jwksBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  // OAuth door ON, x-brain-key door OFF (MCP_ACCESS_KEY deliberately deleted).
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("AUTH0_ISSUER", ISSUER);
  Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
  Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

  const { requireAuth } = await import("./auth.ts");
  const app = makeApp(requireAuth);

  async function signToken(): Promise<string> {
    return await new SignJWT({ sub: "user-under-test" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey as CryptoKey);
  }

  try {
    await t.step("valid Bearer → 200", async () => {
      const token = await signToken();
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
    });

    await t.step(
      "x-brain-key header alone → 401 (door disabled, header ignored)",
      async () => {
        // No key is configured, so any x-brain-key value is ignored and the
        // request reads as missing_credentials → HTTP 401.
        const res = await app.request("/", {
          headers: { "x-brain-key": "any-value-since-no-key-is-configured" },
        });
        assertEquals(res.status, 401);
      },
    );

    await t.step(
      "x-brain-key + valid Bearer → 200 (Bearer honored, key irrelevant)",
      async () => {
        const token = await signToken();
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "ignored",
            "authorization": `Bearer ${token}`,
          },
        });
        assertEquals(res.status, 200);
      },
    );
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
