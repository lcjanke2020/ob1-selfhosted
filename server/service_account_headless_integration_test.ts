// End-to-end browserless proof: the tracked operator helper exchanges
// client_credentials against a local OAuth fixture, then authenticates an MCP
// initialize request through the real requireAuth verifier and MCP factory. It
// also drives the same service Bearer through the REST auth-context gate. No
// browser, static brain key, external network, real database, or secret output.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authContextFromValues } from "./auth_context.ts";
import type { AppVariables } from "./auth.ts";
import { asPool, FakePool, makeDeps } from "./api_test_support.ts";

const CLIENT_ID = "headless-test-client";
const CLIENT_SECRET = "headless-test-secret";
const SUBJECT = "headless-test-client@clients";
const OUTSIDER_SUBJECT = "headless-unadmitted@clients";
const ISSUER = "https://headless-issuer.invalid/";
const AUDIENCE = "https://brain.invalid/mcp";
const JWKS_URL = "https://headless-issuer.invalid/.well-known/jwks.json";

const ENV_KEYS = [
  "DB_PASSWORD",
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

Deno.test("browserless client_credentials authenticates through MCP and REST service gates", async () => {
  const original = new Map(
    ENV_KEYS.map((key) => [key, Deno.env.get(key)] as const),
  );
  const originalFetch = globalThis.fetch;
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "headless-test-key";
  publicJwk.use = "sig";

  let address: Deno.NetAddr | undefined;
  let accessToken = "";
  let mcpApp: Hono<{ Variables: AppVariables }> | undefined;
  let tokenRequests = 0;
  let mcpRequests = 0;
  const fixture = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen(value) {
        address = value;
      },
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token" && request.method === "POST") {
        tokenRequests++;
        const form = new URLSearchParams(await request.text());
        if (
          form.get("grant_type") !== "client_credentials" ||
          form.get("client_id") !== CLIENT_ID ||
          form.get("client_secret") !== CLIENT_SECRET
        ) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
        });
      }
      if (url.pathname === "/mcp" && mcpApp) {
        mcpRequests++;
        return mcpApp.fetch(request);
      }
      return new Response("not found", { status: 404 });
    },
  );

  try {
    if (!address) throw new Error("local OAuth fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    accessToken = await new SignJWT({
      sub: SUBJECT,
      gty: "client-credentials",
    })
      .setProtectedHeader({ alg: "RS256", kid: "headless-test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey as CryptoKey);

    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.delete("MCP_ACCESS_KEY");
    Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
    Deno.env.set("AUTH0_ISSUER", ISSUER);
    Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
    Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
    Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
    // Authorization allowlist (fail-closed): admit the machine subject this
    // integration mints. Note attribution (service-door classification via
    // gty) and authorization (this list) are deliberately separate gates.
    Deno.env.set("OAUTH_ALLOWED_SUBJECTS", SUBJECT);
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
    Deno.env.set("METADATA_FALLBACK_POLICY", "off");
    Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url === JWKS_URL) {
        return Promise.resolve(Response.json({ keys: [publicJwk] }));
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const { requireAuth } = await import("./auth.ts");
    const { createMcpServer } = await import("./mcp-server.ts");
    const { createApiRouter } = await import("./api.ts");
    const pool = asPool(
      new FakePool((sql) =>
        sql.includes("COUNT(*)::int AS count")
          ? { rows: [{ count: 0, earliest: null, latest: null }] }
          : sql.includes("AS k") || sql.includes("AS topic") ||
              sql.includes("AS person")
          ? { rows: [] }
          : undefined
      ),
    );
    mcpApp = new Hono<{ Variables: AppVariables }>();
    mcpApp.post("/mcp", requireAuth, async (c) => {
      const auth = authContextFromValues(
        c.get("door"),
        c.get("sub"),
        c.get("tokenLabel"),
      );
      if (!auth) throw new Error("service auth context was not accepted");
      assertEquals(auth, {
        door: "service",
        sub: SUBJECT,
        tokenLabel: null,
      });

      const transport = new StreamableHTTPTransport();
      const server = createMcpServer(pool, auth);
      await server.connect(transport);
      return transport.handleRequest(c);
    });

    const runHelper = async (extraEnv: Record<string, string>) => {
      const command = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-env=OAUTH_TOKEN_URL,OAUTH_CLIENT_ID,OAUTH_CLIENT_SECRET,OAUTH_AUDIENCE,OAUTH_SCOPE,OAUTH_CLIENT_AUTH_METHOD,OPENBRAIN_MCP_URL,OAUTH_SMOKE_TIMEOUT_MS,OAUTH_SMOKE_PRINT_SUBJECT",
          "--allow-net=127.0.0.1",
          "--allow-read=../scripts/verify-service-account.ts",
          "../scripts/verify-service-account.ts",
        ],
        cwd: import.meta.dirname!,
        clearEnv: true,
        env: {
          OAUTH_TOKEN_URL: `${origin}/oauth/token`,
          OAUTH_CLIENT_ID: CLIENT_ID,
          OAUTH_CLIENT_SECRET: CLIENT_SECRET,
          OAUTH_AUDIENCE: AUDIENCE,
          OAUTH_CLIENT_AUTH_METHOD: "client_secret_post",
          OPENBRAIN_MCP_URL: `${origin}/mcp`,
          ...extraEnv,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      };
    };

    const success = await runHelper({});
    assertEquals(success.code, 0, success.stderr);
    assertStringIncludes(
      success.stdout,
      "OK: browserless client_credentials authenticated to open-brain-homelab 1.20.0",
    );
    assertStringIncludes(
      success.stdout,
      "signed gty=client-credentials present",
    );
    for (const sensitive of [CLIENT_SECRET, accessToken, SUBJECT]) {
      assertEquals(success.stdout.includes(sensitive), false);
      assertEquals(success.stderr.includes(sensitive), false);
    }
    assertEquals(tokenRequests, 1);
    assertEquals(mcpRequests, 1);

    // ---- Bootstrap-401 path: a valid tenant token whose subject is NOT in
    // OAUTH_ALLOWED_SUBJECTS. This is the enrollment loop the helper's
    // pre-flight subject print exists for: the run must FAIL (fail-closed
    // admission), yet with the opt-in flag it must still emit the locally
    // decoded subject the operator needs to enroll — and without the flag
    // it must not leak the subject anywhere.
    const admittedToken = accessToken;
    const outsiderToken = await new SignJWT({
      sub: OUTSIDER_SUBJECT,
      gty: "client-credentials",
    })
      .setProtectedHeader({ alg: "RS256", kid: "headless-test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey as CryptoKey);
    accessToken = outsiderToken;

    const bootstrap = await runHelper({ OAUTH_SMOKE_PRINT_SUBJECT: "true" });
    assertEquals(bootstrap.code === 0, false, "unadmitted subject must fail");
    assertStringIncludes(
      bootstrap.stdout,
      `Token subject (locally decoded): ${OUTSIDER_SUBJECT}`,
    );
    assertStringIncludes(bootstrap.stderr, "HTTP 401");
    assertStringIncludes(bootstrap.stderr, "OAUTH_ALLOWED_SUBJECTS");
    // The hint must hedge: this 401 could equally be a token-validation
    // failure, so it names both audit outcomes rather than asserting the
    // subject_not_allowed row exists.
    assertStringIncludes(bootstrap.stderr, "subject_not_allowed");
    assertStringIncludes(bootstrap.stderr, "token_validation_failed");
    for (const sensitive of [CLIENT_SECRET, outsiderToken]) {
      assertEquals(bootstrap.stdout.includes(sensitive), false);
      assertEquals(bootstrap.stderr.includes(sensitive), false);
    }

    const silentFailure = await runHelper({});
    assertEquals(silentFailure.code === 0, false);
    // Without the opt-in flag the subject appears nowhere; the hint still
    // tells the operator which flag yields it.
    assertEquals(silentFailure.stdout.includes(OUTSIDER_SUBJECT), false);
    assertEquals(silentFailure.stderr.includes(OUTSIDER_SUBJECT), false);
    assertStringIncludes(
      silentFailure.stderr,
      "OAUTH_SMOKE_PRINT_SUBJECT=true",
    );

    // Drive a real REST handler far enough to turn the middleware-populated
    // service context into a service-layer argument. This pins api.ts's
    // defensive gate instead of proving only the middleware classifier.
    const api = createApiRouter(pool, makeDeps());
    const restResponse = await api.request("/thoughts/stats", {
      headers: { authorization: `Bearer ${admittedToken}` },
    });
    assertEquals(restResponse.status, 200);
    assertEquals((await restResponse.json()).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.shutdown();
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
