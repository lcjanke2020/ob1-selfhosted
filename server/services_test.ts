// Tests for the shared orchestration layer (services.ts) used by
// both the MCP tools and the REST gateway. Hermetic: FakePool scripts the SQL
// surface (api_test_support.ts), injected deps replace the Ollama embed +
// metadata extractor, and env is snapshot/restored around a dynamic import
// (services.ts transitively imports config.ts, which validates env at module
// load — same pattern as auth_brainkey_test.ts).

import { assertEquals, assertRejects } from "@std/assert";
import {
  asPool,
  FAKE_VECTOR,
  FakePool,
  makeDeps,
  makeEmbedDownDeps,
} from "./api_test_support.ts";
import { MAX_SEARCH_QUERY_BYTES } from "./schemas.ts";
import { computeContentHash, parseSessionToml } from "./session_toml.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
];

const AUTH = { door: "tailnet" as const, sub: null };

function persistedSession(status: string, sessionId: string | null = null) {
  return {
    id: 7n,
    session_id: sessionId,
    status,
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
  };
}

function sessionSearchRow(id: number, score = 0.9) {
  return {
    id: BigInt(id),
    session_id: null,
    title: `session-${id}`,
    status: "active",
    last_update: null,
    score: String(score),
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
  };
}

Deno.test("services (orchestration shared by MCP + REST)", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");

  const {
    captureSessionFromToml,
    captureThoughtWithMetadata,
    fetchThoughtInScope,
    listSessionsInScope,
    NotFoundError,
    searchSessionsByQuery,
    searchThoughtsByQuery,
    updateSessionStatusInScope,
    UpstreamError,
    ValidationError,
  } = await import("./services.ts");

  try {
    // ─── captureThoughtWithMetadata ───────────────────────────────────
    await t.step(
      "thought capture: persists versioned caller assertions beside verified transport stamps",
      async () => {
        let captured: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("INSERT INTO thoughts")) {
            captured = params;
            return {
              rows: [{
                id: "uuid-1",
                metadata: JSON.parse(params[2] as string),
              }],
            };
          }
          return undefined;
        });
        const deps = makeDeps();
        const out = await captureThoughtWithMetadata(
          asPool(pool),
          {
            content: "rest smoke",
            provenance: {
              author: "release engineer",
              agent: "codex/gpt",
              repo: "example/open-brain",
              branch: "feature/provenance",
            },
            auth: AUTH,
            via: "rest",
          },
          deps,
        );
        assertEquals(out.id, "uuid-1");
        assertEquals(out.metadata.source, "rest");
        assertEquals(out.metadata.door, "tailnet");
        assertEquals(out.metadata.sub, null);
        assertEquals(out.metadata.type, "observation");
        assertEquals(out.metadata.provenance, {
          schema_version: 1,
          caller_asserted: {
            author: "release engineer",
            agent: "codex/gpt",
            repo: "example/open-brain",
            branch: "feature/provenance",
          },
        });
        assertEquals(deps.embedCalls, ["rest smoke"]);
        assertEquals(deps.extractCalls, ["rest smoke"]);
        // Persisted row got the same stamped metadata ($3) and the vector ($2).
        const persisted = JSON.parse(captured[2] as string);
        assertEquals(persisted.source, "rest");
        assertEquals(persisted.provenance, out.metadata.provenance);
        assertEquals(captured[1], `[${FAKE_VECTOR.join(",")}]`);
      },
    );

    await t.step(
      "thought capture: via 'mcp' persists source 'mcp' (MCP rows byte-identical to pre-refactor)",
      async () => {
        const pool = new FakePool((sql, params) =>
          sql.includes("INSERT INTO thoughts")
            ? {
              rows: [{
                id: "uuid-2",
                metadata: JSON.parse(params[2] as string),
              }],
            }
            : undefined
        );
        const out = await captureThoughtWithMetadata(
          asPool(pool),
          {
            content: "x",
            auth: { door: "funnel", sub: "auth0|abc" },
            via: "mcp",
          },
          makeDeps(),
        );
        assertEquals(out.metadata.source, "mcp");
        assertEquals(out.metadata.door, "funnel");
        assertEquals(out.metadata.sub, "auth0|abc");
        assertEquals(out.metadata.provenance, undefined);
      },
    );

    await t.step(
      "thought capture: reserved metadata keys cannot be forged by an extractor",
      async () => {
        const pool = new FakePool((sql, params) =>
          sql.includes("INSERT INTO thoughts")
            ? {
              rows: [{
                id: "uuid-3",
                metadata: JSON.parse(params[2] as string),
              }],
            }
            : undefined
        );
        const deps = makeDeps({
          extractMetadata: () =>
            Promise.resolve({
              type: "observation",
              source: "forged-source",
              door: "forged-door",
              sub: "forged-sub",
              provenance: { forged: true },
            }),
        });
        const out = await captureThoughtWithMetadata(
          asPool(pool),
          {
            content: "x",
            provenance: { author: "caller claim" },
            auth: { door: "funnel", sub: "verified-sub" },
            via: "mcp",
          },
          deps,
        );
        assertEquals(out.metadata.source, "mcp");
        assertEquals(out.metadata.door, "funnel");
        assertEquals(out.metadata.sub, "verified-sub");
        assertEquals(out.metadata.provenance, {
          schema_version: 1,
          caller_asserted: { author: "caller claim" },
        });
      },
    );

    await t.step(
      "thought capture: direct service callers cannot persist empty provenance",
      async () => {
        const pool = new FakePool(() => {
          throw new Error("database must not be reached");
        });
        for (const provenance of [{}, { author: undefined }]) {
          const deps = makeDeps();
          await assertRejects(
            () =>
              captureThoughtWithMetadata(
                asPool(pool),
                { content: "x", provenance, auth: AUTH, via: "rest" },
                deps,
              ),
            ValidationError,
            "provenance must include at least one",
          );
          assertEquals(deps.embedCalls, []);
          assertEquals(deps.extractCalls, []);
        }
      },
    );

    await t.step(
      "thought capture: embed failure → UpstreamError with the original message",
      async () => {
        const pool = new FakePool(() => undefined);
        const { deps, message } = makeEmbedDownDeps();
        await assertRejects(
          () =>
            captureThoughtWithMetadata(
              asPool(pool),
              { content: "x", auth: AUTH, via: "rest" },
              deps,
            ),
          UpstreamError,
          message,
        );
      },
    );

    // ─── searchThoughtsByQuery / searchSessionsByQuery ────────────────
    await t.step(
      "thought search: embeds the query and passes bounds through",
      async () => {
        let captured: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("search_thought_candidates")) {
            captured = params;
            return {
              rows: [{
                id: "uuid-1",
                content: "hit",
                metadata: {},
                workspace_id: "default",
                project_id: null,
                visibility: "workspace",
                created_at: "2026-07-24T00:00:00Z",
                similarity: 0.9,
                vector_rank: 1,
                lexical_rank: null,
                lexical_source_priority: null,
              }],
            };
          }
          return undefined;
        });
        const deps = makeDeps();
        const rows = await searchThoughtsByQuery(
          asPool(pool),
          { query: "find me", limit: 3, threshold: 0.7, auth: AUTH },
          deps,
        );
        assertEquals(rows.length, 1);
        assertEquals(deps.embedCalls, ["find me"]);
        assertEquals(captured, [
          `[${FAKE_VECTOR.join(",")}]`,
          0.7,
          "find me",
          "find me",
          true,
          null,
          "[]",
          50,
        ]);
        assertEquals(rows[0].rrf_score, 1 / 61);
      },
    );

    await t.step(
      "thought search: include and any-match exclusions reach canonical SQL",
      async () => {
        let capturedSql = "";
        let capturedParams: unknown[] = [];
        const statements: string[] = [];
        const pool = new FakePool((sql, params) => {
          statements.push(sql.trim());
          if (sql.includes("search_thought_candidates")) {
            capturedSql = sql;
            capturedParams = params;
            return { rows: [] };
          }
          return undefined;
        });
        const deps = makeDeps();
        await searchThoughtsByQuery(
          asPool(pool),
          {
            query: "release checklist",
            limit: 4,
            threshold: 0.6,
            filter: {
              include: {
                author: "  release engineering  ",
                repo: "  example/open-brain  ",
              },
              exclude: { agent: "  codex  ", branch: "  archived  " },
            },
            auth: AUTH,
          },
          deps,
        );

        assertEquals(deps.embedCalls, ["release checklist"]);
        assertEquals(
          statements.includes("BEGIN"),
          true,
        );
        assertEquals(
          statements.includes(
            "SELECT set_config('hnsw.ef_search', $1::text, true)",
          ),
          true,
        );
        assertEquals(
          statements.includes("SET LOCAL hnsw.iterative_scan = strict_order"),
          true,
        );
        assertEquals(statements[statements.length - 1], "COMMIT");
        assertEquals(capturedParams, [
          `[${FAKE_VECTOR.join(",")}]`,
          0.6,
          "release checklist",
          "release checklist",
          true,
          JSON.stringify({
            provenance: {
              caller_asserted: {
                author: "release engineering",
                repo: "example/open-brain",
              },
            },
          }),
          JSON.stringify([
            {
              provenance: { caller_asserted: { agent: "codex" } },
            },
            {
              provenance: { caller_asserted: { branch: "archived" } },
            },
          ]),
          50,
        ]);
        assertEquals(
          capturedSql.includes("memory_scope.search_thought_candidates("),
          true,
        );
        assertEquals(capturedSql.includes("$8::int"), true);
        assertEquals(capturedSql.includes("match_thoughts"), false);
      },
    );

    await t.step(
      "thought search: filtered query failures roll back the local HNSW setting",
      async () => {
        const statements: string[] = [];
        const pool = new FakePool((sql) => {
          statements.push(sql.trim());
          return undefined;
        });

        await assertRejects(
          () =>
            searchThoughtsByQuery(
              asPool(pool),
              {
                query: "release checklist",
                filter: { exclude: { author: "blocked" } },
                auth: AUTH,
              },
              makeDeps(),
            ),
          Error,
          "unscripted queryObject",
        );
        assertEquals(statements.includes("BEGIN"), true);
        assertEquals(
          statements.includes(
            "SELECT set_config('hnsw.ef_search', $1::text, true)",
          ),
          true,
        );
        assertEquals(
          statements.includes(
            "SET LOCAL hnsw.iterative_scan = strict_order",
          ),
          true,
        );
        assertEquals(statements.includes("ROLLBACK"), true);
        assertEquals(statements.includes("COMMIT"), false);
      },
    );

    await t.step(
      "thought search: direct callers fail malformed filters before embedding",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        await assertRejects(
          () =>
            searchThoughtsByQuery(
              asPool(pool),
              { query: "x", filter: {} as never, auth: AUTH },
              deps,
            ),
          ValidationError,
          "filter must specify include or exclude",
        );
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step(
      "thought search: direct callers reject oversized queries before embedding",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        await assertRejects(
          () =>
            searchThoughtsByQuery(
              asPool(pool),
              {
                query: "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
                auth: AUTH,
              },
              deps,
            ),
          ValidationError,
          "query must be at most",
        );
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step(
      "thought fetch: direct callers reject malformed UUIDs before DB work",
      async () => {
        const pool = new FakePool(() => undefined);
        await assertRejects(
          () => fetchThoughtInScope(asPool(pool), "not-a-uuid", { auth: AUTH }),
          ValidationError,
          "id",
        );
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step("session search: embed failure → UpstreamError", async () => {
      const pool = new FakePool(() => undefined);
      const { deps, message } = makeEmbedDownDeps();
      await assertRejects(
        () =>
          searchSessionsByQuery(
            asPool(pool),
            { query: "x", auth: AUTH },
            deps,
          ),
        UpstreamError,
        message,
      );
    });

    await t.step(
      "session search: direct callers reject invalid queries before DB or embedding",
      async () => {
        const pool = new FakePool(() => undefined);
        const deps = makeDeps();
        const invalidQueries = [
          "",
          "   \t\n",
          "x".repeat(MAX_SEARCH_QUERY_BYTES + 1),
          "é".repeat(MAX_SEARCH_QUERY_BYTES / 2 + 1),
        ];

        for (const query of invalidQueries) {
          await assertRejects(
            () =>
              searchSessionsByQuery(
                asPool(pool),
                { query, auth: AUTH },
                deps,
              ),
            ValidationError,
            "query",
          );
        }
        assertEquals(deps.embedCalls, []);
        assertEquals(pool.connectCalls, 0);
      },
    );

    await t.step("session search: filters flow into SQL params", async () => {
      let captured: unknown[] = [];
      let capturedSql = "";
      let hnswDepth: unknown[] = [];
      const statements: string[] = [];
      const pool = new FakePool((sql, params) => {
        statements.push(sql.trim());
        if (sql.includes("hnsw.ef_search")) {
          hnswDepth = params;
        }
        if (sql.includes("FROM sessions.session")) {
          capturedSql = sql;
          captured = params;
          return {
            rows: Array.from(
              { length: 5 },
              (_, index) => sessionSearchRow(index + 1),
            ),
          };
        }
        return undefined;
      });
      await searchSessionsByQuery(
        asPool(pool),
        { query: "q", limit: 5, status: "active", tag: "ci", auth: AUTH },
        makeDeps(),
      );
      assertEquals(captured, [
        `[${FAKE_VECTOR.join(",")}]`,
        "active",
        "ci",
        5,
      ]);
      assertEquals(
        capturedSql.includes("1 - (embedding <=> $1::vector) >="),
        false,
      );
      assertEquals(hnswDepth, ["50"]);

      const begin = statements.indexOf("BEGIN");
      const audience = statements.findIndex((sql) =>
        sql.includes("openbrain.workspace_id")
      );
      const efSearch = statements.findIndex((sql) =>
        sql.includes("hnsw.ef_search")
      );
      const iterative = statements.indexOf(
        "SET LOCAL hnsw.iterative_scan = strict_order",
      );
      const query = statements.findIndex((sql) =>
        sql.includes("FROM sessions.session")
      );
      const commit = statements.lastIndexOf("COMMIT");
      assertEquals(
        0 <= begin && begin < audience && audience < efSearch &&
          efSearch < iterative && iterative < query && query < commit,
        true,
      );
    });

    await t.step(
      "session search: custom similarity threshold is validated and applied",
      async () => {
        let captured: unknown[] = [];
        let queryCount = 0;
        const pool = new FakePool((sql, params) => {
          if (sql.includes("FROM sessions.session")) {
            queryCount++;
            captured = params;
            return {
              rows: [
                sessionSearchRow(1, 0.91),
                sessionSearchRow(2, 0.73),
                sessionSearchRow(3, 0.72),
                sessionSearchRow(4, 0.4),
                sessionSearchRow(5, -0.1),
              ],
            };
          }
          return undefined;
        });
        const deps = makeDeps();
        const rows = await searchSessionsByQuery(
          asPool(pool),
          { query: "quality floor", threshold: 0.73, auth: AUTH },
          deps,
        );
        assertEquals(captured, [
          `[${FAKE_VECTOR.join(",")}]`,
          5,
        ]);
        assertEquals(rows.map((row) => row.id), [1, 2]);
        assertEquals(
          queryCount,
          1,
          "a filled ANN result must not fall back merely because the floor removes rows",
        );

        for (const threshold of [-0.01, 1.01, Number.NaN]) {
          const invalidPool = new FakePool(() => undefined);
          const invalidDeps = makeDeps();
          await assertRejects(
            () =>
              searchSessionsByQuery(
                asPool(invalidPool),
                { query: "quality floor", threshold, auth: AUTH },
                invalidDeps,
              ),
            ValidationError,
            "threshold",
          );
          assertEquals(invalidDeps.embedCalls, []);
          assertEquals(invalidPool.connectCalls, 0);
        }
      },
    );

    await t.step(
      "session search: ANN underfill retries through the exact materialized path",
      async () => {
        const statements: string[] = [];
        const pool = new FakePool((sql) => {
          const statement = sql.trim();
          statements.push(statement);
          if (statement.startsWith("WITH eligible AS MATERIALIZED")) {
            return {
              rows: Array.from(
                { length: 5 },
                (_, index) => sessionSearchRow(index + 1),
              ),
            };
          }
          if (statement.includes("FROM sessions.session")) {
            return { rows: [sessionSearchRow(1)] };
          }
          return undefined;
        });

        const rows = await searchSessionsByQuery(
          asPool(pool),
          { query: "selective", limit: 5, auth: AUTH },
          makeDeps(),
        );
        assertEquals(rows.length, 5);

        const approximate = statements.findIndex((sql) =>
          sql.startsWith("SELECT id, session_id") &&
          sql.includes("FROM sessions.session")
        );
        const fallback = statements.findIndex((sql) =>
          sql.startsWith("WITH eligible AS MATERIALIZED")
        );
        const commit = statements.lastIndexOf("COMMIT");
        assertEquals(
          0 <= approximate && approximate < fallback && fallback < commit,
          true,
        );
      },
    );

    await t.step(
      "session search: query failure rolls back transaction-local HNSW controls",
      async () => {
        const statements: string[] = [];
        const pool = new FakePool((sql) => {
          statements.push(sql.trim());
          return undefined;
        });

        await assertRejects(
          () =>
            searchSessionsByQuery(
              asPool(pool),
              { query: "rollback probe", auth: AUTH },
              makeDeps(),
            ),
          Error,
          "unscripted queryObject",
        );
        assertEquals(statements.includes("BEGIN"), true);
        assertEquals(
          statements.some((sql) => sql.includes("hnsw.ef_search")),
          true,
        );
        assertEquals(
          statements.includes("SET LOCAL hnsw.iterative_scan = strict_order"),
          true,
        );
        assertEquals(statements.includes("ROLLBACK"), true);
        assertEquals(statements.includes("COMMIT"), false);
      },
    );

    // ─── captureSessionFromToml ───────────────────────────────────────
    await t.step(
      "session capture (fresh): INSERT path, embeds, created + reembedded true",
      async () => {
        let insertParams: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("INSERT INTO sessions.session")) {
            insertParams = params;
            return { rows: [persistedSession("active")] };
          }
          return undefined;
        });
        const deps = makeDeps();
        const out = await captureSessionFromToml(
          asPool(pool),
          { tomlText: 'title = "smoke"\nstatus = "active"', auth: AUTH },
          deps,
        );
        assertEquals(out, {
          id: 7,
          session_id: null,
          status: "active",
          created: true,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
          reembedded: true,
        });
        assertEquals(deps.embedCalls.length, 1);
        // Provenance is server-stamped from the transport auth ($25/$26).
        assertEquals(insertParams[24], "tailnet");
        assertEquals(insertParams[25], null);
        // Fresh capture always embeds ($29 is the vector literal).
        assertEquals(insertParams[28], `[${FAKE_VECTOR.join(",")}]`);
      },
    );

    await t.step(
      "session capture (unknown id): NotFoundError BEFORE any embed is paid for",
      async () => {
        const pool = new FakePool((sql) => {
          if (sql.includes("SELECT content_hash")) return { rows: [] };
          return undefined;
        });
        const deps = makeDeps();
        await assertRejects(
          () =>
            captureSessionFromToml(
              asPool(pool),
              { tomlText: 'id = 42\ntitle = "stale"', auth: AUTH },
              deps,
            ),
          NotFoundError,
          "No session found for id 42.",
        );
        assertEquals(deps.embedCalls.length, 0, "embed must not be called");
      },
    );

    await t.step(
      "session lifecycle status survives recapture when status is omitted",
      async () => {
        let storedStatus = "active";
        let storedContentHash: string | null = null;
        // SQL placeholders are 1-based: $17 = status; $28 = content_hash.
        const pool = new FakePool((sql, params) => {
          if (sql.includes("SELECT content_hash")) {
            return { rows: [{ content_hash: storedContentHash }] };
          }
          if (sql.includes("INSERT INTO sessions.session")) {
            assertEquals(params[16], "active");
            storedStatus = params[16] as string;
            storedContentHash = params[27] as string;
            return {
              rows: [persistedSession(storedStatus)],
            };
          }
          if (sql.includes("SET status = $2::sessions.session_status")) {
            storedStatus = params[1] as string;
            return { rows: [{ id: 7n, status: storedStatus }] };
          }
          if (sql.includes("UPDATE sessions.session SET")) {
            assertEquals(
              sql.includes(
                "status = COALESCE($17::sessions.session_status, sessions.session.status)",
              ),
              true,
            );
            assertEquals(params[16], null, "omitted status must remain null");
            storedContentHash = params[27] as string;
            return {
              rows: [persistedSession(storedStatus)],
            };
          }
          return undefined;
        });
        const deps = makeDeps();

        const created = await captureSessionFromToml(
          asPool(pool),
          {
            tomlText: 'title = "lifecycle"\nstatus = "active"',
            auth: AUTH,
          },
          deps,
        );
        assertEquals(created.status, "active");

        assertEquals(
          await updateSessionStatusInScope(
            asPool(pool),
            created.id,
            "done",
            { auth: AUTH },
          ),
          { id: 7, status: "done" },
        );

        const recaptured = await captureSessionFromToml(
          asPool(pool),
          {
            tomlText: 'id = 7\ntitle = "lifecycle"',
            auth: AUTH,
          },
          deps,
        );
        assertEquals(recaptured.status, "done");
        assertEquals(recaptured.reembedded, false);
        assertEquals(deps.embedCalls.length, 1);
      },
    );

    await t.step(
      "session capture (unchanged hash): skips embed, passes null embedding, reembedded false",
      async () => {
        const toml = 'id = 7\ntitle = "same"\nsummary = "unchanged"';
        const { session } = parseSessionToml(toml);
        const hash = await computeContentHash(session);
        let updateParams: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("SELECT content_hash")) {
            return { rows: [{ content_hash: hash }] };
          }
          if (sql.includes("UPDATE sessions.session SET")) {
            updateParams = params;
            return { rows: [persistedSession("done", "h-1")] };
          }
          return undefined;
        });
        const deps = makeDeps();
        const out = await captureSessionFromToml(
          asPool(pool),
          { tomlText: toml, auth: AUTH },
          deps,
        );
        assertEquals(out.reembedded, false);
        assertEquals(out.created, false);
        assertEquals(out.id, 7);
        assertEquals(
          deps.embedCalls.length,
          0,
          "unchanged hash must not embed",
        );
        // $29 null => COALESCE keeps the stored embedding; $34 is the key.
        assertEquals(updateParams[28], null);
        assertEquals(updateParams[33], 7);
      },
    );

    await t.step(
      "session capture (changed hash): re-embeds and reembedded true",
      async () => {
        const pool = new FakePool((sql) => {
          if (sql.includes("SELECT content_hash")) {
            return { rows: [{ content_hash: "something-else" }] };
          }
          if (sql.includes("UPDATE sessions.session SET")) {
            return { rows: [persistedSession("active")] };
          }
          return undefined;
        });
        const deps = makeDeps();
        const out = await captureSessionFromToml(
          asPool(pool),
          { tomlText: 'id = 7\ntitle = "edited"', auth: AUTH },
          deps,
        );
        assertEquals(out.reembedded, true);
        assertEquals(deps.embedCalls.length, 1);
      },
    );

    await t.step("session capture: bad TOML → ValidationError", async () => {
      const pool = new FakePool(() => undefined);
      const deps = makeDeps();
      await assertRejects(
        () =>
          captureSessionFromToml(
            asPool(pool),
            { tomlText: 'status = "active"', auth: AUTH },
            deps,
          ),
        ValidationError,
        "missing required field 'title'",
      );
      assertEquals(deps.embedCalls.length, 0);
      assertEquals(pool.connectCalls, 0);
    });

    await t.step(
      "session capture: invalid field types fail before embedding or DB work",
      async () => {
        const invalidDocs = [
          "title = 7",
          'title = "typed"\ntags = "not-an-array"',
          'title = "typed"\ntags = ["ok", 7]',
          'title = "typed"\nartifacts = "not-an-array"',
          'title = "typed"\nartifacts = [{ kind = 7, title = "x" }]',
        ];
        for (const tomlText of invalidDocs) {
          const pool = new FakePool(() => undefined);
          const deps = makeDeps();
          await assertRejects(
            () =>
              captureSessionFromToml(
                asPool(pool),
                { tomlText, auth: AUTH },
                deps,
              ),
            ValidationError,
          );
          assertEquals(deps.embedCalls, []);
          assertEquals(pool.connectCalls, 0);
        }
      },
    );

    await t.step(
      "session dates and list bounds fail before embedding or DB casts",
      async () => {
        const capturePool = new FakePool(() => undefined);
        const captureDeps = makeDeps();
        await assertRejects(
          () =>
            captureSessionFromToml(
              asPool(capturePool),
              {
                tomlText: 'title = "bad date"\nlast_update = 2026-02-30',
                auth: AUTH,
              },
              captureDeps,
            ),
          ValidationError,
          "last_update",
        );
        assertEquals(captureDeps.embedCalls, []);
        assertEquals(capturePool.connectCalls, 0);

        for (
          const [field, value] of [
            ["since", "not-a-date"],
            ["until", "2026-07-29T10:00:00"],
          ] as const
        ) {
          const invalidPool = new FakePool(() => undefined);
          await assertRejects(
            () =>
              listSessionsInScope(asPool(invalidPool), {
                [field]: value,
                auth: AUTH,
              }),
            ValidationError,
            field,
          );
          assertEquals(invalidPool.connectCalls, 0);
        }

        let listParams: unknown[] = [];
        const listPool = new FakePool((sql, params) => {
          if (sql.includes("SELECT id, session_id, title")) {
            listParams = params;
            return { rows: [] };
          }
          return undefined;
        });
        await listSessionsInScope(asPool(listPool), {
          since: "2026-07-29",
          until: "2026-07-30T12:00:00-04:00",
          auth: AUTH,
        });
        assertEquals(listParams, [
          "2026-07-29T00:00:00.000Z",
          "2026-07-30T12:00:00-04:00",
          50,
        ]);
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
