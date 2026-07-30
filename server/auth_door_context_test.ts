// Tests for the door + sub Hono context vars that `requireAuth`
// sets on each successful auth branch. Downstream tool handlers read these
// (indirectly, via the createMcpServer(pool, { door, sub }) factory closure
// in mcp-server.ts) and stamp them into thoughts.metadata so a
// "mobile-originated writes" dashboard tile can discriminate
// Funnel/mobile captures from tailnet captures.
//
// Coverage:
//   1. Successful x-brain-key  → door = "tailnet", sub = null.
//   2. Successful user Bearer  → door = "funnel",  sub = <verified jwt.sub>.
//   3. Auth0 M2M Bearer        → door = "service", sub = <verified client sub>.
//   4. Allowlisted M2M subject → door = "service" without provider grant claim.
//   5. Forged M2M-shaped JWT   → HTTP 401 before machine classification.
//   6. Bearer without `sub`    → HTTP 401 (envelope body), context vars never set
//      (the `requiredClaims: ["sub"]` change on `verifyBearer` is what
//      makes Auth0 misconfig / forged-sub-less tokens fail closed).
//
// Strategy mirrors auth_oauth_test.ts: mock globalThis.fetch to serve a
// local JWKS, dynamic-import auth.ts after env is set, mint real RS256
// JWTs via jose. The test app installs requireAuth and a sentinel
// downstream handler that echoes c.get("door") + c.get("sub") into the
// response body, so we can assert on what `requireAuth` actually wrote
// to the context (the production capture-path read of these vars happens
// inside the @modelcontextprotocol/sdk tool callback, which has no DI
// seam — testing the context-set + factory-arg propagation here, and
// the metadata-literal extension by inspection, is the scoped-right
// alternative to inventing a module-mocking harness).

import { assertEquals } from "jsr:@std/assert@1";
import { Hono, type MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AuthContext } from "./auth_context.ts";

const BRAIN_KEY = "b".repeat(64);
const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "OBS_AUTH_EVENTS_ENABLED",
  "METADATA_FALLBACK_POLICY",
  "JWKS_FETCH_TIMEOUT_MS",
];

// Sentinel downstream handler. Reads the auth context vars `requireAuth`
// is expected to populate and surfaces them in the response so we can
// assert on what was written. The `sub` shape matters: null is distinct
// from undefined and from "" — keep all three observable.
function makeApp(
  mw: MiddlewareHandler<{ Variables: AuthContext }>,
) {
  const app = new Hono<{ Variables: AuthContext }>();
  app.use("*", mw);
  app.get("/", (c) =>
    c.json({
      door: c.get("door"),
      sub: c.get("sub"),
      subType: c.get("sub") === null ? "null" : typeof c.get("sub"),
    }));
  return app;
}

Deno.test("requireAuth sets door + sub on Hono context (door/sub stamping)", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
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

  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", BRAIN_KEY);
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("AUTH0_ISSUER", ISSUER);
  Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
  Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
  Deno.env.set("OAUTH_SERVICE_ACCOUNT_SUBJECTS", "generic-service-subject");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

  const { requireAuth } = await import("./auth.ts");
  const app = makeApp(requireAuth);

  try {
    await t.step(
      "x-brain-key success → door = 'tailnet', sub = null",
      async () => {
        const res = await app.request("/", {
          headers: { "x-brain-key": BRAIN_KEY },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "tailnet");
        assertEquals(body.sub, null);
        assertEquals(
          body.subType,
          "null",
          "tailnet sub must be JSON null (not undefined / empty string)",
        );
      },
    );

    await t.step(
      "Bearer success → door = 'funnel', sub = <verified jwt.sub>",
      async () => {
        const expectedSub = "auth0|leo-source-marker-test";
        const token = await new SignJWT({ sub: expectedSub })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "funnel");
        assertEquals(body.sub, expectedSub);
        assertEquals(body.subType, "string");
      },
    );

    await t.step(
      "Auth0 client-credentials Bearer → door = 'service' with verified client sub",
      async () => {
        const expectedSub = "auth0-m2m-client@clients";
        const token = await new SignJWT({
          sub: expectedSub,
          gty: "client-credentials",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "service");
        assertEquals(body.sub, expectedSub);
      },
    );

    await t.step(
      "configured generic service subject → door = 'service' without gty claim",
      async () => {
        const expectedSub = "generic-service-subject";
        const token = await new SignJWT({ sub: expectedSub })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "service");
        assertEquals(body.sub, expectedSub);
      },
    );

    await t.step(
      "generic service-subject mapping is exact and case-sensitive",
      async () => {
        const token = await new SignJWT({ sub: "Generic-Service-Subject" })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        assertEquals((await res.json()).door, "funnel");
      },
    );

    await t.step(
      "unverified gty claim cannot select the service door",
      async () => {
        const { privateKey: attackerKey } = await generateKeyPair("RS256");
        const token = await new SignJWT({
          sub: "forged-machine",
          gty: "client-credentials",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(attackerKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 401);
        const body = await res.json();
        assertEquals(body.error?.code, -32001);
      },
    );

    await t.step(
      "Bearer without `sub` claim → unauthorized (jose requiredClaims gate)",
      async () => {
        // Auth0 always issues `sub`. A token missing it indicates either an
        // upstream AS misconfiguration or a forged/replayed token. The
        // source-marker change adds "sub" to verifyBearer's requiredClaims so
        // jose fails closed before the source-marker stamp ever runs.
        // (Mirror of the "no exp" test in auth_oauth_test.ts.)
        const token = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        // requireAuth returns HTTP 401 with the JSON-RPC error envelope
        // body (code -32001) on token validation failure (PR55-AUTH-001). The
        // downstream sentinel handler never runs, so door/sub are never set.
        assertEquals(res.status, 401);
        const body = await res.json();
        assertEquals(body.jsonrpc, "2.0");
        assertEquals(body.error?.code, -32001);
      },
    );

    await t.step(
      "tailnet + invalid Bearer dual-header → door = 'tailnet' (fast path wins)",
      async () => {
        // Defense-in-depth interaction: if both headers arrive (only
        // possible behind a misconfigured edge or a single-port dev
        // deployment), the x-brain-key fast path short-circuits and
        // the door must be "tailnet" — not "funnel".
        const res = await app.request("/", {
          headers: {
            "x-brain-key": BRAIN_KEY,
            "authorization": "Bearer ignored-when-brain-key-wins",
          },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "tailnet");
        assertEquals(body.sub, null);
      },
    );

    await t.step(
      "invalid brain-key + valid Bearer → door = 'funnel' (fall-through honors Bearer)",
      async () => {
        const expectedSub = "auth0|fallthrough-test";
        const token = await new SignJWT({ sub: expectedSub })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong-value",
            "authorization": `Bearer ${token}`,
          },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "funnel");
        assertEquals(body.sub, expectedSub);
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
