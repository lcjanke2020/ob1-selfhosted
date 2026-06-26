// Tests for the `requireAuth` middleware with the x-brain-key door ENABLED
// (MCP_ACCESS_KEY set) and OAuth DISABLED — the `compose-local` deployment mode.
// Run with `deno task test`.
//
// auth failure shape depends on whether any credential was offered:
//   - creds-tried-but-invalid → JSON-RPC 2.0 error envelope (HTTP 200,
//     code -32001) so strict MCP hosts don't tear the established transport down.
//   - missing_credentials → HTTP 401 with the same JSON-RPC envelope body.
//     Spec-compliant OAuth-discovery signal for claude.ai's MCP connector
//     validator on the pre-OAuth probe (missing-credentials 401).
// The operator-facing message is a single neutral string regardless of which
// credential failed — that's the side-channel we deliberately close. The
// granular AuthFailureReason is preserved internally via the audit row.
//
// Hermetic: snapshots + restores DB_PASSWORD / MCP_ACCESS_KEY / AUTH0_* /
// AUTH_BODY_READ_TIMEOUT_MS so the suite is not order-/machine-dependent.
// Explicitly deletes AUTH0_* before importing auth.ts so a dev/CI host
// that has those set in its shell doesn't accidentally enable OAuth
// (which would change the expectations here). The x-brain-key door being OFF
// (a presented header ignored) is covered separately in auth_oauth_only_test.ts.

import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import { Hono, type MiddlewareHandler } from "hono";

const KEY = "k".repeat(64);

// Test override of the production 2000 ms body-read timeout. Lets the
// slow-stream regression test settle in ~150 ms rather than ~2 s; the
// `200 ms - ε` envelope of "this didn't wait for the body" is still
// observable, just on a tighter clock.
const TEST_BODY_READ_TIMEOUT_MS = "150";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  // the auth middlewares now fire-and-forget an audit row into
  // postgres on auth-fail. Disable that here so the test suite doesn't
  // try to open a DB connection it can't reach.
  "OBS_AUTH_EVENTS_ENABLED",
  // Body-read timeout knob; tests pin it short so the slow-
  // stream test runs fast.
  "AUTH_BODY_READ_TIMEOUT_MS",
];

function makeApp(mw: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", mw);
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => c.json({ ok: true }));
  app.delete("/", (c) => c.json({ ok: true }));
  return app;
}

// Asserts the response matches the JSON-RPC unauthorized envelope
// returned by requireAuth on the MCP transport when a credential was
// tried but found invalid: HTTP 200, application/json, Cache-Control:
// no-store, body { jsonrpc: "2.0", error: { code: -32001, message:
// "Unauthorized: missing or invalid authentication." }, id }.
async function assertUnauthorizedEnvelope(
  res: Response,
  expectedId: string | number | null,
): Promise<void> {
  await assertEnvelopeBody(res, 200, expectedId);
}

// Asserts the missing-credentials shape returned by requireAuth
// when NO credential was offered at all: HTTP 401 with the same JSON-RPC
// envelope body. Spec-compliant OAuth-discovery signal claude.ai's MCP
// connector validator expects on a pre-OAuth probe. WWW-Authenticate (if
// PROTECTED_RESOURCE_METADATA_URL is set) is checked at the call site,
// not here, since Pattern A leaves it null.
async function assertUnauthorized401(
  res: Response,
  expectedId: string | number | null,
): Promise<void> {
  await assertEnvelopeBody(res, 401, expectedId);
}

// Shared shape check. The body, content-type, and cache-control are
// identical for the 200 envelope (creds tried) and 401 envelope (no
// creds offered); only the HTTP status differs.
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

