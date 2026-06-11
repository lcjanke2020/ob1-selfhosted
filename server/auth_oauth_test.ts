// Tests for the `requireAuth` middleware in Pattern B (OAuth enabled).
// Covers the full (brain-key × Bearer × OAuth-on) matrix an early review
// asked to bottle, plus the JWT failure modes (expired, wrong
// issuer/audience, malformed). Run with `deno task test`.
//
// auth failure shape depends on whether a credential
// was offered:
//   - Creds tried but invalid (invalid_credentials / invalid_brain_key /
//     token_validation_failed) → HTTP 200 with a JSON-RPC 2.0 error
//     envelope (code -32001, single neutral message) so strict MCP hosts
//     don't tear an established transport down (and avoids the credential-status side-channel).
//   - No credential offered at all (missing_credentials) → HTTP 401 with
//     the same envelope body. Spec-compliant OAuth-discovery signal for
//     claude.ai's MCP connector validator on the pre-OAuth probe
//     (missing-credentials 401). WWW-Authenticate is emitted on both shapes so OAuth-
//     aware clients can discover the AS.
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
import { Hono, type MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BRAIN_KEY = "b".repeat(64);
const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";
const WRONG_ISSUER = "https://attacker.invalid/";
const WRONG_AUDIENCE = "https://test.invalid:8443/different-resource";

// Env keys this test sets; tracked so we can clear them in teardown.
const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  // see auth_brainkey_test.ts for why this is here.
  "OBS_AUTH_EVENTS_ENABLED",
  // config.ts now refuses to start when ENABLE_OAUTH && !PATTERN_B
  // (forces operators to use the compose override that strips mcp's host
  // port). This file's tests run with OAuth enabled, so PATTERN_B=true
  // must be set BEFORE the auth.ts dynamic import — otherwise config.ts
  // throws and the entire test suite fails at module load.
  "PATTERN_B",
  // bound the boot-time JWKS reachability probe with a short
  // timeout so this test suite stays fast even if the mock somehow
  // doesn't intercept the probe fetch.
  "JWKS_FETCH_TIMEOUT_MS",
];

function makeApp(mw: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => c.json({ ok: true }));
  return app;
}

// Asserts the JSON-RPC unauthorized envelope (HTTP 200) returned when a credential
// was offered but rejected. Body is JSON-RPC 2.0 with error.code -32001.
async function assertUnauthorizedEnvelope(
  res: Response,
  expectedId: string | number | null,
): Promise<void> {
  await assertEnvelopeBody(res, 200, expectedId);
}

// Asserts the missing-credentials shape (HTTP 401, same body as
// the JSON-RPC envelope). For Pattern B, WWW-Authenticate must also be
// present — checked at the call site, not here, since some subtests
// pair this with extra header assertions.
async function assertUnauthorized401(
  res: Response,
  expectedId: string | number | null,
): Promise<void> {
  await assertEnvelopeBody(res, 401, expectedId);
}

// Shared body shape. The body, content-type, and cache-control are
// identical across the 200 envelope and the 401 envelope;
// only the HTTP status differs.
async function assertEnvelopeBody(
  res: Response,
  expectedStatus: 200 | 401,
  expectedId: string | number | null,
): Promise<void> {
  assertEquals(
    res.status,
    expectedStatus,
    `expected HTTP ${expectedStatus}`,
  );
  assertEquals(
    res.headers.get("content-type")?.startsWith("application/json"),
    true,
    "envelope content-type is JSON",
  );
  assertEquals(
    res.headers.get("cache-control"),
    "no-store",
    "envelope must not be cacheable",
  );
  const body = await res.json();
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.error?.code, -32001);
  assertEquals(
    body.error?.message,
    "Unauthorized: missing or invalid authentication.",
  );
  assertEquals(body.id, expectedId);
}

