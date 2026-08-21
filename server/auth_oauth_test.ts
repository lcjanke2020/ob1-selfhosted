// Tests for the `requireAuth` middleware with BOTH auth doors enabled — OAuth
// (Bearer) AND the x-brain-key door (a valid compose-local config that opts into
// OAuth on top of the static key). Covers the full (brain-key × Bearer × OAuth)
// matrix an early review asked to bottle, plus the JWT failure modes (expired,
// wrong issuer/audience, malformed). Run with `deno task test`.
//
// auth failure shape is uniform since audit finding PR55-AUTH-001: every
// rejection — missing, invalid, unverifiable, or expired credentials —
// returns HTTP 401 with a JSON-RPC 2.0 error envelope body (code -32001,
// single neutral message), plus the WWW-Authenticate discovery payload
// when OAuth is enabled. The transport-level 401 is the signal
// OAuth-capable MCP clients key credential refresh / re-authorization
// off; an earlier revision kept tried-but-rejected credentials at
// HTTP 200 and stranded the claude.ai connector after token expiry.
//
// Strategy: AUTH0_JWKS_URI is set to a fake https URL that never resolves
// to a real host; we override `globalThis.fetch` to intercept the JWKS
// request and serve a local key set. This lets us use real RS256 signing
// + verification end-to-end via `jose` (already a prod dep) without
// touching production code or running a real TLS server.
//
// Structure: a single outer `Deno.test` with `t.step()` subtests so that
// the fetch mock + env vars get cleaned up in a guaranteed try/finally
// after the full suite runs. Without that, the mocked fetch leaks to any
// future test added to this file (and, in theory, to other test files
// run in the same Deno worker — though `deno test` defaults to per-file
// subprocesses, defense in depth).

import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { generateKeyPair } from "jose";
import {
  assertUnauthorized401,
  makeAuthTestApp,
  makeJwksFixture,
  withEnv,
} from "./api_test_support.ts";

const BRAIN_KEY = "b".repeat(64);
const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";
const WRONG_ISSUER = "https://attacker.invalid/";
const WRONG_AUDIENCE = "https://test.invalid:8443/different-resource";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: BRAIN_KEY,
  AUTH0_ISSUER: ISSUER,
  AUTH0_JWKS_URI: JWKS_URL,
  AUTH0_AUDIENCE: AUDIENCE,
  OAUTH_ALLOWED_SUBJECTS: "user-under-test,user-no-exp,user",
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  JWKS_FETCH_TIMEOUT_MS: "2000",
};

Deno.test(
  "requireAuth (OAuth enabled, x-brain-key door also on)",
  withEnv([], TEST_ENV, runAuthOauthTest),
);