Deno.test("requireAuth (x-brain-key door enabled, OAuth disabled — compose-local mode)", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );

  // Force the x-brain-key-only mode regardless of host env. config.ts evaluates
  // ENABLE_OAUTH from these at module load; if any AUTH0_* are set in the shell,
  // ENABLE_OAUTH becomes true and the OAuth-disabled assertions below would fail
  // in confusing ways. MCP_ACCESS_KEY is set, so the "at least one auth door"
  // guard is satisfied.
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", KEY);
  // disable audit emission so unauthorized() doesn't try to open
  // a DB connection. auth_audit reads this at module load, so it MUST be
  // set before the dynamic-import of auth.ts below.
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
  // Short timeout so the slow-stream regression test is fast.
  // auth.ts reads this at module load, so it MUST be set before the
  // dynamic-import below.
  Deno.env.set("AUTH_BODY_READ_TIMEOUT_MS", TEST_BODY_READ_TIMEOUT_MS);

  const { requireAuth, PROTECTED_RESOURCE_METADATA_URL } = await import(
    "./auth.ts"
  );

  try {
    await t.step(
      "module sanity: OAuth metadata URL is null when AUTH0_* unset",
      () => {
        assertEquals(PROTECTED_RESOURCE_METADATA_URL, null);
      },
    );

    // ─── requireAuth (MCP transport → envelope on auth-fail) ─────────
    await t.step("requireAuth: valid x-brain-key → 200", async () => {
      const app = makeApp(requireAuth);
      const res = await app.request("/", { headers: { "x-brain-key": KEY } });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
    });

    await t.step(
      "requireAuth: invalid x-brain-key → JSON-RPC unauthorized envelope",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          headers: { "x-brain-key": "wrong" },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "requireAuth: missing x-brain-key (Pattern A) → 401 (missing-credentials 401)",
      async () => {
        // No credential offered at all → missing_credentials → HTTP 401
        // with the JSON-RPC envelope body. Spec-compliant auth-required
        // signal for OAuth discovery clients.
        const app = makeApp(requireAuth);
        const res = await app.request("/");
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "requireAuth: empty x-brain-key value is treated as missing → 401",
      async () => {
        // An empty-string header is `brainKeyTried = false` per auth.ts,
        // so this routes to missing_credentials and the 401.
        const app = makeApp(requireAuth);
        const res = await app.request("/", { headers: { "x-brain-key": "" } });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "requireAuth: valid brain-key + Bearer (OAuth off) → 200 (brain-key wins)",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          headers: {
            "x-brain-key": KEY,
            "authorization": "Bearer ignored-when-oauth-off",
          },
        });
        assertEquals(res.status, 200);
      },
    );

    await t.step(
      "requireAuth: invalid brain-key + Bearer (OAuth off) → envelope, Bearer ignored",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong",
            "authorization": "Bearer something",
          },
        });
        // OAuth is disabled, so the Bearer path is never tried — but the
        // operator-facing envelope is now a single neutral message
        // regardless. (Audit row still distinguishes the cause via the
        // AuthFailureReason enum — separate concern from the response.)
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "requireAuth: 401 has no WWW-Authenticate header in Pattern A",
      async () => {
        // Missing creds → HTTP 401. PROTECTED_RESOURCE_METADATA_URL is
        // null when OAuth disabled, so the unauthorized() helper skips
        // the WWW-Authenticate emission on both response shapes.
        const app = makeApp(requireAuth);
        const res = await app.request("/");
        await assertUnauthorized401(res, null);
        assertEquals(res.headers.get("www-authenticate"), null);
      },
    );

    // ─── safeEqual / checkBrainKey (via requireAuth) ──────────────────
    await t.step(
      "brain-key compare: length-mismatched provided value still rejected (no early-return leak)",
      async () => {
        const app = makeApp(requireAuth);
        const short = await app.request("/", {
          headers: { "x-brain-key": "k" },
        });
        await assertUnauthorizedEnvelope(short, null);
        const long = await app.request("/", {
          headers: { "x-brain-key": KEY + "extra" },
        });
        await assertUnauthorizedEnvelope(long, null);
      },
    );

    await t.step(
      "brain-key compare: differs only in last byte → envelope",
      async () => {
        const app = makeApp(requireAuth);
        const wrong = KEY.slice(0, -1) + "x";
        const res = await app.request("/", {
          headers: { "x-brain-key": wrong },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "brain-key compare: differs only in first byte → envelope",
      async () => {
        const app = makeApp(requireAuth);
        const wrong = "x" + KEY.slice(1);
        const res = await app.request("/", {
          headers: { "x-brain-key": wrong },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    // ─── JSON-RPC id echo + body-handling edge cases (envelope path) ──
    await t.step(
      "envelope: POST with JSON-RPC string id → id echoed",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/list",
            id: "req-abc-123",
          }),
        });
        await assertUnauthorizedEnvelope(res, "req-abc-123");
      },
    );

    await t.step(
      "envelope: POST with JSON-RPC number id → id echoed",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/list",
            id: 42,
          }),
        });
        await assertUnauthorizedEnvelope(res, 42);
      },
    );

    await t.step(
      "envelope: POST with explicit null id → id null",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/list",
            id: null,
          }),
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: POST with object id (unsupported type) → id null",
      async () => {
        // JSON-RPC 2.0 §4 limits id to string, number, or null. We preserve
        // those; anything else (object, array, boolean) collapses to null.
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "x",
            id: { nested: true },
          }),
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: POST with malformed JSON body → id null",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: "{this is not valid json",
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: DELETE (body-less method we skip) → id null, body not read",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "DELETE",
          headers: { "x-brain-key": "wrong" },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: POST with no body → id null",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          method: "POST",
          headers: { "x-brain-key": "wrong" },
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: POST with >64KiB body (Content-Length set by runtime) → id null (DoS-amp cap)",
      async () => {
        // The Web fetch Request constructor sets Content-Length to the
        // string body's byte length, which exceeds the 64 KiB cap and
        // triggers the fast-reject + body.cancel() path in
        // readBodyForJsonRpcId.
        const app = makeApp(requireAuth);
        const huge = "x".repeat(65 * 1024); // 65 KiB, just over the cap
        const res = await app.request("/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: huge,
        });
        await assertUnauthorizedEnvelope(res, null);
      },
    );

    await t.step(
      "envelope: slow-stream body → times out, id null, response stays prompt",
      async () => {
        // Slow-loris regression. The body cap bounds memory; this verifies
        // the timeout bounds time. Without it, an attacker streaming
        // wrong-auth + a body of <64 KiB at <1 byte/sec could hold a
        // request slot indefinitely. The stream below stalls forever;
        // the AUTH_BODY_READ_TIMEOUT_MS=150 override above forces a fast
        // settle so this test runs in ~150 ms instead of the production
        // default of ~2 s.
        const app = makeApp(requireAuth);
        const stallStream = new ReadableStream({
          // No start, no pull → no data is ever enqueued and the stream
          // never closes. reader.read() in auth.ts will be pending
          // until our timeout cancels it.
        });
        const req = new Request("http://test/", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: stallStream,
          // Required by the Fetch standard whenever the body is a stream.
          // Deno's Request supports it; @ts-ignore covers the lib.dom
          // typing gap.
          // deno-lint-ignore no-explicit-any
          duplex: "half" as any,
        } as RequestInit);
        const start = Date.now();
        const res = await app.fetch(req);
        const elapsed = Date.now() - start;
        await assertUnauthorizedEnvelope(res, null);
        // With the 150 ms test timeout, the response must arrive in well
        // under 1 s. Without the cancel-on-timeout fix, this test hangs.
        if (elapsed > 1000) {
          throw new Error(
            `expected fast timeout response, took ${elapsed}ms (knob=${TEST_BODY_READ_TIMEOUT_MS}ms)`,
          );
        }
      },
    );

    await t.step(
      "import isolation: auth module sees the env we set, not a global",
      () => {
        // If a future change broke the dynamic-import-after-env-set pattern,
        // PROTECTED_RESOURCE_METADATA_URL would unexpectedly be non-null here.
        // Keep this guard so a regression in the test scaffolding is obvious.
        assertFalse(PROTECTED_RESOURCE_METADATA_URL !== null);
      },
    );
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
