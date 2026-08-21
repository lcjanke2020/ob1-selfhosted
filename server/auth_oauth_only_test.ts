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
import {
  makeAuthTestApp,
  makeJwksFixture,
  withEnv,
} from "./api_test_support.ts";

const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  ENABLE_NATIVE_TOKENS: "false",
  AUTH0_ISSUER: ISSUER,
  AUTH0_JWKS_URI: JWKS_URL,
  AUTH0_AUDIENCE: AUDIENCE,
  OAUTH_ALLOWED_SUBJECTS: "user-under-test",
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  JWKS_FETCH_TIMEOUT_MS: "2000",
};

Deno.test(
  "requireAuth (OAuth only — x-brain-key door disabled)",
  withEnv([], TEST_ENV, runOauthOnlyTest),
);

async function runOauthOnlyTest(t: Deno.TestContext): Promise<void> {
  const fixture = await makeJwksFixture({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
  });
  const restoreFetch = fixture.installFetchMock();
  const { requireAuth } = await import("./auth.ts");
  const app = makeAuthTestApp(requireAuth);

  try {
    await t.step("valid Bearer → 200", async () => {
      const token = await fixture.signToken();
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
          headers: {
            "x-brain-key": "any-value-since-no-key-is-configured",
          },
        });
        assertEquals(res.status, 401);
      },
    );

    await t.step(
      "x-brain-key + valid Bearer → 200 (Bearer honored, key irrelevant)",
      async () => {
        const token = await fixture.signToken();
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
    restoreFetch();
  }
}
