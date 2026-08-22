// Tests for the `requireAuth` middleware with the x-brain-key door ENABLED
// (MCP_ACCESS_KEY set) and OAuth DISABLED — the `compose-local` deployment mode.
// Run with `deno task test`.
//
// auth failure shape is uniform since audit finding PR55-AUTH-001: every
// rejection — missing or tried-but-invalid credentials — returns HTTP 401
// with a JSON-RPC 2.0 error envelope body (code -32001). The
// transport-level 401 is the RFC 6750 / MCP-authorization-spec signal
// OAuth-capable clients key re-authorization off; the envelope body is
// kept for JSON-RPC id correlation.
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

import { assertEquals, assertFalse } from "@std/assert";
import {
  assertUnauthorized401,
  makeAuthTestApp as makeApp,
  withEnv,
} from "./api_test_support.ts";

const KEY = "k".repeat(64);

// Test override of the production 2000 ms body-read timeout. Lets the
// slow-stream regression test settle in ~150 ms rather than ~2 s; the
// `200 ms - ε` envelope of "this didn't wait for the body" is still
// observable, just on a tighter clock.
const TEST_BODY_READ_TIMEOUT_MS = "150";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: KEY,
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
  AUTH_BODY_READ_TIMEOUT_MS: TEST_BODY_READ_TIMEOUT_MS,
};

Deno.test("requireAuth (x-brain-key door enabled, OAuth disabled — compose-local mode)", async (t) => {
  await withEnv([], TEST_ENV, async () => {
    const { requireAuth, PROTECTED_RESOURCE_METADATA_URL } = await import(
      "./auth.ts"
    );
    await t.step(
      "module sanity: OAuth metadata URL is null when AUTH0_* unset",
      () => {
        assertEquals(PROTECTED_RESOURCE_METADATA_URL, null);
      },
    );

    // ─── requireAuth (MCP transport → 401 + envelope body on auth-fail) ─
    await t.step("requireAuth: valid x-brain-key → 200", async () => {
      const app = makeApp(requireAuth);
      const res = await app.request("/", { headers: { "x-brain-key": KEY } });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
    });

    await t.step(
      "requireAuth: invalid x-brain-key → 401 with JSON-RPC error envelope",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          headers: { "x-brain-key": "wrong" },
        });
        await assertUnauthorized401(res, null);
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
      "requireAuth: invalid brain-key + Bearer (OAuth off) → 401, Bearer ignored",
      async () => {
        const app = makeApp(requireAuth);
        const res = await app.request("/", {
          headers: {
            "x-brain-key": "wrong",
            "authorization": "Bearer something",
          },
        });
        // OAuth is disabled, so the Bearer path is never tried — but the
        // operator-facing message is a single neutral string regardless.
        // (Audit row still distinguishes the cause via the
        // AuthFailureReason enum — separate concern from the response.)
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "requireAuth: 401 has no WWW-Authenticate header in Pattern A",
      async () => {
        // Missing creds → HTTP 401. PROTECTED_RESOURCE_METADATA_URL is
        // null when OAuth disabled, so the unauthorized() helper skips
        // the WWW-Authenticate emission on the 401.
        const app = makeApp(requireAuth);
        const res = await app.request("/");
        await assertUnauthorized401(res, null);
        assertEquals(res.headers.get("www-authenticate"), null);
      },
    );

    // ─── constantTimeEqual / checkBrainKey (via requireAuth) ──────────
    await t.step(
      "brain-key compare: length-mismatched provided value still rejected (no early-return leak)",
      async () => {
        const app = makeApp(requireAuth);
        const short = await app.request("/", {
          headers: { "x-brain-key": "k" },
        });
        await assertUnauthorized401(short, null);
        const long = await app.request("/", {
          headers: { "x-brain-key": KEY + "extra" },
        });
        await assertUnauthorized401(long, null);
      },
    );

    await t.step(
      "brain-key compare: differs only in last byte → 401",
      async () => {
        const app = makeApp(requireAuth);
        const wrong = KEY.slice(0, -1) + "x";
        const res = await app.request("/", {
          headers: { "x-brain-key": wrong },
        });
        await assertUnauthorized401(res, null);
      },
    );

    await t.step(
      "brain-key compare: differs only in first byte → 401",
      async () => {
        const app = makeApp(requireAuth);
        const wrong = "x" + KEY.slice(1);
        const res = await app.request("/", {
          headers: { "x-brain-key": wrong },
        });
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, "req-abc-123");
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
        await assertUnauthorized401(res, 42);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
        await assertUnauthorized401(res, null);
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
  })();
});
