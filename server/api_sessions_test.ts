// REST gateway tests — session routes. Same hermetic scaffolding as
// api_thoughts_test.ts (FakePool + injected deps + env snapshot around a
// dynamic import). The SQL dispatch keys mirror session_queries.ts: the
// content-hash probe, the INSERT/UPDATE upsert pair, the full-record
// projection, and the artifact child select.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  asPool,
  FakePool,
  makeDeps,
  type QueryHandler,
} from "./api_test_support.ts";
import { computeContentHash, parseSessionToml } from "./session_toml.ts";
import { MAX_SEARCH_QUERY_BYTES } from "./schemas.ts";

const KEY = "k".repeat(64);

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
];

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "x-brain-key": KEY,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> ?? {}),
    },
  };
}

// Minimal full-record row for the SESSION_COLUMNS projection; the route
// narrows id (BigInt) and attaches artifacts.
function sessionRow(id: bigint) {
  return {
    id,
    session_id: null,
    title: "smoke",
    status: "active",
    branch: "main",
    last_update: "2026-07-24T00:00:00Z",
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
  };
}

function capturedSessionRow(status = "active") {
  return {
    id: 7n,
    session_id: null,
    status,
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
  };
}

Deno.test("REST /api/v1 — session routes", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", KEY);
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

  const { createApiRouter } = await import("./api.ts");

  const makeApi = (handler: QueryHandler, deps = makeDeps()) =>
    createApiRouter(asPool(new FakePool(handler)), deps);

  try {
    await t.step("POST /sessions (fresh) → 201 created", async () => {
      const api = makeApi((sql) =>
        sql.includes("INSERT INTO sessions.session")
          ? { rows: [capturedSessionRow()] }
          : undefined
      );
      const res = await api.request(
        "/sessions",
        authed({
          method: "POST",
          body: JSON.stringify({ toml_text: 'title = "smoke"' }),
        }),
      );
      assertEquals(res.status, 201);
      assertEquals(await res.json(), {
        id: 7,
        session_id: null,
        status: "active",
        created: true,
        workspace_id: "default",
        project_id: null,
        visibility: "workspace",
        reembedded: true,
      });
    });

    await t.step(
      "POST /sessions (refresh, unchanged hash) → 200, no re-embed",
      async () => {
        const toml = 'id = 7\ntitle = "same"';
        const hash = await computeContentHash(parseSessionToml(toml).session);
        // deps must be the SAME object the router uses, or the
        // embedCalls assertion below is vacuous (round-1 review finding).
        const deps = makeDeps();
        const api = makeApi((sql) => {
          if (sql.includes("SELECT content_hash")) {
            return { rows: [{ content_hash: hash }] };
          }
          if (sql.includes("UPDATE sessions.session SET")) {
            return { rows: [capturedSessionRow("done")] };
          }
          return undefined;
        }, deps);
        const res = await api.request(
          "/sessions",
          authed({ method: "POST", body: JSON.stringify({ toml_text: toml }) }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.created, false);
        assertEquals(body.reembedded, false);
        assertEquals(deps.embedCalls.length, 0);
      },
    );

    await t.step("POST /sessions (unknown id) → 404", async () => {
      const api = makeApi((sql) =>
        sql.includes("SELECT content_hash") ? { rows: [] } : undefined
      );
      const res = await api.request(
        "/sessions",
        authed({
          method: "POST",
          body: JSON.stringify({ toml_text: 'id = 42\ntitle = "stale"' }),
        }),
      );
      assertEquals(res.status, 404);
      const body = await res.json();
      assertEquals(body.error.code, "not_found");
      assertEquals(body.error.message, "No session found for id 42.");
    });

    await t.step("POST /sessions (bad TOML) → 400", async () => {
      const api = makeApi(() => undefined);
      const res = await api.request(
        "/sessions",
        authed({
          method: "POST",
          body: JSON.stringify({ toml_text: 'status = "active"' }),
        }),
      );
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error.code, "validation_error");
      assert(body.error.message.includes("missing required field 'title'"));
    });

    await t.step(
      "POST /sessions (invalid TOML types) → stable 400 before work",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        const api = createApiRouter(asPool(pool), deps);
        const res = await api.request(
          "/sessions",
          authed({
            method: "POST",
            body: JSON.stringify({
              toml_text: 'title = "typed"\ntags = "not-an-array"',
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assertEquals(body.error.message, "tags must be an array of strings");
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step(
      "POST /sessions (invalid date) → 400 before work",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        const api = createApiRouter(asPool(pool), deps);
        const res = await api.request(
          "/sessions",
          authed({
            method: "POST",
            body: JSON.stringify({
              toml_text: 'title = "bad date"\nlast_update = "2026-02-30"',
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assert(body.error.message.includes("last_update"));
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step("POST /sessions/search → 200 structured rows", async () => {
      const api = makeApi((sql) =>
        sql.includes("FROM sessions.session")
          ? {
            rows: [{
              id: 7n,
              session_id: null,
              title: "smoke",
              status: "active",
              last_update: "2026-07-24T00:00:00Z",
              score: "0.87",
            }],
          }
          : undefined
      );
      const res = await api.request(
        "/sessions/search",
        authed({ method: "POST", body: JSON.stringify({ query: "smoke" }) }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.results[0].id, 7);
      assertEquals(body.results[0].score, 0.87);
    });

    await t.step(
      "POST /sessions/search rejects blank and oversized UTF-8 queries before work",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        const api = createApiRouter(asPool(pool), deps);
        const invalidQueries = [
          "",
          "   \t\n",
          "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
          "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
        ];

        for (const query of invalidQueries) {
          const res = await api.request(
            "/sessions/search",
            authed({ method: "POST", body: JSON.stringify({ query }) }),
          );
          assertEquals(res.status, 400);
          const body = await res.json();
          assertEquals(body.error.code, "validation_error");
          assert(body.error.message.includes("query"));
        }
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step("GET /sessions/lookup?id=7 → 200 full record", async () => {
      const api = makeApi((sql) => {
        if (sql.includes("session_id, title")) {
          return { rows: [sessionRow(7n)] };
        }
        if (sql.includes("FROM sessions.artifact")) {
          return {
            rows: [{ position: 0, kind: "pr", title: "PR #1", detail: null }],
          };
        }
        return undefined;
      });
      const res = await api.request("/sessions/lookup?id=7", authed());
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.id, 7);
      assertEquals(body.artifacts.length, 1);
    });

    await t.step(
      "GET /sessions/lookup?branch=main → newest match",
      async () => {
        const api = makeApi((sql) => {
          if (sql.includes("WHERE branch = $1")) return { rows: [{ id: 9n }] };
          if (sql.includes("session_id, title")) {
            return { rows: [sessionRow(9n)] };
          }
          if (sql.includes("FROM sessions.artifact")) return { rows: [] };
          return undefined;
        });
        const res = await api.request("/sessions/lookup?branch=main", authed());
        assertEquals(res.status, 200);
        assertEquals((await res.json()).id, 9);
      },
    );

    await t.step(
      "GET /sessions/lookup with neither id nor branch → 400",
      async () => {
        const api = makeApi(() => undefined);
        const res = await api.request("/sessions/lookup", authed());
        assertEquals(res.status, 400);
        assert(
          (await res.json()).error.message.includes("Provide id or branch."),
        );
      },
    );

    await t.step("GET /sessions/lookup?id=7 (no match) → 404", async () => {
      const api = makeApi((sql) =>
        sql.includes("session_id, title") ? { rows: [] } : undefined
      );
      const res = await api.request("/sessions/lookup?id=7", authed());
      assertEquals(res.status, 404);
    });

    await t.step(
      "GET /sessions: filters + coerced limit flow into SQL",
      async () => {
        let captured: unknown[] = [];
        const api = makeApi((sql, params) => {
          if (sql.includes("FROM sessions.session")) {
            captured = params;
            return { rows: [] };
          }
          return undefined;
        });
        const res = await api.request(
          "/sessions?status=awaiting_review&limit=10",
          authed(),
        );
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { sessions: [] });
        assertEquals(captured, ["awaiting_review", 10]);
      },
    );

    await t.step(
      "GET /sessions: date bounds validate and normalize before SQL",
      async () => {
        let captured: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("SELECT id, session_id, title")) {
            captured = params;
            return { rows: [] };
          }
          return undefined;
        });
        const api = createApiRouter(asPool(pool), makeDeps());
        const valid = await api.request(
          "/sessions?since=2026-07-29&until=2026-07-30T12%3A00%3A00-04%3A00",
          authed(),
        );
        assertEquals(valid.status, 200);
        assertEquals(captured, [
          "2026-07-29T00:00:00.000Z",
          "2026-07-30T12:00:00-04:00",
          50,
        ]);

        const connectionsBeforeInvalid = pool.connectCalls;
        const invalid = await api.request(
          "/sessions?since=2026-02-30",
          authed(),
        );
        assertEquals(invalid.status, 400);
        assertEquals((await invalid.json()).error.code, "validation_error");
        assertEquals(pool.connectCalls, connectionsBeforeInvalid);
      },
    );

    await t.step("GET /sessions: unknown order_by → 400", async () => {
      const api = makeApi(() => undefined);
      const res = await api.request("/sessions?order_by=embedding", authed());
      assertEquals(res.status, 400);
    });

    await t.step("GET /sessions/:id → 200 / 400 / 404", async () => {
      const api = makeApi((sql) => {
        if (sql.includes("session_id, title")) {
          return { rows: [sessionRow(9n)] };
        }
        if (sql.includes("FROM sessions.artifact")) return { rows: [] };
        return undefined;
      });
      const ok = await api.request("/sessions/9", authed());
      assertEquals(ok.status, 200);
      assertEquals((await ok.json()).id, 9);

      const bad = await api.request("/sessions/abc", authed());
      assertEquals(bad.status, 400);

      const missApi = makeApi((sql) =>
        sql.includes("session_id, title") ? { rows: [] } : undefined
      );
      const miss = await missApi.request("/sessions/9", authed());
      assertEquals(miss.status, 404);
    });

    await t.step("PATCH /sessions/:id/status → 200 {id, status}", async () => {
      let captured: unknown[] = [];
      const api = makeApi((sql, params) => {
        if (sql.includes("UPDATE sessions.session")) {
          captured = params;
          return { rows: [{ id: 7n, status: "done" }] };
        }
        return undefined;
      });
      const res = await api.request(
        "/sessions/7/status",
        authed({ method: "PATCH", body: JSON.stringify({ status: "done" }) }),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { id: 7, status: "done" });
      assertEquals(captured, [7, "done"]);
    });

    await t.step(
      "PATCH /sessions/:id/status: invalid status → 400",
      async () => {
        const api = makeApi(() => undefined);
        const res = await api.request(
          "/sessions/7/status",
          authed({
            method: "PATCH",
            body: JSON.stringify({ status: "finished" }),
          }),
        );
        assertEquals(res.status, 400);
      },
    );

    await t.step("PATCH /sessions/:id/status: unknown id → 404", async () => {
      const api = makeApi((sql) =>
        sql.includes("UPDATE sessions.session") ? { rows: [] } : undefined
      );
      const res = await api.request(
        "/sessions/999/status",
        authed({ method: "PATCH", body: JSON.stringify({ status: "done" }) }),
      );
      assertEquals(res.status, 404);
    });
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
