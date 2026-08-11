// Tests for the OAUTH_ALLOWED_SUBJECTS authorization gate with a NON-EMPTY
// allowlist (the fail-closed empty-list posture lives in
// auth_subject_allowlist_failclosed_test.ts — module-level config caching
// means one env state per test file).
//
// The property under test: verification and authorization are separate
// gates. A token that passes every cryptographic check (signature, issuer,
// audience, exp, sub shape) is still rejected unless its verified `sub` is
// on the operator's allowlist — and the rejection is byte-indistinguishable
// from any other 401 (same JSON-RPC envelope, no subject echo), because
// "your identity is real but not admitted" must not become a probing
// side-channel for which accounts exist.
//
// Same JWKS-mock strategy as auth_oauth_only_test.ts: real RS256 signing +
// verification via jose, with globalThis.fetch intercepted for the key set.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { Hono, type MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const ALLOWED_USER = "auth0|allowlisted-user";
const ALLOWED_MACHINE = "allowlisted-machine@clients";
const OUTSIDER = "auth0|verified-but-not-admitted";

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
  "JWKS_FETCH_TIMEOUT_MS",
];

// Echo handler so admitted requests expose the context the middleware set —
// asserting on door/sub proves the allowlisted identity actually crossed
// into the request context, not merely that some 200 came back.
function makeApp(mw: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) =>
    c.json({
      door: c.get("door" as never),
      sub: c.get("sub" as never),
    }));
  return app;
}

Deno.test("requireAuth OAUTH_ALLOWED_SUBJECTS gate (non-empty allowlist)", async (t) => {
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

  // OAuth-only deployment shape, allowlist admitting exactly two subjects.
  Deno.env.delete("MCP_ACCESS_KEY");
  Deno.env.set("ENABLE_NATIVE_TOKENS", "false");
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("AUTH0_ISSUER", ISSUER);
  Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
  Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  Deno.env.set(
    "OAUTH_ALLOWED_SUBJECTS",
    `${ALLOWED_USER},${ALLOWED_MACHINE}`,
  );
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

  const { requireAuth } = await import("./auth.ts");
  const app = makeApp(requireAuth);

  async function signToken(
    sub: string,
    extraClaims: Record<string, unknown> = {},
  ): Promise<string> {
    return await new SignJWT({ sub, ...extraClaims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey as CryptoKey);
  }

  try {
    await t.step(
      "allowlisted sub → 200, identity reaches context",
      async () => {
        const res = await app.request("/", {
          headers: {
            "authorization": `Bearer ${await signToken(ALLOWED_USER)}`,
          },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "funnel");
        assertEquals(body.sub, ALLOWED_USER);
      },
    );

    await t.step(
      "valid tenant token, non-allowlisted sub → 401 with the uniform envelope",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${await signToken(OUTSIDER)}` },
        });
        assertEquals(res.status, 401);
        assertEquals(res.headers.get("cache-control"), "no-store");
        // OAuth is enabled, so the discovery challenge is present — same as
        // every other rejection reason.
        assertStringIncludes(
          res.headers.get("www-authenticate") ?? "",
          'Bearer realm="open-brain"',
        );
        const body = await res.json();
        assertEquals(body.jsonrpc, "2.0");
        assertEquals(body.error?.code, -32001);
        assertEquals(
          body.error?.message,
          "Unauthorized: missing or invalid authentication.",
        );
      },
    );

    await t.step(
      "rejection must not echo the verified subject (no side-channel)",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${await signToken(OUTSIDER)}` },
        });
        assertEquals(res.status, 401);
        const raw = await res.text();
        assertEquals(raw.includes(OUTSIDER), false);
      },
    );

    await t.step(
      "client-credentials claim cannot bypass authorization",
      async () => {
        // gty selects the service door (attribution) — it must not matter to
        // the allowlist (authorization).
        const res = await app.request("/", {
          headers: {
            "authorization": `Bearer ${await signToken(
              "machine-not-admitted@clients",
              { gty: "client-credentials" },
            )}`,
          },
        });
        assertEquals(res.status, 401);
      },
    );

    await t.step("allowlist match is exact and case-sensitive", async () => {
      const res = await app.request("/", {
        headers: {
          "authorization": `Bearer ${await signToken(
            ALLOWED_USER.toUpperCase(),
          )}`,
        },
      });
      assertEquals(res.status, 401);
    });

    await t.step(
      "allowlisted machine subject → 200 through the service classification",
      async () => {
        const res = await app.request("/", {
          headers: {
            "authorization": `Bearer ${await signToken(ALLOWED_MACHINE, {
              gty: "client-credentials",
            })}`,
          },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "service");
        assertEquals(body.sub, ALLOWED_MACHINE);
      },
    );

    await t.step(
      "allowlist cannot resurrect a cryptographically bad token",
      async () => {
        // Allowlisted sub, expired token: verification runs first and wins.
        const expired = await new SignJWT({ sub: ALLOWED_USER })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${expired}` },
        });
        assertEquals(res.status, 401);
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
