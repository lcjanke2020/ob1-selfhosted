// Explicit CI smoke for the `auth.ts` → `auth_audit.ts` → Postgres seam.
//
// This is not a *_test.ts file: db-init.yml runs it only against its
// disposable PostgreSQL container. The companion auth_audit_db_smoke.ts
// drives the emitter FUNCTIONS directly, and every middleware unit test runs
// with `OBS_AUTH_EVENTS_ENABLED=false` — so the wiring between the
// middleware's branches and the emitter (which branch calls which function,
// with which fields, under which reason-code precedence) had no executable
// coverage: removing a logAuthSuccess call or mis-mapping a reason code kept
// the whole suite green (round-3 review proved it by mutation). This smoke
// closes that seam: it runs the REAL middleware (createRequireAuth, wired
// with a native-token verifier exactly like index.ts) over real RS256
// tokens against the real database and asserts the exact rows — covering
// ALL FOUR identity-bearing success branches (OAuth user, OAuth service,
// native token, static key) plus the denial shapes.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "postgres";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");
if (!adminPassword || !appPassword) {
  throw new Error("POSTGRES_PASSWORD and OPENBRAIN_APP_PASSWORD are required");
}

const ISSUER = "https://smoke.invalid/";
const AUDIENCE = "https://smoke.invalid:8443/mcp";
const JWKS_URL = "https://smoke.invalid/.well-known/jwks.json";
const ADMITTED = "auth0|middleware-smoke-admitted";
const ADMITTED_MACHINE = "middleware-smoke-machine@clients";
const OUTSIDER = "auth0|middleware-smoke-refused";
const BRAIN_KEY = "k".repeat(64);
const NATIVE_SECRET = "native-middleware-smoke-secret";
const NATIVE_LABEL = "middleware-smoke-native";

// The emitter and config read env at module load — set everything BEFORE the
// dynamic import of auth.ts (which loads config.ts + auth_audit.ts and runs
// the JWKS boot probe, intercepted by the fetch mock below).
Deno.env.set("DB_HOST", host);
Deno.env.set("DB_PORT", String(port));
Deno.env.set("DB_NAME", "openbrain");
Deno.env.set("DB_USER", "openbrain_app");
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "true");
Deno.env.set("MCP_ACCESS_KEY", BRAIN_KEY);
Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
Deno.env.set("ENABLE_NATIVE_TOKENS", "true");
Deno.env.set("AUTH0_ISSUER", ISSUER);
Deno.env.set("AUTH0_JWKS_URI", JWKS_URL);
Deno.env.set("AUTH0_AUDIENCE", AUDIENCE);
Deno.env.set("OAUTH_ALLOWED_SUBJECTS", `${ADMITTED},${ADMITTED_MACHINE}`);
Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
Deno.env.set("METADATA_FALLBACK_POLICY", "off");
Deno.env.set("JWKS_FETCH_TIMEOUT_MS", "2000");

const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const publicJwk = await exportJWK(publicKey);
publicJwk.alg = "RS256";
publicJwk.kid = "smoke-key-1";
publicJwk.use = "sig";
const jwksBody = JSON.stringify({ keys: [publicJwk] });

const origFetch = globalThis.fetch;
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

const { createRequireAuth } = await import("./auth.ts");
const { shutdownAuthAuditForTests } = await import("./auth_audit.ts");

// Production shape: index.ts passes a native-token verifier into
// createRequireAuth. The fake resolves exactly one secret to a label so the
// native branch's audit wiring is exercised end-to-end.
const requireAuth = createRequireAuth((token: string) =>
  Promise.resolve(token === NATIVE_SECRET ? { label: NATIVE_LABEL } : null)
);

const app = new Hono();
app.use("*", requireAuth);
app.get("/mcp", (c) => c.json({ ok: true }));
app.get("/", (c) => c.json({ ok: true }));

async function signToken(
  sub: string,
  extraClaims: Record<string, unknown> = {},
): Promise<string> {
  return await new SignJWT({ sub, ...extraClaims })
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey as CryptoKey);
}

const adminPool = new Pool({
  hostname: host,
  port,
  database: "openbrain",
  user: "postgres",
  password: adminPassword,
}, 1);

type AuditRow = {
  outcome: string;
  reason: string | null;
  door: string | null;
  subject: string | null;
  token_label: string | null;
  client_ip: string | null;
  path: string | null;
};

