// End-to-end browserless proof: the tracked operator helper exchanges
// client_credentials against a local OAuth fixture, then authenticates an MCP
// initialize request through the real requireAuth JWT verifier. No browser,
// static brain key, external network, database, or secret-bearing output.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AppVariables } from "./auth.ts";

const CLIENT_ID = "headless-test-client";
const CLIENT_SECRET = "headless-test-secret";
const SUBJECT = "headless-test-client@clients";
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
  "OBS_AUTH_EVENTS_ENABLED",
  "METADATA_FALLBACK_POLICY",
  "JWKS_FETCH_TIMEOUT_MS",
];

Deno.test("browserless client_credentials helper authenticates through requireAuth", async () => {
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
    mcpApp = new Hono<{ Variables: AppVariables }>();
    mcpApp.use("*", requireAuth);
    mcpApp.post("/mcp", async (c) => {
      const request = await c.req.json();
      assertEquals(request.method, "initialize");
      assertEquals(c.get("door"), "service");
      assertEquals(c.get("sub"), SUBJECT);
      return c.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: {
            name: "open-brain-homelab",
            version: "1.18.0",
          },
        },
      });
    });

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
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assertStringIncludes(
      stdout,
      "OK: browserless client_credentials authenticated to open-brain-homelab 1.18.0",
    );
    assertStringIncludes(stdout, "Open Brain labels this identity service");
    for (const sensitive of [CLIENT_SECRET, accessToken, SUBJECT]) {
      assertEquals(stdout.includes(sensitive), false);
      assertEquals(stderr.includes(sensitive), false);
    }
    assertEquals(tokenRequests, 1);
    assertEquals(mcpRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.shutdown();
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});
