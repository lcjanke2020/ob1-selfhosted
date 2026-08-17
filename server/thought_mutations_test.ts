// Hermetic tests for the thought mutation surface: update_thought /
// move_thought through services.ts and the MCP transport. FakePool scripts the
// SQL the query layer emits (api_test_support.ts); injected deps replace the
// embedder + classifier; env is snapshot/restored around dynamic imports (the
// same pattern as services_test.ts / mcp_schema_test.ts). The database-side
// guarantees (forced RLS on thought_revisions, the SECURITY DEFINER move
// helper's source/target checks, fingerprint conflicts under a real unique
// index) are proven by db/thought-mutations-smoke.sql in CI.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  asPool,
  FAKE_VECTOR,
  FakePool,
  makeDeps,
  makeEmbedDownDeps,
  type QueryHandler,
} from "./api_test_support.ts";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "METADATA_FALLBACK_POLICY",
];

const THOUGHT_ID = "6f6c0d3a-9a0b-4e3e-8f4a-2d1c5b7e9a01";
const OTHER_ID = "0b3d2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OAUTH_AUTH = {
  door: "funnel" as const,
  sub: "auth0|alice",
  tokenLabel: null,
};
const STATIC_AUTH = { door: "tailnet" as const, sub: null, tokenLabel: null };

// The head row as the FOR UPDATE select returns it, plus the fingerprint the
// SQL computes for the incoming content.
function headRow(overrides: Record<string, unknown> = {}) {
  return {
    id: THOUGHT_ID,
    content: "Aristotle runs mismatched Corsair kits",
    metadata: {
      type: "observation",
      topics: ["hardware"],
      source: "mcp",
      door: "funnel",
      sub: "auth0|alice",
      token_label: null,
      provenance: {
        schema_version: 1,
        caller_asserted: { author: "leonard" },
      },
      metadata_extraction: { schema_version: 1, endpoint: "stub" },
    },
    workspace_id: "default",
    project_id: null,
    visibility: "workspace",
    owner_subject: null,
    content_fingerprint: "old-fp",
    new_fingerprint: "new-fp",
    ...overrides,
  };
}

// Scripts the happy-path update: visible head, no collision, revision insert
// returns 1, UPDATE returns the merged row. Records every statement so tests
// can assert ordering and bound parameters.
function updateScript(opts: {
  visible?: boolean;
  colliding?: string | null;
  currentContent?: string;
} = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const handler: QueryHandler = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("FROM thoughts WHERE id = $1 LIMIT 1")) {
      // services' pre-embed visibility check (fetchThought).
      return opts.visible === false ? { rows: [] } : {
        rows: [{
          id: THOUGHT_ID,
          content: opts.currentContent ?? headRow().content,
          metadata: headRow().metadata,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
          created_at: "2026-08-10T00:00:00Z",
          updated_at: null,
        }],
      };
    }
    if (sql.includes("FOR UPDATE")) {
      return opts.visible === false ? { rows: [] } : {
        rows: [
          headRow(
            opts.currentContent ? { content: opts.currentContent } : {},
          ),
        ],
      };
    }
    if (sql.includes("count(*)::int AS revision")) {
      return { rows: [{ revision: 2 }] };
    }
    if (sql.includes("FROM thoughts WHERE id = $1") && !sql.includes("FOR")) {
      return {
        rows: [{
          id: THOUGHT_ID,
          content: opts.currentContent ?? headRow().content,
          metadata: headRow().metadata,
          workspace_id: "default",
          project_id: null,
          visibility: "workspace",
          created_at: "2026-08-10T00:00:00Z",
          updated_at: "2026-08-10T00:00:00Z",
        }],
      };
    }
    if (sql.includes("SELECT id FROM thoughts") && sql.includes("id <> $6")) {
      return { rows: opts.colliding ? [{ id: opts.colliding }] : [] };
    }
    if (sql.includes("INSERT INTO thought_revisions")) {
      return { rows: [{ revision: 1 }] };
    }
    if (sql.includes("UPDATE thoughts")) {
      const fresh = JSON.parse(params[3] as string);
      return {
        rows: [{
          id: THOUGHT_ID,
          content: params[1],
          // Mirror the SQL merge: fresh keys, then the preserved capture keys
          // from the current row win.
          metadata: {
            ...fresh,
            source: "mcp",
            door: "funnel",
            sub: "auth0|alice",
            token_label: null,
            provenance: headRow().metadata.provenance,
          },
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
  return { calls, handler };
}

function moveScript(
  outcome:
    | { outcome: "moved" | "unchanged" | "conflict"; conflict?: string }
    | null,
  registry: Record<string, unknown> = {},
) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const handler: QueryHandler = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("FROM memory_scope.workspace AS w")) {
      return {
        rows: [{
          default_visibility: "workspace",
          personal_only: false,
          project_exists: true,
          ...registry,
        }],
      };
    }
    if (sql.includes("memory_scope.move_thought(")) {
      if (!outcome) return { rows: [] };
      return {
        rows: [{
          outcome: outcome.outcome,
          conflict_thought_id: outcome.conflict ?? null,
          revision: outcome.outcome === "moved" ? 1 : null,
          workspace_id: params[1],
          project_id: params[2],
          visibility: params[3],
        }],
      };
    }
    return undefined;
  };
  return { calls, handler };
}