async function drainRows(expected: number): Promise<AuditRow[]> {
  // Fire-and-forget emitter: poll until the expected count lands.
  const deadline = Date.now() + 15_000;
  const client = await adminPool.connect();
  try {
    while (true) {
      const result = await client.queryObject<AuditRow>(
        `SELECT outcome, reason, door, subject, token_label,
                host(client_ip) AS client_ip, path
         FROM mcp_auth_events ORDER BY id`,
      );
      if (result.rows.length >= expected || Date.now() > deadline) {
        await client.queryArray(`DELETE FROM mcp_auth_events`);
        return result.rows;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    client.release();
  }
}

try {
  // Clean slate.
  await drainRows(0);

  // ---- 1. Admitted Bearer → 200; the middleware (not a direct emitter
  // call) must land the allowed row, with clientIpFor()'s real XFF parsing.
  {
    const res = await app.request("/mcp", {
      headers: {
        "authorization": `Bearer ${await signToken(ADMITTED)}`,
        "x-forwarded-for": "192.0.2.50, 198.51.100.9",
      },
    });
    assertEquals(res.status, 200);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1, "admitted request must land exactly one row");
    assertEquals(rows[0], {
      outcome: "allowed",
      reason: null,
      door: "funnel",
      subject: ADMITTED,
      token_label: null,
      client_ip: "192.0.2.50",
      path: "/mcp",
    });
  }

  // ---- 2. Verified-but-unadmitted Bearer → 401 with the verified subject
  // on a subject_not_allowed row (the allowlist's audit contract).
  {
    const res = await app.request("/mcp", {
      headers: { "authorization": `Bearer ${await signToken(OUTSIDER)}` },
    });
    assertEquals(res.status, 401);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "denied");
    assertEquals(rows[0].reason, "subject_not_allowed");
    assertEquals(rows[0].subject, OUTSIDER);
    assertEquals(rows[0].door, null);
  }

  // ---- 3. Documented dual-credential precedence: invalid x-brain-key AND a
  // verified-but-unadmitted Bearer → subject_not_allowed (not the generic
  // invalid_credentials collapse), still carrying the verified subject.
  {
    const res = await app.request("/mcp", {
      headers: {
        "x-brain-key": "wrong-key",
        "authorization": `Bearer ${await signToken(OUTSIDER)}`,
      },
    });
    assertEquals(res.status, 401);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].reason, "subject_not_allowed");
    assertEquals(rows[0].subject, OUTSIDER);
  }

  // ---- 4. Either-valid contract: invalid x-brain-key + admitted Bearer →
  // 200 and an allowed row (the fall-through honors the Bearer).
  {
    const res = await app.request("/", {
      headers: {
        "x-brain-key": "wrong-key",
        "authorization": `Bearer ${await signToken(ADMITTED)}`,
      },
    });
    assertEquals(res.status, 200);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "allowed");
    assertEquals(rows[0].subject, ADMITTED);
    assertEquals(rows[0].path, "/");
  }

  // ---- 5. Valid x-brain-key → 200 with a tailnet allowed row (no
  // identity: the static key has none).
  {
    const res = await app.request("/mcp", {
      headers: { "x-brain-key": BRAIN_KEY },
    });
    assertEquals(res.status, 200);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "allowed");
    assertEquals(rows[0].door, "tailnet");
    assertEquals(rows[0].subject, null);
    assertEquals(rows[0].token_label, null);
  }

  // ---- 6. OAuth service admission: an allowlisted machine subject with the
  // signed gty claim must land door='service' — pinning that the audit row
  // records the CLASSIFIED door, not a hardcoded one.
  {
    const res = await app.request("/mcp", {
      headers: {
        "authorization": `Bearer ${await signToken(ADMITTED_MACHINE, {
          gty: "client-credentials",
        })}`,
      },
    });
    assertEquals(res.status, 200);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "allowed");
    assertEquals(rows[0].door, "service");
    assertEquals(rows[0].subject, ADMITTED_MACHINE);
    assertEquals(rows[0].token_label, null);
  }

  // ---- 7. Native-token admission: the rotatable-token branch must land its
  // own allowed row with the verified label (subject stays null — labels are
  // attribution, not OAuth subjects).
  {
    const res = await app.request("/mcp", {
      headers: { "x-brain-key": NATIVE_SECRET },
    });
    assertEquals(res.status, 200);
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "allowed");
    assertEquals(rows[0].door, "tailnet");
    assertEquals(rows[0].subject, null);
    assertEquals(rows[0].token_label, NATIVE_LABEL);
  }

  // ---- 8. No credentials → 401, missing_credentials row.
  {
    const res = await app.request("/mcp");
    assertEquals(res.status, 401);
    const body = await res.json();
    assertStringIncludes(JSON.stringify(body), "-32001");
    const rows = await drainRows(1);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].reason, "missing_credentials");
    assertEquals(rows[0].subject, null);
  }

  console.log(
    "middleware audit smoke: real middleware landed the exact allowed/" +
      "denied rows for all eight credential scenarios — OAuth user, OAuth " +
      "service, native token, static key, and the denial shapes incl. " +
      "subject_not_allowed precedence over the dual-credential collapse",
  );
} finally {
  globalThis.fetch = origFetch;
  await shutdownAuthAuditForTests();
  await adminPool.end();
}
