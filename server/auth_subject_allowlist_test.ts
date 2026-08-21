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
import {
  makeAuthTestApp,
  makeJwksFixture,
  withEnv,
} from "./api_test_support.ts";

const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const ALLOWED_USER = "auth0|allowlisted-user";
const ALLOWED_MACHINE = "allowlisted-machine@clients";
const OUTSIDER = "auth0|verified-but-not-admitted";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  ENABLE_NATIVE_TOKENS: "false",
  AUTH0_ISSUER: ISSUER,
  AUTH0_JWKS_URI: JWKS_URL,
  AUTH0_AUDIENCE: AUDIENCE,
  OAUTH_ALLOWED_SUBJECTS: `${ALLOWED_USER},${ALLOWED_MACHINE}`,
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  JWKS_FETCH_TIMEOUT_MS: "2000",
};

Deno.test(
  "requireAuth OAUTH_ALLOWED_SUBJECTS gate (non-empty allowlist)",
  withEnv([], TEST_ENV, runSubjectAllowlistTest),
);

async function runSubjectAllowlistTest(t: Deno.TestContext): Promise<void> {
  const fixture = await makeJwksFixture({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
  });
  const restoreFetch = fixture.installFetchMock();
  const { requireAuth } = await import("./auth.ts");
  // Echo the middleware-populated identity to prove the request crossed
  // the authorization gate, rather than merely observing a 200 status.
  const app = makeAuthTestApp(requireAuth, (context) =>
    context.json({
      door: context.get("door"),
      sub: context.get("sub"),
    }));

  const signToken = (
    sub: string,
    extraClaims: Record<string, unknown> = {},
  ) => fixture.signToken({ claims: { sub, ...extraClaims } });

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
          headers: {
            "authorization": `Bearer ${await signToken(OUTSIDER)}`,
          },
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
          headers: {
            "authorization": `Bearer ${await signToken(OUTSIDER)}`,
          },
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

    await t.step(
      "allowlist match is exact and case-sensitive",
      async () => {
        const res = await app.request("/", {
          headers: {
            "authorization": `Bearer ${await signToken(
              ALLOWED_USER.toUpperCase(),
            )}`,
          },
        });
        assertEquals(res.status, 401);
      },
    );

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
        const expired = await fixture.signToken({
          claims: { sub: ALLOWED_USER },
          issuedAt: Math.floor(Date.now() / 1000) - 7200,
          expirationTime: Math.floor(Date.now() / 1000) - 3600,
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${expired}` },
        });
        assertEquals(res.status, 401);
      },
    );
  } finally {
    restoreFetch();
  }
}
