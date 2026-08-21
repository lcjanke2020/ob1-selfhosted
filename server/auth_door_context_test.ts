// Tests for the door + identity Hono context vars that `requireAuth`
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
//   6. No/other `gty` signal    → door = "funnel" unless the subject is mapped.
//   7. Missing or malformed sub → HTTP 401 before context vars are set.
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

import { assertEquals } from "@std/assert";
import { generateKeyPair } from "jose";
import {
  makeAuthTestApp,
  makeJwksFixture,
  withEnv,
} from "./api_test_support.ts";

const BRAIN_KEY = "b".repeat(64);
const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: BRAIN_KEY,
  AUTH0_ISSUER: ISSUER,
  AUTH0_JWKS_URI: JWKS_URL,
  AUTH0_AUDIENCE: AUDIENCE,
  OAUTH_SERVICE_ACCOUNT_SUBJECTS: "generic-service-subject",
  OAUTH_ALLOWED_SUBJECTS: [
    "auth0|leo-source-marker-test",
    "auth0-m2m-client@clients",
    "generic-service-subject",
    "Generic-Service-Subject",
    "rfc9068-machine@clients",
    "password-flow-user",
    "auth0|fallthrough-test",
  ].join(","),
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  JWKS_FETCH_TIMEOUT_MS: "2000",
};

Deno.test(
  "requireAuth sets door + sub on Hono context (door/sub stamping)",
  withEnv([], TEST_ENV, runDoorContextTest),
);

async function runDoorContextTest(t: Deno.TestContext): Promise<void> {
  const fixture = await makeJwksFixture({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
  });
  const restoreFetch = fixture.installFetchMock();
  const { requireAuth } = await import("./auth.ts");
  // The sentinel response keeps null distinct from undefined/empty string.
  const app = makeAuthTestApp(requireAuth, (context) =>
    context.json({
      door: context.get("door"),
      sub: context.get("sub"),
      tokenLabel: context.get("tokenLabel"),
      subType: context.get("sub") === null ? "null" : typeof context.get("sub"),
    }));

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
        assertEquals(body.tokenLabel, null);
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
        const token = await fixture.signToken({
          claims: { sub: expectedSub },
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "funnel");
        assertEquals(body.sub, expectedSub);
        assertEquals(body.tokenLabel, null);
        assertEquals(body.subType, "string");
      },
    );

    await t.step(
      "Auth0 client-credentials Bearer → door = 'service' with verified client sub",
      async () => {
        const expectedSub = "auth0-m2m-client@clients";
        const token = await fixture.signToken({
          claims: { sub: expectedSub, gty: "client-credentials" },
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "service");
        assertEquals(body.sub, expectedSub);
        assertEquals(body.tokenLabel, null);
      },
    );

    await t.step(
      "configured generic service subject → door = 'service' without gty claim",
      async () => {
        const expectedSub = "generic-service-subject";
        const token = await fixture.signToken({
          claims: { sub: expectedSub },
        });
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
        const token = await fixture.signToken({
          claims: { sub: "Generic-Service-Subject" },
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        assertEquals((await res.json()).door, "funnel");
      },
    );

    await t.step(
      "Auth0 RFC 9068 M2M shape without gty stays funnel until mapped",
      async () => {
        const expectedSub = "rfc9068-machine@clients";
        const token = await fixture.signToken({
          claims: {
            sub: expectedSub,
            client_id: "rfc9068-machine",
            jti: "rfc9068-token-id",
          },
          protectedHeader: { typ: "at+jwt" },
        });
        const res = await app.request("/", {
          headers: { "authorization": `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.door, "funnel");
        assertEquals(body.sub, expectedSub);
      },
    );

    await t.step(
      "non-client-credentials gty does not select the service door",
      async () => {
        const token = await fixture.signToken({
          claims: { sub: "password-flow-user", gty: "password" },
        });
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
        const token = await fixture.signToken({
          claims: { sub: "forged-machine", gty: "client-credentials" },
          privateKey: attackerKey as CryptoKey,
        });
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
        const token = await fixture.signToken({ claims: {} });
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

    for (
      const [name, invalidSub] of [
        ["empty", ""],
        ["non-string", 123],
        ["control-character", "machine\nsubject"],
        ["oversized", "s".repeat(1_025)],
      ] as const
    ) {
      await t.step(
        `Bearer with ${name} sub → unauthorized before classification`,
        async () => {
          const claims: Record<string, unknown> = {
            sub: invalidSub,
            gty: "client-credentials",
          };
          const token = await fixture.signToken({ claims });
          const res = await app.request("/", {
            headers: { "authorization": `Bearer ${token}` },
          });
          assertEquals(res.status, 401);
          const body = await res.json();
          assertEquals(body.jsonrpc, "2.0");
          assertEquals(body.error?.code, -32001);
        },
      );
    }

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
        const token = await fixture.signToken({
          claims: { sub: expectedSub },
        });
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
    restoreFetch();
  }
}
