// REST gateway tests — thoughts routes. Hermetic: FakePool scripts
// the SQL surface, injected deps fake the Ollama embed + metadata extractor,
// and env is snapshot/restored around a dynamic import (api.ts transitively
// imports config.ts + auth.ts, both of which read env at module load — same
// pattern as auth_brainkey_test.ts). Auth is exercised for real: requests
// carry a valid x-brain-key; the failure shapes live in api_auth_test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  asPool,
  FakePool,
  makeDeps,
  makeEmbedDownDeps,
  type QueryHandler,
  withEnv,
} from "./api_test_support.ts";

const KEY = "k".repeat(64);

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: KEY,
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
};

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
  await withEnv([], TEST_ENV, async () => {
    const { createApiRouter } = await import("./api.ts");

    const makeApi = (handler: QueryHandler, deps = makeDeps()) =>
      createApiRouter(asPool(new FakePool(handler)), deps);

    await t.step(
      "POST /thoughts → 201 with versioned claims + verified metadata",
      async () => {
        const api = makeApi((sql, params) =>
          sql.includes("INSERT INTO thoughts")
            ? {
              rows: [{
                id: "uuid-1",
                metadata: JSON.parse(params[2] as string),
                workspace_id: "default",
                project_id: null,
                visibility: "workspace",
              }],
            }
            : undefined
        );
        const res = await api.request(
          "/thoughts",
          authed({
            method: "POST",
            body: JSON.stringify({
              content: "hi",
              provenance: {
                author: "release engineer",
                agent: "codex/gpt",
                repo: "example/open-brain",
                branch: "feature/provenance",
              },
            }),
          }),
        );
        assertEquals(res.status, 201);
        const body = await res.json();
        assertEquals(body.id, "uuid-1");
        assertEquals(body.metadata.source, "rest");
        assertEquals(body.metadata.door, "tailnet");
        assertEquals(body.metadata.sub, null);
        assertEquals(body.workspace_id, "default");
        assertEquals(body.project_id, null);
        assertEquals(body.visibility, "workspace");
        assertEquals(body.metadata.provenance, {
          schema_version: 1,
          caller_asserted: {
            author: "release engineer",
            agent: "codex/gpt",
            repo: "example/open-brain",
            branch: "feature/provenance",
          },
        });
      },
    );

    await t.step(
      "POST /thoughts: sensitive requires a verified/configured principal before embedding",
      async () => {
        const deps = makeDeps();
        const api = makeApi((sql, params) => {
          if (
            sql.includes("FROM memory_scope.workspace AS w") &&
            params[0] === "sensitive"
          ) {
            return {
              rows: [{
                default_visibility: "personal",
                personal_only: true,
                project_exists: true,
              }],
            };
          }
          return undefined;
        }, deps);
        const res = await api.request(
          "/thoughts",
          authed({
            method: "POST",
            body: JSON.stringify({
              content: "particularly sensitive",
              scope: { workspace_id: "sensitive" },
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assert(body.error.message.includes("principal"));
        assertEquals(deps.embedCalls, []);
        assertEquals(deps.extractCalls, []);
      },
    );

    await t.step(
      "POST /thoughts: unknown workspace fails before embedding",
      async () => {
        const deps = makeDeps();
        const api = makeApi(
          (sql) =>
            sql.includes("FROM memory_scope.workspace AS w")
              ? { rows: [] }
              : undefined,
          deps,
        );
        const res = await api.request(
          "/thoughts",
          authed({
            method: "POST",
            body: JSON.stringify({
              content: "must stay local",
              scope: { workspace_id: "misspelled" },
            }),
          }),
        );
        assertEquals(res.status, 400);
        assert(
          (await res.json()).error.message.includes("Unknown workspace_id"),
        );
        assertEquals(deps.embedCalls, []);
        assertEquals(deps.extractCalls, []);
      },
    );

    await t.step(
      "POST /thoughts duplicates return omit-preserved and explicit-replaced provenance",
      async () => {
        let persistedMetadata: Record<string, unknown> = {};
        const api = makeApi((sql, params) => {
          if (!sql.includes("INSERT INTO thoughts")) return undefined;
          assert(sql.includes("RETURNING id, metadata"));
          const incoming = JSON.parse(params[2] as string) as Record<
            string,
            unknown
          >;
          // Model PostgreSQL's top-level JSONB merge on a fingerprint conflict.
          persistedMetadata = { ...persistedMetadata, ...incoming };
          return {
            rows: [{
              id: "uuid-dedupe",
              metadata: { ...persistedMetadata },
            }],
          };
        });
        const post = async (provenance?: Record<string, string>) => {
          const res = await api.request(
            "/thoughts",
            authed({
              method: "POST",
              body: JSON.stringify({
                content: "same content",
                ...(provenance ? { provenance } : {}),
              }),
            }),
          );
          assertEquals(res.status, 201);
          return await res.json();
        };

        const first = await post({
          author: "release engineer",
          agent: "codex",
          repo: "example/open-brain",
          branch: "feature/provenance",
        });
        const original = first.metadata.provenance;

        const omitted = await post();
        assertEquals(omitted.id, "uuid-dedupe");
        assertEquals(omitted.metadata.provenance, original);
        assertEquals(omitted.metadata, persistedMetadata);

        const replaced = await post({ agent: "different-agent" });
        assertEquals(replaced.metadata.provenance, {
          schema_version: 1,
          caller_asserted: { agent: "different-agent" },
        });
        assertEquals(replaced.metadata, persistedMetadata);
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

    await t.step(
      "POST /thoughts: invalid provenance → 400 before persistence",
      async () => {
        // An unscripted queryObject throws. A 400 therefore also proves the
        // invalid caller claim did not reach the DB path.
        const api = makeApi(() => undefined);
        const res = await api.request(
          "/thoughts",
          authed({
            method: "POST",
            body: JSON.stringify({
              content: "x",
              provenance: { actor: "misspelled-author" },
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assert(
          body.error.details.some((issue: { path: string }) =>
            issue.path === "provenance"
          ),
        );
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
        sql.includes("search_thought_candidates")
          ? {
            rows: [{
              id: "uuid-1",
              content: "hit",
              metadata: { type: "observation" },
              workspace_id: "default",
              project_id: null,
              visibility: "workspace",
              created_at: "2026-07-24T00:00:00Z",
              similarity: "0.91",
              vector_rank: 1,
              lexical_rank: 1,
              lexical_source_priority: 0,
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
      assertEquals(body.results[0].rrf_score, 2 / 61);
    });

    await t.step(
      "POST /thoughts/search: provenance filter reaches canonical SQL",
      async () => {
        let capturedSql = "";
        let capturedParams: unknown[] = [];
        const api = makeApi((sql, params) => {
          if (sql.includes("search_thought_candidates")) {
            capturedSql = sql;
            capturedParams = params;
            return { rows: [] };
          }
          return undefined;
        });
        const res = await api.request(
          "/thoughts/search",
          authed({
            method: "POST",
            body: JSON.stringify({
              query: "release checklist",
              limit: 2,
              threshold: 0.65,
              filter: {
                include: { repo: "example/open-brain" },
                exclude: {
                  author: "release engineering",
                  agent: "codex",
                },
              },
            }),
          }),
        );
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { results: [] });
        assertEquals(
          capturedSql.includes("memory_scope.search_thought_candidates("),
          true,
        );
        assertEquals(capturedParams.slice(1), [
          0.65,
          "release checklist",
          "release checklist",
          true,
          JSON.stringify({
            provenance: {
              caller_asserted: { repo: "example/open-brain" },
            },
          }),
          JSON.stringify([
            {
              provenance: {
                caller_asserted: { author: "release engineering" },
              },
            },
            {
              provenance: { caller_asserted: { agent: "codex" } },
            },
          ]),
          50,
        ]);
      },
    );

    await t.step(
      "POST /thoughts/search: malformed filter → 400 before embedding or DB",
      async () => {
        const deps = makeDeps();
        const api = makeApi(() => undefined, deps);
        const res = await api.request(
          "/thoughts/search",
          authed({
            method: "POST",
            body: JSON.stringify({ query: "x", filter: {} }),
          }),
        );
        assertEquals(res.status, 400);
        assertEquals((await res.json()).error.code, "validation_error");
        assertEquals(deps.embedCalls, []);
      },
    );

    await t.step(
      "POST /thoughts/search: unknown envelope key → 400 instead of widening",
      async () => {
        const deps = makeDeps();
        const api = makeApi(() => undefined, deps);
        const res = await api.request(
          "/thoughts/search",
          authed({
            method: "POST",
            body: JSON.stringify({
              query: "x",
              filters: { include: { author: "alice" } },
            }),
          }),
        );
        assertEquals(res.status, 400);
        const body = await res.json();
        assertEquals(body.error.code, "validation_error");
        assertEquals(
          body.error.message.includes('Unrecognized key: "filters"'),
          true,
        );
        assertEquals(deps.embedCalls, []);
      },
    );

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

    // ─── PATCH /thoughts/:id (update) + POST /thoughts/:id/move ───────
    // The orchestration itself is covered in thought_mutations_test.ts; these
    // steps pin the REST envelope: status codes, body shapes, and the 409.
    const MUTATION_ID = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
    const headRow = {
      id: MUTATION_ID,
      content: "old text",
      metadata: { type: "observation", source: "rest", door: "tailnet" },
      workspace_id: "default",
      project_id: null,
      visibility: "workspace",
      owner_subject: null,
      content_fingerprint: "old-fp",
      new_fingerprint: "new-fp",
      created_at: "2026-08-10T00:00:00Z",
      updated_at: null,
    };
    const updateHandler =
      (colliding: string | null = null): QueryHandler => (sql, params) => {
        if (sql.includes("FROM thoughts WHERE id = $1")) {
          return { rows: [headRow] };
        }
        if (sql.includes("id <> $6")) {
          return { rows: colliding ? [{ id: colliding }] : [] };
        }
        if (sql.includes("INSERT INTO thought_revisions")) {
          return { rows: [{ revision: 3 }] };
        }
        if (sql.includes("UPDATE thoughts")) {
          return {
            rows: [{
              id: MUTATION_ID,
              content: params[1],
              metadata: { ...JSON.parse(params[3] as string), source: "rest" },
              workspace_id: "default",
              project_id: null,
              visibility: "workspace",
              created_at: "2026-08-10T00:00:00Z",
              updated_at: "2026-08-17T00:00:00Z",
            }],
          };
        }
        return undefined;
      };

    await t.step("PATCH /thoughts/:id → 200 with the updated row", async () => {
      const api = makeApi(updateHandler());
      const res = await api.request(
        `/thoughts/${MUTATION_ID}`,
        authed({
          method: "PATCH",
          body: JSON.stringify({ content: "corrected text" }),
        }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.id, MUTATION_ID);
      assertEquals(body.outcome, "updated");
      assertEquals(body.revision, 3);
      assertEquals(body.content, "corrected text");
      assertEquals(body.metadata.source, "rest");
      assertEquals(body.metadata.topics, ["testing"]);
    });

    await t.step("PATCH /thoughts/:id → 404 when not visible", async () => {
      const api = makeApi((sql) =>
        sql.includes("FROM thoughts WHERE id = $1") ? { rows: [] } : undefined
      );
      const res = await api.request(
        `/thoughts/${MUTATION_ID}`,
        authed({ method: "PATCH", body: JSON.stringify({ content: "x" }) }),
      );
      assertEquals(res.status, 404);
      assertEquals((await res.json()).error.code, "not_found");
    });

    await t.step(
      "PATCH /thoughts/:id → 409 conflict naming the colliding row",
      async () => {
        const other = "0b3d2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        const api = makeApi(updateHandler(other));
        const res = await api.request(
          `/thoughts/${MUTATION_ID}`,
          authed({
            method: "PATCH",
            body: JSON.stringify({ content: "duplicate text" }),
          }),
        );
        assertEquals(res.status, 409);
        const body = await res.json();
        assertEquals(body.error.code, "conflict");
        assert(body.error.message.includes(other));
      },
    );

    await t.step(
      "PATCH /thoughts/:id → 400 on empty content, unknown body key, or bad id",
      async () => {
        const api = makeApi(() => undefined);
        for (
          const [path, body] of [
            [`/thoughts/${MUTATION_ID}`, { content: "" }],
            [`/thoughts/${MUTATION_ID}`, { content: "x", extra: true }],
            [`/thoughts/${MUTATION_ID}`, { text: "x" }],
            ["/thoughts/not-a-uuid", { content: "x" }],
          ] as const
        ) {
          const res = await api.request(
            path,
            authed({ method: "PATCH", body: JSON.stringify(body) }),
          );
          assertEquals(res.status, 400, `${path} ${JSON.stringify(body)}`);
          assertEquals((await res.json()).error.code, "validation_error");
        }
      },
    );

    await t.step(
      "PATCH /thoughts/:id → 502 when the embedder is down",
      async () => {
        const { deps } = makeEmbedDownDeps();
        const api = makeApi(updateHandler(), deps);
        const res = await api.request(
          `/thoughts/${MUTATION_ID}`,
          authed({ method: "PATCH", body: JSON.stringify({ content: "x" }) }),
        );
        assertEquals(res.status, 502);
        assertEquals((await res.json()).error.code, "upstream_error");
      },
    );

    const moveHandler =
      (outcome: string | null, conflict: string | null = null): QueryHandler =>
      (sql, params) => {
        if (sql.includes("memory_scope.move_thought(")) {
          return {
            rows: outcome === null ? [] : [{
              outcome,
              conflict_thought_id: conflict,
              revision: outcome === "moved" ? 1 : null,
              workspace_id: params[1],
              project_id: params[2],
              visibility: params[3],
            }],
          };
        }
        return undefined;
      };

    await t.step(
      "POST /thoughts/:id/move → 200 with the new audience",
      async () => {
        // MCP_ACCESS_KEY_PRINCIPAL is unset in this suite, so a personal target
        // would fail validation; a workspace→workspace move exercises the path.
        const api = makeApi(moveHandler("moved"));
        const res = await api.request(
          `/thoughts/${MUTATION_ID}/move`,
          authed({
            method: "POST",
            body: JSON.stringify({
              target: { workspace_id: "default", visibility: "workspace" },
            }),
          }),
        );
        assertEquals(res.status, 200);
        assertEquals(await res.json(), {
          id: MUTATION_ID,
          outcome: "moved",
          conflict_thought_id: null,
          revision: 1,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
        });
      },
    );

    await t.step("POST /thoughts/:id/move → 404 when not visible", async () => {
      const api = makeApi(moveHandler(null));
      const res = await api.request(
        `/thoughts/${MUTATION_ID}/move`,
        authed({
          method: "POST",
          body: JSON.stringify({
            target: { workspace_id: "default", visibility: "workspace" },
          }),
        }),
      );
      assertEquals(res.status, 404);
    });

    await t.step(
      "POST /thoughts/:id/move → 409 on a target-audience collision",
      async () => {
        const other = "0b3d2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        const api = makeApi(moveHandler("conflict", other));
        const res = await api.request(
          `/thoughts/${MUTATION_ID}/move`,
          authed({
            method: "POST",
            body: JSON.stringify({
              target: { workspace_id: "default", visibility: "workspace" },
            }),
          }),
        );
        assertEquals(res.status, 409);
        const body = await res.json();
        assertEquals(body.error.code, "conflict");
        assert(body.error.message.includes(other));
      },
    );

    await t.step(
      "POST /thoughts/:id/move → 400 when the target is defaulted, mis-shaped, or personal without a principal",
      async () => {
        const api = makeApi(moveHandler("moved"));
        for (
          const body of [
            { target: { workspace_id: "default" } },
            { target: { visibility: "workspace" } },
            { target: { workspace_id: "default", visibility: "project" } },
            {
              target: {
                workspace_id: "default",
                project_id: "alpha",
                visibility: "workspace",
              },
            },
            { target: { workspace_id: "default", visibility: "personal" } },
            { scope: { workspace_id: "default" } },
          ]
        ) {
          const res = await api.request(
            `/thoughts/${MUTATION_ID}/move`,
            authed({ method: "POST", body: JSON.stringify(body) }),
          );
          assertEquals(res.status, 400, JSON.stringify(body));
          assertEquals((await res.json()).error.code, "validation_error");
        }
      },
    );

    await t.step(
      "unknown path (authed) → 404 with the JSON error shape",
      async () => {
        // The advertised contract is JSON errors everywhere — the terminal
        // catch-all must beat Hono's default text/plain 404 (round-1
        // review finding).
        const api = makeApi(() => undefined);
        const res = await api.request("/does-not-exist", authed());
        assertEquals(res.status, 404);
        assertEquals(
          res.headers.get("content-type")?.startsWith("application/json"),
          true,
        );
        assertEquals((await res.json()).error.code, "not_found");
      },
    );

    await t.step(
      "unsupported method (authed POST /thoughts/stats) → 404 JSON",
      async () => {
        const api = makeApi(() => undefined);
        const res = await api.request(
          "/thoughts/stats",
          authed({ method: "POST", body: JSON.stringify({}) }),
        );
        assertEquals(res.status, 404);
        assertEquals((await res.json()).error.code, "not_found");
      },
    );

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
  })();
});
