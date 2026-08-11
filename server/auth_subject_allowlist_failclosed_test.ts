// Tests for the OAUTH_ALLOWED_SUBJECTS FAIL-CLOSED posture: OAuth door
// enabled, allowlist left unset. Companion to auth_subject_allowlist_test.ts
// (non-empty allowlist) — split across files because config.ts is read once
// per module load, so each env state needs its own test file.
//
// The property under test: an unset/empty allowlist means NO Bearer token is
// accepted, however valid — misconfiguration denies rather than allows — while
// the x-brain-key door on a mixed deployment keeps working, so the failure
// mode of "operator upgraded and forgot the new var" is a scoped OAuth outage
// plus a loud boot warning, not a silently-open door.

import { assertEquals } from "jsr:@std/assert@1";
import { Hono, type MiddlewareHandler } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BRAIN_KEY = "b".repeat(64);
const ISSUER = "https://test.invalid/";
const AUDIENCE = "https://test.invalid:8443/mcp";
const JWKS_URL = "https://test.invalid/.well-known/jwks.json";

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

function makeApp(mw: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

Deno.test("requireAuth fails closed with no OAUTH_ALLOWED_SUBJECTS", async (t) => {
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

  // Mixed deployment: static x-brain-key door on AND OAuth on — the shape
  // where the fail-closed blast radius matters (Bearer sealed, key working).
  Deno.env.set("MCP_ACCESS_KEY", BRAIN_KEY);
  Deno.env.set("ENABLE_NATIVE_TOKENS", "false");
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("AUTH0_ISSUER", ISSUER);
  Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
  Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  Deno.env.delete("OAUTH_ALLOWED_SUBJECTS");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");
  Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

  const { requireAuth } = await import("./auth.ts");
  const app = makeApp(requireAuth);

  async function signToken(sub: string): Promise<string> {
    return await new SignJWT({ sub })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey as CryptoKey);
  }

  try {
    await t.step(
      "fully valid Bearer → 401 (empty allowlist admits nobody)",
      async () => {
        const res = await app.request("/", {
          headers: {
            "authorization": `Bearer ${await signToken("auth0|any-user")}`,
          },
        });
        assertEquals(res.status, 401);
        const body = await res.json();
        assertEquals(body.error?.code, -32001);
      },
    );

    await t.step(
      "x-brain-key door is unaffected by the sealed OAuth door",
      async () => {
        const res = await app.request("/", {
          headers: { "x-brain-key": BRAIN_KEY },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "valid key + valid-but-unadmitted Bearer → 200 (either-valid holds)",
      async () => {
        // The dual-header contract is unchanged: a request authenticates if
        // EITHER credential is valid, and the key path short-circuits before
        // the Bearer is even examined.
        const res = await app.request("/", {
          headers: {
            "x-brain-key": BRAIN_KEY,
            "authorization": `Bearer ${await signToken("auth0|any-user")}`,
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