async function runAuthOauthTest(t: Deno.TestContext): Promise<void> {
  const fixture = await makeJwksFixture({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
  });
  // Install before importing auth.ts: createRemoteJWKSet is configured at
  // module load when the OAuth door is enabled.
  const restoreFetch = fixture.installFetchMock();
  const { requireAuth, PROTECTED_RESOURCE_METADATA_URL } = await import(
    "./auth.ts"
  );
  const app = makeAuthTestApp(requireAuth);

  const signToken = (opts: {
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    notBefore?: string;
    kid?: string;
    alg?: string;
    privateKeyOverride?: CryptoKey;
  }) =>
    fixture.signToken({
      issuer: opts.issuer,
      audience: opts.audience,
      expirationTime: opts.expiresIn,
      notBefore: opts.notBefore,
      protectedHeader: {
        alg: opts.alg ?? "RS256",
        kid: opts.kid ?? fixture.kid,
      },
      privateKey: opts.privateKeyOverride,
    });

  try {
    await t.step(
      "module sanity: OAuth metadata URL is set when AUTH0_* configured",
      () => {
        assertNotEquals(PROTECTED_RESOURCE_METADATA_URL, null);
        assertMatch(
          PROTECTED_RESOURCE_METADATA_URL!,
          /\/\.well-known\/oauth-protected-resource\/mcp$/,
        );
      },
    );

    await t.step(
      "Bearer: valid token → 200 (Bearer-only path)",
      async () => {
        const token = await signToken({});
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "Bearer: brain-key absent + Bearer absent → 401 (missing-credentials 401)",
      async () => {
        // No credential offered at all → missing_credentials → HTTP 401
        // with the JSON-RPC envelope body. RFC 6750 auth-required signal
        // claude.ai's MCP connector validator requires for OAuth discovery.
        const res = await app.request("/");
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "brain-key: valid only (Bearer absent) → 200 via fast path",
      async () => {
        const res = await app.request("/", {
          headers: { "x-brain-key": BRAIN_KEY },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "dual: valid brain-key + invalid Bearer → 200 (fast path short-circuits)",
      async () => {
        const res = await app.request("/", {
          headers: {
            "x-brain-key": BRAIN_KEY,
            "authorization": "Bearer nonsense",
          },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "dual: invalid brain-key + valid Bearer → 200 (fall-through honors Bearer)",
      async () => {
        // Regression-pinned: an invalid x-brain-key alongside a valid
        // Bearer should NOT unauthorize.
        const token = await signToken({});
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong-key-value",
            "authorization": `Bearer ${token}`,
          },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "dual: invalid brain-key + invalid Bearer → 401 (both tried)",
      async () => {
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong",
            "authorization": "Bearer also-wrong",
          },
        });
        // Both methods attempted → audit row records `invalid_credentials`;
        // operator-facing message is the single neutral string.
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "dual: missing brain-key + invalid Bearer → 401",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": "Bearer not-a-real-token" },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: token without exp claim → 401 (required exp claim)",
      async () => {
        // jose's jwtVerify validates `exp` only when the claim is present
        // unless `requiredClaims` is set. Without that option, an attacker
        // who mints (or steals + replays) a never-expiring token bypasses
        // the only time-based defense at the resource server. The gap
        // was verified with a one-off Deno check before the fix —
        // pre-fix this exact request would have returned 200.
        //
        const token = await fixture.signToken({
          claims: { sub: "user-no-exp" },
          expirationTime: false,
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: expired token → HTTP 401 with challenge",
      async () => {
        // The PR55-AUTH-001 regression pin: an expired (locally
        // signed RS256) token must be rejected at the TRANSPORT level —
        // HTTP 401 with the WWW-Authenticate challenge — not HTTP 200 with
        // only a JSON-RPC error body. OAuth-capable MCP clients key token
        // refresh off the 401; suppressing it left the claude.ai connector
        // disconnected after expiry until a human reauthenticated.
        // Sign with an `exp` 1 hour in the past.
        const past = Math.floor(Date.now() / 1000) - 3600;
        const token = await fixture.signToken({
          claims: { sub: "user" },
          issuedAt: past - 7200,
          expirationTime: past,
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        await assertUnauthorized401(res, null);
        // The challenge must survive on the rejected-credential path so the
        // client can rediscover the AS and refresh.
        const wa = res.headers.get("www-authenticate");
        assertNotEquals(wa, null);
        assertMatch(
          wa!,
          /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/,
        );
      },
    );

    await t.step("Bearer: wrong issuer → 401", async () => {
      const token = await signToken({ issuer: WRONG_ISSUER });
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      await assertUnauthorized401(res, null);
    });

    await t.step("Bearer: wrong audience → 401", async () => {
      const token = await signToken({ audience: WRONG_AUDIENCE });
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      await assertUnauthorized401(res, null);
    });

    await t.step(
      "Bearer: signed by attacker's key (different RS256 key) → 401",
      async () => {
        // Generates a NEW key pair and signs with the attacker's private key. The
        // JWKS we publish only contains the original public key, so verification
        // must fail signature check.
        const attacker = await generateKeyPair("RS256", {
          extractable: true,
        });
        const token = await signToken({
          privateKeyOverride: attacker.privateKey as CryptoKey,
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: malformed token (not three JWT segments) → 401",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": "Bearer this-is-not-a-jwt" },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: 'Bearer ' with no token does not match the regex → 401",
      async () => {
        // `^Bearer\s+(.+)$` requires at least one whitespace AND at least
        // one token char after, so "Bearer " (no token) falls through
        // without setting bearerTried — the reason is missing_credentials,
        // not token_validation_failed. Missing credentials get an HTTP 401.
        const res = await app.request("/", {
          headers: { "authorization": "Bearer " },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: 'Basic' auth scheme is rejected (Bearer-only) → 401",
      async () => {
        // No Bearer attempt was made → reason is missing_credentials
        // (the audit row's honest signal); the response shape is the
        // same uniform 401 as every other rejection.
        const res = await app.request("/", {
          headers: { "authorization": "Basic dXNlcjpwYXNz" },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "Bearer: 'BEARER' uppercase scheme accepted (case-insensitive regex)",
      async () => {
        const token = await signToken({});
        const res = await app.request("/", {
          headers: { "authorization": `BEARER ${token}` },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "401 advertises WWW-Authenticate with resource_metadata URL (missing-credentials 401)",
      async () => {
        // Missing creds → HTTP 401. The WWW-Authenticate header is the
        // OAuth-discovery payload that claude.ai's MCP connector validator
        // walks to find the authorization server — without it the
        // discovery dance can't start. Carry it on the 401 path the same
        // way the 200-envelope path carries it.
        const res = await app.request("/");
        await assertUnauthorized401(res, null);
        const wa = res.headers.get("www-authenticate");
        assertNotEquals(wa, null);
        assertMatch(wa!, /^Bearer realm="open-brain"/);
        assertMatch(
          wa!,
          /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/,
        );
      },
    );

    await t.step(
      "WWW-Authenticate is present even when brain-key was tried (and failed)",
      async () => {
        const res = await app.request("/", {
          headers: { "x-brain-key": "wrong" },
        });
        await assertUnauthorized401(res, null);
        const wa = res.headers.get("www-authenticate");
        assertNotEquals(wa, null);
      },
    );

    // ─── JSON-RPC id echo for POST requests ────────────────
    await t.step(
      "401 envelope: POST with JSON-RPC string id (Bearer-only fail path) → id echoed",
      async () => {
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "authorization": "Bearer bogus",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            id: "mobile-req-7",
          }),
        });
        await assertUnauthorized401(res, "mobile-req-7");
      },
    );

    await t.step(
      "401 envelope: POST with malformed JSON body → id null",
      async () => {
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "authorization": "Bearer bogus",
            "content-type": "application/json",
          },
          body: "{not actually json",
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "JWKS endpoint is cached after first verification (no per-request fetch)",
      async () => {
        // Reset counter relative to its current value; earlier subtests already
        // triggered the fetch.
        const start = fixture.fetchCount;
        // Do 5 successful verifications back-to-back. With jose's default cooldown
        // (30s) and cacheMaxAge (10min), no new fetch should fire.
        for (let i = 0; i < 5; i++) {
          const token = await signToken({});
          const res = await app.request("/", {
            headers: { "authorization": `Bearer ${token}` },
          });
          assertEquals(res.status, 200);
        }
        assertEquals(
          fixture.fetchCount,
          start,
          `expected no new JWKS fetch, saw ${fixture.fetchCount - start} extra`,
        );
      },
    );
  } finally {
    restoreFetch();
  }
}
