// Tests for the shared orchestration layer (services.ts) used by
// both the MCP tools and the REST gateway. Hermetic: FakePool scripts the SQL
// surface (api_test_support.ts), injected deps replace the Ollama embed +
// metadata extractor, and env is snapshot/restored around a dynamic import
// (services.ts transitively imports config.ts, which validates env at module
// load — same pattern as auth_brainkey_test.ts).

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  asPool,
  FAKE_VECTOR,
  FakePool,
  makeDeps,
  makeEmbedDownDeps,
} from "./api_test_support.ts";
import { computeContentHash, parseSessionToml } from "./session_toml.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
];

const AUTH = { door: "tailnet" as const, sub: null };

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

  const {
    captureSessionFromToml,
    captureThoughtWithMetadata,
    NotFoundError,
    searchSessionsByQuery,
    searchThoughtsByQuery,
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
          if (sql.includes("FROM thoughts")) {
            captured = params;
            return {
              rows: [{
                id: "uuid-1",
                content: "hit",
                metadata: {},
                created_at: "2026-07-24T00:00:00Z",
                similarity: 0.9,
              }],
            };
          }
          return undefined;
        });
        const deps = makeDeps();
        const rows = await searchThoughtsByQuery(
          asPool(pool),
          { query: "find me", limit: 3, threshold: 0.7 },
          deps,
        );
        assertEquals(rows.length, 1);
        assertEquals(deps.embedCalls, ["find me"]);
        assertEquals(captured, [`[${FAKE_VECTOR.join(",")}]`, 0.7, 3]);
      },
    );

    await t.step("session search: embed failure → UpstreamError", async () => {
      const pool = new FakePool(() => undefined);
      const { deps, message } = makeEmbedDownDeps();
      await assertRejects(
        () => searchSessionsByQuery(asPool(pool), { query: "x" }, deps),
        UpstreamError,
        message,
      );
    });

    await t.step("session search: filters flow into SQL params", async () => {
      let captured: unknown[] = [];
      const pool = new FakePool((sql, params) => {
        if (sql.includes("FROM sessions.session")) {
          captured = params;
          return { rows: [] };
        }
        return undefined;
      });
      await searchSessionsByQuery(
        asPool(pool),
        { query: "q", limit: 2, status: "active", tag: "ci" },
        makeDeps(),
      );
      assertEquals(captured, [
        `[${FAKE_VECTOR.join(",")}]`,
        "active",
        "ci",
        2,
      ]);
    });

    // ─── captureSessionFromToml ───────────────────────────────────────
    await t.step(
      "session capture (fresh): INSERT path, embeds, created + reembedded true",
      async () => {
        let insertParams: unknown[] = [];
        const pool = new FakePool((sql, params) => {
          if (sql.includes("INSERT INTO sessions.session")) {
            insertParams = params;
            return { rows: [{ id: 7n, session_id: null, status: "active" }] };
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
            return { rows: [{ id: 7n, session_id: "h-1", status: "done" }] };
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
        // $29 null => COALESCE keeps the stored embedding; $30 is the key.
        assertEquals(updateParams[28], null);
        assertEquals(updateParams[29], 7);
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
            return { rows: [{ id: 7n, session_id: null, status: "active" }] };
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
    });
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
