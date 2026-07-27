// REST gateway tests — auth failure shapes. requireAuth is reused
// unmodified from auth.ts (its own suites cover the doors exhaustively);
// what's REST-specific is the restifyAuthFailure wrapper in api.ts, which
// rewrites the MCP-flavored failure body (the JSON-RPC error envelope on
// the 401) into a plain HTTP 401 JSON error that curl/scripts can parse
// as `{error: {code, message}}`. Headers minted by requireAuth
// (Cache-Control: no-store) must survive the rewrite.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { asPool, FakePool, makeDeps } from "./api_test_support.ts";

const KEY = "k".repeat(64);

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
];

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
  // ─── Setup ─────────────────────────────────────────────────────────────
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", KEY);
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

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

  try {
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
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
