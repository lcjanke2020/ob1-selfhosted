// REST gateway tests — auth failure shapes. requireAuth is reused
// unmodified from auth.ts (its own suites cover the doors exhaustively);
// what's REST-specific is the restifyAuthFailure wrapper in api.ts, which
// rewrites the MCP-flavored failure body (the JSON-RPC error envelope on
// the 401) into a plain HTTP 401 JSON error that curl/scripts can parse
// as `{error: {code, message}}`. Headers minted by requireAuth
// (Cache-Control: no-store) must survive the rewrite.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { asPool, FakePool, makeDeps, withEnv } from "./api_test_support.ts";

const KEY = "k".repeat(64);

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: KEY,
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
};

async function assertRest401(res: Response): Promise<void> {
  assertEquals(res.status, 401);
  assertEquals(
    res.headers.get("content-type")?.startsWith("application/json"),
    true,
  );
  assertEquals(
    res.headers.get("cache-control"),
    "no-store",
    "requireAuth's no-store must survive the rewrite",
  );
  const body = await res.json();
  assertEquals(body.error.code, "unauthorized");
  assertEquals(
    body.error.message,
    "Unauthorized: missing or invalid authentication.",
  );
  assertEquals("jsonrpc" in body, false, "REST must not leak the MCP envelope");
}

Deno.test("REST /api/v1 — auth failure shapes", async (t) => {
  await withEnv([], TEST_ENV, async () => {
    const { createApiRouter } = await import("./api.ts");

    const api = createApiRouter(
      asPool(
        new FakePool((sql) =>
          // Only the stats aggregates are scripted — auth-failed requests must
          // never reach the DB, and any other query would throw a 500.
          sql.includes("COUNT(*)::int AS count")
            ? { rows: [{ count: 0, earliest: null, latest: null }] }
            : sql.includes("AS k") || sql.includes("AS topic") ||
                sql.includes("AS person")
            ? { rows: [] }
            : undefined
        ),
      ),
      makeDeps(),
    );

    await t.step(
      "no credential → 401 JSON error (not the MCP envelope)",
      async () => {
        const res = await api.request("/thoughts/stats");
        await assertRest401(res);
      },
    );

    await t.step(
      "unknown path without credentials → uniform 401, not 404",
      async () => {
        // Auth is checked before the catch-all, so an unauthenticated
        // probe can't distinguish real routes from non-routes.
        const res = await api.request("/does-not-exist");
        await assertRest401(res);
      },
    );

    await t.step(
      "wrong x-brain-key → 401 (requireAuth's envelope body is rewritten)",
      async () => {
        // On /mcp this exact request gets HTTP 401 + a JSON-RPC error
        // envelope body. REST rewrites the body to a plain JSON error.
        const res = await api.request("/thoughts/stats", {
          headers: { "x-brain-key": "wrong" },
        });
        await assertRest401(res);
      },
    );

    await t.step(
      "wrong key on a write route → 401, handler never runs",
      async () => {
        const res = await api.request("/thoughts", {
          method: "POST",
          headers: {
            "x-brain-key": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({ content: "must not be captured" }),
        });
        await assertRest401(res);
      },
    );

    await t.step("valid key → 200 and a real response", async () => {
      const res = await api.request("/thoughts/stats", {
        headers: { "x-brain-key": KEY },
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.count, 0);
      assert(!("error" in body));
    });
  })();
});
