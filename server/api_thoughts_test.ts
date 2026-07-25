// REST gateway tests — thoughts routes. Hermetic: FakePool scripts
// the SQL surface, injected deps fake the Ollama embed + metadata extractor,
// and env is snapshot/restored around a dynamic import (api.ts transitively
// imports config.ts + auth.ts, both of which read env at module load — same
// pattern as auth_brainkey_test.ts). Auth is exercised for real: requests
// carry a valid x-brain-key; the failure shapes live in api_auth_test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  asPool,
  FakePool,
  makeDeps,
  makeEmbedDownDeps,
  type QueryHandler,
} from "./api_test_support.ts";

const KEY = "k".repeat(64);

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
];

// Adds the valid x-brain-key + JSON content type to a request init.
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

Deno.test("REST /api/v1 — thoughts routes", async (t) => {
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

  const makeApi = (handler: QueryHandler, deps = makeDeps()) =>
    createApiRouter(asPool(new FakePool(handler)), deps);

  try {
    await t.step(
      "POST /thoughts → 201 with id + stamped metadata",
      async () => {
        const api = makeApi((sql) =>
          sql.includes("INSERT INTO thoughts")
            ? { rows: [{ id: "uuid-1" }] }
            : undefined
        );
        const res = await api.request(
          "/thoughts",
          authed({ method: "POST", body: JSON.stringify({ content: "hi" }) }),
        );
        assertEquals(res.status, 201);
        const body = await res.json();
        assertEquals(body.id, "uuid-1");
        assertEquals(body.metadata.source, "rest");
        assertEquals(body.metadata.door, "tailnet");
        assertEquals(body.metadata.sub, null);
      },
    );

    await t.step(
      "POST /thoughts: missing content → 400 with details",
      async () => {
        const api = makeApi(() => undefined);
        const res = await api.request(
          "/thoughts",
          authed({ method: "POST", body: JSON.stringify({}) }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assert(Array.isArray(body.error.details));
        assertEquals(body.error.details[0].path, "content");
      },
    );

    await t.step("POST /thoughts: malformed JSON body → 400", async () => {
      const api = makeApi(() => undefined);
      const res = await api.request(
        "/thoughts",
        authed({ method: "POST", body: "{not json" }),
      );
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error.code, "validation_error");
      assertEquals(body.error.message, "request body must be valid JSON");
    });

    await t.step("POST /thoughts: embed backend down → 502", async () => {
      const { deps, message } = makeEmbedDownDeps();
      const api = makeApi(() => undefined, deps);
      const res = await api.request(
        "/thoughts",
        authed({ method: "POST", body: JSON.stringify({ content: "x" }) }),
      );
      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error.code, "upstream_error");
      assertEquals(body.error.message, message);
    });

    await t.step("POST /thoughts: body over 1 MiB → 413", async () => {
      const api = makeApi(() => undefined);
      const res = await api.request(
        "/thoughts",
        authed({
          method: "POST",
          body: JSON.stringify({ content: "a".repeat(1024 * 1024 + 64) }),
        }),
      );
      assertEquals(res.status, 413);
      const body = await res.json();
      assertEquals(body.error.code, "payload_too_large");
    });

    await t.step("POST /thoughts/search → 200 structured results", async () => {
      // similarity decodes as text at the driver layer (like session score);
      // the query layer must narrow it so REST JSON carries a number.
      const api = makeApi((sql) =>
        sql.includes("FROM thoughts")
          ? {
            rows: [{
              id: "uuid-1",
              content: "hit",
              metadata: { type: "observation" },
              created_at: "2026-07-24T00:00:00Z",
              similarity: "0.91",
            }],
          }
          : undefined
      );
      const res = await api.request(
        "/thoughts/search",
        authed({ method: "POST", body: JSON.stringify({ query: "hit" }) }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.results.length, 1);
      assertEquals(body.results[0].id, "uuid-1");
      assertEquals(body.results[0].similarity, 0.91);
    });

    await t.step(
      "GET /thoughts: query coercion flows into SQL params",
      async () => {
        let captured: unknown[] = [];
        const api = makeApi((sql, params) => {
          if (sql.includes("ORDER BY created_at DESC")) {
            captured = params;
            return { rows: [] };
          }
          return undefined;
        });
        const res = await api.request("/thoughts?limit=5&days=2", authed());
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { thoughts: [] });
        // listThoughts binds the days filter first, then the limit.
        assertEquals(captured, [2, 5]);
      },
    );

    await t.step("GET /thoughts: non-numeric limit → 400", async () => {
      const api = makeApi(() => undefined);
      const res = await api.request("/thoughts?limit=lots", authed());
      assertEquals(res.status, 400);
    });

    await t.step("GET /thoughts/stats → 200 aggregate shape", async () => {
      const api = makeApi((sql) => {
        if (sql.includes("COUNT(*)::int AS count")) {
          return {
            rows: [{
              count: 3,
              earliest: "2026-01-01T00:00:00Z",
              latest: "2026-07-24T00:00:00Z",
            }],
          };
        }
        if (sql.includes("metadata->>'type' AS k")) {
          return { rows: [{ k: "observation", c: 3 }] };
        }
        if (sql.includes("AS topic")) return { rows: [{ k: "testing", c: 2 }] };
        if (sql.includes("AS person")) return { rows: [] };
        return undefined;
      });
      const res = await api.request("/thoughts/stats", authed());
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.count, 3);
      assertEquals(body.types, [["observation", 3]]);
      assertEquals(body.topics, [["testing", 2]]);
      assertEquals(body.people, []);
    });

    await t.step("GET /thoughts/:id → 200 when found", async () => {
      const uuid = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
      const api = makeApi((sql, params) =>
        sql.includes("FROM thoughts WHERE id = $1")
          ? {
            rows: [{
              id: params[0],
              content: "the thought",
              metadata: {},
              created_at: "2026-07-24T00:00:00Z",
              updated_at: null,
            }],
          }
          : undefined
      );
      const res = await api.request(`/thoughts/${uuid}`, authed());
      assertEquals(res.status, 200);
      assertEquals((await res.json()).id, uuid);
    });

    await t.step("GET /thoughts/:id → 404 when missing", async () => {
      const api = makeApi((sql) =>
        sql.includes("FROM thoughts WHERE id = $1") ? { rows: [] } : undefined
      );
      const res = await api.request(
        "/thoughts/6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01",
        authed(),
      );
      assertEquals(res.status, 404);
      assertEquals((await res.json()).error.code, "not_found");
    });

    await t.step(
      "GET /thoughts/:id → 400 on malformed id (no DB hit)",
      async () => {
        // An unscripted handler would reject any queryObject — reaching the DB
        // with a non-UUID would fail this test as a 500.
        const api = makeApi(() => undefined);
        const res = await api.request("/thoughts/not-a-uuid", authed());
        assertEquals(res.status, 400);
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