Deno.test("thought mutations (services + MCP)", async (t) => {
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");
  Deno.env.delete("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
  Deno.env.delete("MCP_ACCESS_KEY_PRINCIPAL");
  Deno.env.set("METADATA_FALLBACK_POLICY", "off");

  const {
    ConflictError,
    moveThoughtInScope,
    updateThoughtInScope,
    UpstreamError,
    ValidationError,
  } = await import("./services.ts");
  const { createMcpServer } = await import("./mcp-server.ts");
  // queries.ts transitively reads env at module load, so import it after the
  // env snapshot like the other modules.
  const { PRESERVED_METADATA_KEYS_ON_UPDATE } = await import("./queries.ts");

  try {
    // ─── update_thought (services) ────────────────────────────────────
    await t.step(
      "update: re-embeds, re-classifies, snapshots prior state, preserves capture stamps",
      async () => {
        const { calls, handler } = updateScript();
        const deps = makeDeps();
        const out = await updateThoughtInScope(
          asPool(new FakePool(handler)),
          {
            id: THOUGHT_ID,
            content: "Aristotle runs 4x G.Skill Trident Z5 48GB",
            auth: OAUTH_AUTH,
          },
          deps,
        );
        assert(out);
        assertEquals(out.outcome, "updated");
        assertEquals(out.revision, 1);
        assertEquals(out.id, THOUGHT_ID);
        // Fresh extraction ran on the NEW content only.
        assertEquals(deps.embedCalls, [
          "Aristotle runs 4x G.Skill Trident Z5 48GB",
        ]);
        assertEquals(deps.extractCalls, [
          "Aristotle runs 4x G.Skill Trident Z5 48GB",
        ]);

        // Statement order: visibility pre-check → locked head read →
        // collision probe → revision snapshot → head rewrite.
        const sqls = calls.map((c) => c.sql);
        const lockAt = sqls.findIndex((s) => s.includes("FOR UPDATE"));
        const probeAt = sqls.findIndex((s) => s.includes("id <> $6"));
        const revisionAt = sqls.findIndex((s) =>
          s.includes("INSERT INTO thought_revisions")
        );
        const updateAt = sqls.findIndex((s) => s.includes("UPDATE thoughts"));
        assert(lockAt >= 0 && probeAt > lockAt && revisionAt > probeAt);
        assert(updateAt > revisionAt, "revision must be written before head");

        // The locked read computes the new fingerprint from the SAME
        // expression capture uses and binds the incoming content.
        assert(sqls[lockAt].includes("regexp_replace($2"));
        assertEquals(calls[lockAt].params, [
          THOUGHT_ID,
          "Aristotle runs 4x G.Skill Trident Z5 48GB",
        ]);

        // The collision probe targets the head's exact audience and its own id.
        assertEquals(calls[probeAt].params, [
          "new-fp",
          "default",
          null,
          "workspace",
          null,
          THOUGHT_ID,
        ]);

        // The revision row snapshots the PRIOR state and the verified actor.
        const revisionParams = calls[revisionAt].params;
        assertEquals(revisionParams[0], THOUGHT_ID);
        assertEquals(
          revisionParams[1],
          "Aristotle runs mismatched Corsair kits",
        );
        assertEquals(JSON.parse(revisionParams[2] as string).topics, [
          "hardware",
        ]);
        assertEquals(revisionParams.slice(3, 7), [
          "default",
          null,
          "workspace",
          null,
        ]);
        assertEquals(revisionParams.slice(7), ["auth0|alice", "funnel", null]);
        assert(sqls[revisionAt].includes("'content'"));

        // The head rewrite binds the vector, fresh classifier output WITHOUT
        // any reserved stamp, and the preserved-key list for the SQL merge.
        const updateParams = calls[updateAt].params;
        assertEquals(updateParams[0], THOUGHT_ID);
        assertEquals(
          updateParams[1],
          "Aristotle runs 4x G.Skill Trident Z5 48GB",
        );
        assertEquals(updateParams[2], `[${FAKE_VECTOR.join(",")}]`);
        const fresh = JSON.parse(updateParams[3] as string);
        assertEquals(fresh.type, "observation");
        assertEquals(fresh.topics, ["testing"]);
        assertEquals(fresh.metadata_extraction.model, "test-local-model");
        for (const key of PRESERVED_METADATA_KEYS_ON_UPDATE) {
          assertEquals(
            key in fresh,
            false,
            `${key} must not be supplied by the fresh extraction`,
          );
        }
        assertEquals(updateParams[4], [...PRESERVED_METADATA_KEYS_ON_UPDATE]);
        assert(sqls[updateAt].includes("regexp_replace($2"));

        // Returned metadata reflects the merge: fresh classifier + kept stamps.
        assertEquals(out.metadata.topics, ["testing"]);
        assertEquals(out.metadata.sub, "auth0|alice");
        assertEquals(
          (out.metadata.provenance as { caller_asserted: unknown })
            .caller_asserted,
          { author: "leonard" },
        );
      },
    );

    await t.step(
      "update: fresh extraction cannot smuggle reserved stamps",
      async () => {
        const { calls, handler } = updateScript();
        const deps = makeDeps({
          extractMetadata: () =>
            Promise.resolve({
              metadata: {
                type: "idea",
                sub: "auth0|mallory",
                door: "tailnet",
                provenance: { forged: true },
              },
              classifier: {
                schema_version: 1 as const,
                endpoint: "stub" as const,
              },
              degradation_events: [],
            }),
        });
        await updateThoughtInScope(
          asPool(new FakePool(handler)),
          { id: THOUGHT_ID, content: "corrected", auth: OAUTH_AUTH },
          deps,
        );
        const update = calls.find((c) => c.sql.includes("UPDATE thoughts"))!;
        const fresh = JSON.parse(update.params[3] as string);
        assertEquals(fresh, {
          type: "idea",
          metadata_extraction: { schema_version: 1, endpoint: "stub" },
        });
      },
    );

    await t.step(
      "update: invisible or unknown id → null before any embedding work",
      async () => {
        const { calls, handler } = updateScript({ visible: false });
        const deps = makeDeps();
        const out = await updateThoughtInScope(
          asPool(new FakePool(handler)),
          { id: THOUGHT_ID, content: "corrected", auth: OAUTH_AUTH },
          deps,
        );
        assertEquals(out, null);
        assertEquals(deps.embedCalls, []);
        assertEquals(deps.extractCalls, []);
        assertEquals(
          calls.some((c) => c.sql.includes("UPDATE thoughts")),
          false,
        );
      },
    );

    await t.step(
      "update: identical content is a no-op — no embed, no classify, no writes",
      async () => {
        const { calls, handler } = updateScript({
          currentContent: "already correct",
        });
        const deps = makeDeps();
        const out = await updateThoughtInScope(
          asPool(new FakePool(handler)),
          { id: THOUGHT_ID, content: "already correct", auth: OAUTH_AUTH },
          deps,
        );
        assert(out);
        assertEquals(out.outcome, "unchanged");
        assertEquals(out.revision, 2);
        assertEquals(deps.embedCalls, []);
        assertEquals(deps.extractCalls, []);
        assertEquals(
          calls.some((c) =>
            c.sql.includes("FOR UPDATE") ||
            c.sql.includes("UPDATE thoughts") ||
            c.sql.includes("INSERT INTO thought_revisions")
          ),
          false,
        );
      },
    );

    await t.step(
      "update: same-audience fingerprint collision → ConflictError naming the row, nothing written",
      async () => {
        const { calls, handler } = updateScript({ colliding: OTHER_ID });
        const err = await assertRejects(
          () =>
            updateThoughtInScope(
              asPool(new FakePool(handler)),
              { id: THOUGHT_ID, content: "duplicate text", auth: OAUTH_AUTH },
              makeDeps(),
            ),
          ConflictError,
        );
        assert(err.message.includes(OTHER_ID));
        assertEquals(
          calls.some((c) =>
            c.sql.includes("UPDATE thoughts") ||
            c.sql.includes("INSERT INTO thought_revisions")
          ),
          false,
        );
      },
    );

    await t.step(
      "update: a collision that lands at write time is rolled back to the savepoint and reported as the same ConflictError",
      async () => {
        // The pre-check sees nothing; the head rewrite then fails on the
        // fingerprint index (a competitor committed in between). The savepoint
        // is rolled back, the probe re-run, and the now-visible row named.
        let probes = 0;
        const base = updateScript();
        const calls = base.calls;
        const handler: QueryHandler = (sql, params) => {
          if (sql.includes("id <> $6")) {
            calls.push({ sql, params });
            probes += 1;
            return { rows: probes === 1 ? [] : [{ id: OTHER_ID }] };
          }
          if (sql.includes("UPDATE thoughts")) {
            calls.push({ sql, params });
            throw Object.assign(new Error("duplicate key value"), {
              fields: { code: "23505" },
            });
          }
          return base.handler(sql, params);
        };
        const err = await assertRejects(
          () =>
            updateThoughtInScope(
              asPool(new FakePool(handler)),
              { id: THOUGHT_ID, content: "raced text", auth: OAUTH_AUTH },
              makeDeps(),
            ),
          ConflictError,
        );
        assert(err.message.includes(OTHER_ID), err.message);
        const sqls = calls.map((c) => c.sql);
        const savepointAt = sqls.findIndex((q) =>
          q.startsWith("SAVEPOINT thought_mutation")
        );
        const updateAt = sqls.findIndex((q) => q.includes("UPDATE thoughts"));
        const rollbackAt = sqls.findIndex((q) =>
          q.startsWith("ROLLBACK TO SAVEPOINT thought_mutation")
        );
        assert(savepointAt >= 0 && savepointAt < updateAt);
        assert(rollbackAt > updateAt, "must roll back to the savepoint");
        assertEquals(probes, 2, "must re-probe after the rollback");
        assertEquals(
          sqls.some((q) => q.startsWith("RELEASE SAVEPOINT")),
          false,
        );
      },
    );

    await t.step(
      "update: a non-collision write failure propagates unchanged",
      async () => {
        const base = updateScript();
        const handler: QueryHandler = (sql, params) => {
          if (sql.includes("UPDATE thoughts")) {
            throw Object.assign(new Error("deadlock detected"), {
              fields: { code: "40P01" },
            });
          }
          return base.handler(sql, params);
        };
        await assertRejects(
          () =>
            updateThoughtInScope(
              asPool(new FakePool(handler)),
              { id: THOUGHT_ID, content: "raced text", auth: OAUTH_AUTH },
              makeDeps(),
            ),
          Error,
          "deadlock detected",
        );
      },
    );

    await t.step(
      "update: static key without a configured principal records a null subject",
      async () => {
        const { calls, handler } = updateScript();
        await updateThoughtInScope(
          asPool(new FakePool(handler)),
          { id: THOUGHT_ID, content: "corrected", auth: STATIC_AUTH },
          makeDeps(),
        );
        const revision = calls.find((c) =>
          c.sql.includes("INSERT INTO thought_revisions")
        )!;
        assertEquals(revision.params.slice(7), [null, "tailnet", null]);
      },
    );

    await t.step("update: embed backend down → UpstreamError", async () => {
      const { handler } = updateScript();
      const { deps } = makeEmbedDownDeps();
      await assertRejects(
        () =>
          updateThoughtInScope(
            asPool(new FakePool(handler)),
            { id: THOUGHT_ID, content: "corrected", auth: OAUTH_AUTH },
            deps,
          ),
        UpstreamError,
      );
    });

    await t.step(
      "update: malformed id and empty content fail validation before DB work",
      async () => {
        const { calls, handler } = updateScript();
        await assertRejects(
          () =>
            updateThoughtInScope(
              asPool(new FakePool(handler)),
              { id: "not-a-uuid", content: "x", auth: OAUTH_AUTH },
              makeDeps(),
            ),
          ValidationError,
        );
        await assertRejects(
          () =>
            updateThoughtInScope(
              asPool(new FakePool(handler)),
              { id: THOUGHT_ID, content: "", auth: OAUTH_AUTH },
              makeDeps(),
            ),
          ValidationError,
        );
        assertEquals(calls.length, 0);
      },
    );

    // ─── move_thought (services) ──────────────────────────────────────
    await t.step(
      "move: installs the CURRENT scope, resolves the target fail-closed, and passes no subject argument",
      async () => {
        const { calls, handler } = moveScript({ outcome: "moved" });
        const out = await moveThoughtInScope(asPool(new FakePool(handler)), {
          id: THOUGHT_ID,
          target: { workspace_id: "sensitive", visibility: "personal" },
          auth: OAUTH_AUTH,
        });
        assert(out);
        assertEquals(out.outcome, "moved");
        assertEquals(out.revision, 1);
        assertEquals(out.workspace_id, "sensitive");
        assertEquals(out.visibility, "personal");

        // Transaction-local settings carry the CURRENT (read) audience: the
        // default workspace's union for an OAuth principal.
        const settings = calls.find((c) =>
          c.sql.includes("set_config('openbrain.workspace_id'")
        )!;
        assertEquals(settings.params, [
          "default",
          "",
          "auth0|alice",
          "personal,workspace",
        ]);
        const move = calls.find((c) =>
          c.sql.includes("memory_scope.move_thought(")
        )!;
        // id, target ws, target project, target visibility, door, token label
        // — and NOTHING that could name an owner.
        assertEquals(move.params, [
          THOUGHT_ID,
          "sensitive",
          null,
          "personal",
          "funnel",
          null,
        ]);
      },
    );

    await t.step(
      "move: personal target without a principal fails before touching the row",
      async () => {
        const { calls, handler } = moveScript({ outcome: "moved" });
        await assertRejects(
          () =>
            moveThoughtInScope(asPool(new FakePool(handler)), {
              id: THOUGHT_ID,
              target: { workspace_id: "default", visibility: "personal" },
              auth: STATIC_AUTH,
            }),
          ValidationError,
          "personal visibility requires",
        );
        assertEquals(
          calls.some((c) => c.sql.includes("move_thought(")),
          false,
        );
      },
    );

    await t.step(
      "move: personal-only workspace rejects a broader target",
      async () => {
        const { calls, handler } = moveScript({ outcome: "moved" }, {
          personal_only: true,
          default_visibility: "personal",
        });
        await assertRejects(
          () =>
            moveThoughtInScope(asPool(new FakePool(handler)), {
              id: THOUGHT_ID,
              target: { workspace_id: "sensitive", visibility: "workspace" },
              auth: OAUTH_AUTH,
            }),
          ValidationError,
          "personal-only",
        );
        assertEquals(
          calls.some((c) => c.sql.includes("move_thought(")),
          false,
        );
      },
    );

    await t.step(
      "move: target shape is explicit — project visibility needs project_id, others forbid it",
      async () => {
        const { calls, handler } = moveScript({ outcome: "moved" });
        await assertRejects(
          () =>
            moveThoughtInScope(asPool(new FakePool(handler)), {
              id: THOUGHT_ID,
              target: { workspace_id: "default", visibility: "project" },
              auth: OAUTH_AUTH,
            }),
          ValidationError,
          "project visibility requires project_id",
        );
        await assertRejects(
          () =>
            moveThoughtInScope(asPool(new FakePool(handler)), {
              id: THOUGHT_ID,
              target: {
                workspace_id: "default",
                project_id: "alpha",
                visibility: "workspace",
              },
              auth: OAUTH_AUTH,
            }),
          ValidationError,
          "workspace visibility stores no project_id",
        );
        assertEquals(calls.length, 0);
      },
    );

    await t.step(
      "move: invisible id → null; conflict → ConflictError naming the row; unchanged passes through",
      async () => {
        assertEquals(
          await moveThoughtInScope(
            asPool(new FakePool(moveScript(null).handler)),
            {
              id: THOUGHT_ID,
              target: { workspace_id: "default", visibility: "workspace" },
              auth: OAUTH_AUTH,
            },
          ),
          null,
        );
        const err = await assertRejects(
          () =>
            moveThoughtInScope(
              asPool(
                new FakePool(
                  moveScript({ outcome: "conflict", conflict: OTHER_ID })
                    .handler,
                ),
              ),
              {
                id: THOUGHT_ID,
                target: { workspace_id: "default", visibility: "personal" },
                auth: OAUTH_AUTH,
              },
            ),
          ConflictError,
        );
        assert(err.message.includes(OTHER_ID));
        const unchanged = await moveThoughtInScope(
          asPool(new FakePool(moveScript({ outcome: "unchanged" }).handler)),
          {
            id: THOUGHT_ID,
            target: { workspace_id: "default", visibility: "workspace" },
            auth: OAUTH_AUTH,
          },
        );
        assertEquals(unchanged?.outcome, "unchanged");
      },
    );

    // ─── MCP transport ────────────────────────────────────────────────
    await t.step(
      "MCP publishes both tools with explicit contracts and executes them",
      async () => {
        const update = updateScript();
        const move = moveScript({ outcome: "moved" });
        const pool = new FakePool((sql, params) =>
          sql.includes("move_thought(") ||
            sql.includes("FROM memory_scope.workspace AS w")
            ? move.handler(sql, params)
            : update.handler(sql, params)
        );
        const server = createMcpServer(asPool(pool), OAUTH_AUTH, makeDeps());
        const client = new Client({ name: "mutation-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport
          .createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const listed = await client.listTools();

          const updateTool = listed.tools.find((tool) =>
            tool.name === "update_thought"
          );
          assert(updateTool, "update_thought must be published");
          assertEquals(updateTool.inputSchema.required, ["id", "content"]);
          assertEquals(updateTool.annotations?.readOnlyHint, false);
          assertEquals(updateTool.annotations?.destructiveHint, true);
          assertEquals(updateTool.annotations?.idempotentHint, true);
          assert(updateTool.description?.includes("FULL replacement"));

          const moveTool = listed.tools.find((tool) =>
            tool.name === "move_thought"
          );
          assert(moveTool, "move_thought must be published");
          assertEquals(moveTool.inputSchema.required, ["id", "target"]);
          const target = (moveTool.inputSchema.properties as Record<
            string,
            Record<string, unknown>
          >).target;
          assertEquals(target.required, ["workspace_id", "visibility"]);
          assertEquals(target.additionalProperties, false);
          assertEquals(moveTool.annotations?.destructiveHint, false);
          assertEquals(moveTool.annotations?.idempotentHint, true);
          assert(moveTool.description?.includes("YOUR verified principal"));

          const updated = await client.callTool({
            name: "update_thought",
            arguments: { id: THOUGHT_ID, content: "corrected content" },
          });
          const updatedText = (updated.content as { text: string }[])[0].text;
          assertEquals(updated.isError ?? false, false, updatedText);
          const updatedBody = JSON.parse(updatedText);
          assertEquals(updatedBody.outcome, "updated");
          assertEquals(updatedBody.revision, 1);
          assertEquals(updatedBody.topics, ["testing"]);

          const moved = await client.callTool({
            name: "move_thought",
            arguments: {
              id: THOUGHT_ID,
              target: { workspace_id: "sensitive", visibility: "personal" },
            },
          });
          const movedText = (moved.content as { text: string }[])[0].text;
          assertEquals(moved.isError ?? false, false, movedText);
          assertEquals(JSON.parse(movedText), {
            id: THOUGHT_ID,
            outcome: "moved",
            revision: 1,
            workspace_id: "sensitive",
            project_id: null,
            visibility: "personal",
          });

          // A defaulted or misspelled target is rejected at the envelope.
          const rejected = await client.callTool({
            name: "move_thought",
            arguments: {
              id: THOUGHT_ID,
              target: { workspace_id: "sensitive" },
            },
          });
          assertEquals(rejected.isError, true);
        } finally {
          await client.close();
          await server.close();
        }
      },
    );
  } finally {
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