Deno.test("requireAuth (Pattern B — OAuth enabled)", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
  // Snapshot fetch and env so teardown can restore them.
  const origFetch = globalThis.fetch;
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );

  // Real RS256 key pair. The JWKS we publish over the mock fetch contains
  // the public key; signing uses the private key.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key-1";
  publicJwk.use = "sig";
  const jwksBody = JSON.stringify({ keys: [publicJwk] });

  // Install fetch mock BEFORE the dynamic import of auth.ts — jose's
  // createRemoteJWKSet is called at module load when ENABLE_OAUTH is true
  // and it needs to see the mocked fetch.
  let jwksFetchCount = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url === JWKS_URL) {
      jwksFetchCount++;
      return Promise.resolve(
        new Response(jwksBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;

  // Required env BEFORE the dynamic import.
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", BRAIN_KEY);
  Deno.env.set("AUTH0_ISSUER", ISSUER);
  Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
  Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
  // disable audit emission; the audit module reads this at load.
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  // Pattern B fail-fast guard; OAuth is enabled in this suite,
  // so PATTERN_B must be set or config.ts throws at module load.
  Deno.env.set("PATTERN_B", "true");
  // short JWKS fetch timeout so the boot probe (intercepted by
  // the fetch mock above) and any per-request refresh fail fast in tests
  // rather than waiting the production 10 s default.
  Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

  const { requireAuth, PROTECTED_RESOURCE_METADATA_URL } = await import(
    "./auth.ts"
  );
  const app = makeApp(requireAuth);

  // Helper closes over privateKey + the issuer/audience constants. Defined
  // here (not at module scope) so it can capture the fresh keypair without
  // a parameter shuffle.
  async function signToken(opts: {
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    notBefore?: string;
    kid?: string;
    alg?: string;
    privateKeyOverride?: CryptoKey;
  }): Promise<string> {
    const jwt = new SignJWT({ sub: "user-under-test" })
      .setProtectedHeader({
        alg: opts.alg ?? "RS256",
        kid: opts.kid ?? "test-key-1",
      })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "1h");
    if (opts.notBefore) jwt.setNotBefore(opts.notBefore);
    return await jwt.sign(opts.privateKeyOverride ?? (privateKey as CryptoKey));
  }

  // ─── Tests (all wrapped in try/finally for guaranteed teardown) ───────
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

    await t.step("Bearer: valid token → 200 (Bearer-only path)", async () => {
      const token = await signToken({});
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      assertEquals(res.status, 200);
    });

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
      "dual: invalid brain-key + invalid Bearer → envelope (both tried)",
      async () => {
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong",
            "authorization": "Bearer also-wrong",
          },
        });
        // Both methods attempted → audit row records `invalid_credentials`;
        // operator-facing envelope message is the single neutral string.
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "dual: missing brain-key + invalid Bearer → envelope",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": "Bearer not-a-real-token" },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "Bearer: token without exp claim → envelope (required exp claim)",
      async () => {
        // jose's jwtVerify validates `exp` only when the claim is present
        // unless `requiredClaims` is set. Without that option, an attacker
        // who mints (or steals + replays) a never-expiring token bypasses
        // the only time-based defense at the resource server. The gap
        // was verified with a one-off Deno check before the fix —
        // pre-fix this exact request would have returned 200.
        //
        // SignJWT here intentionally skips `.setExpirationTime()`.
        const token = await new SignJWT({ sub: "user-no-exp" })
          .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setIssuedAt()
          .sign(privateKey as CryptoKey);
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step("Bearer: expired token → envelope", async () => {
      // Sign with an `exp` 1 hour in the past.
      const past = Math.floor(Date.now() / 1000) - 3600;
      const token = await new SignJWT({ sub: "user" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(past - 7200)
        .setExpirationTime(past)
        .sign(privateKey as CryptoKey);
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      await assertUnauthorizedEnvelope(res, null);
    });

    await t.step("Bearer: wrong issuer → envelope", async () => {
      const token = await signToken({ issuer: WRONG_ISSUER });
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      await assertUnauthorizedEnvelope(res, null);
    });

    await t.step("Bearer: wrong audience → envelope", async () => {
      const token = await signToken({ audience: WRONG_AUDIENCE });
      const res = await app.request("/", {
        headers: { "authorization": `Bearer ${token}` },
      });
      await assertUnauthorizedEnvelope(res, null);
    });

    await t.step(
      "Bearer: signed by attacker's key (different RS256 key) → envelope",
      async () => {
        // Generates a NEW key pair and signs with the attacker's private key. The
        // JWKS we publish only contains the original public key, so verification
        // must fail signature check.
        const attacker = await generateKeyPair("RS256", { extractable: true });
        const token = await signToken({
          privateKeyOverride: attacker.privateKey as CryptoKey,
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "Bearer: malformed token (not three JWT segments) → envelope",
      async () => {
        const res = await app.request("/", {
          headers: { "authorization": "Bearer this-is-not-a-jwt" },
        });
        await assertUnauthorizedEnvelope(res, null);
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
        // No Bearer attempt was made → reason is missing_credentials, so
        // the response is the 401 with the envelope body, not
        // the 200 envelope used when credentials were rejected.
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
        await assertUnauthorizedEnvelope(res, null);
        const wa = res.headers.get("www-authenticate");
        assertNotEquals(wa, null);
      },
    );

    // ─── JSON-RPC id echo for POST requests ────────────────
    await t.step(
      "envelope: POST with JSON-RPC string id (Bearer-only fail path) → id echoed",
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
        await assertUnauthorizedEnvelope(res, "mobile-req-7");
      },
    );

    await t.step(
      "envelope: POST with malformed JSON body → id null",
      async () => {
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "authorization": "Bearer bogus",
            "content-type": "application/json",
          },
          body: "{not actually json",
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "JWKS endpoint is cached after first verification (no per-request fetch)",
      async () => {
        // Reset counter relative to its current value; earlier subtests already
        // triggered the fetch.
        const start = jwksFetchCount;
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
          jwksFetchCount,
          start,
          `expected no new JWKS fetch, saw ${jwksFetchCount - start} extra`,
        );
      },
    );
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    // Restore fetch and env to whatever they were before this test ran.
    globalThis.fetch = origFetch;
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
