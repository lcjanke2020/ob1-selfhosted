// Runs only in the disposable corpus CI fixture. Exercises real production
// services/queries as openbrain_app; vectors are deterministic test data, so
// these are correctness assertions, never claims about model recall quality.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
const hostname = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
assertEquals(hostname, "127.0.0.1");
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const password = Deno.env.get("OPENBRAIN_APP_PASSWORD")!;
Deno.env.set("DB_PASSWORD", password);
Deno.env.set("MCP_ACCESS_KEY", "embedding-ci-only-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");
const services = await import("./services.ts");
const { upsertSession } = await import("./session_queries.ts");
const { parseSessionToml, computeContentHash } = await import(
  "./session_toml.ts"
);
const { buildEmbeddingIndex, sourceHash } = await import(
  "./embedding_index.ts"
);
const adminPool = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "postgres",
  password: Deno.env.get("POSTGRES_PASSWORD"),
}, 1);
const app = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "openbrain_app",
  password,
}, 3);
const admin = await adminPool.connect();
const contract = "a".repeat(64);
const vector = (n: number) =>
  Array.from({ length: 768 }, (_, i) => i === n ? 1 : 0);
const deps = {
  contract: () => Promise.resolve(contract),
  embed: (text: string) =>
    Promise.resolve(
      vector(
        text.includes("tangerine") || text === "semantic-tail"
          ? 1
          : text.includes("lexical-probe")
          ? 2
          : 0,
      ),
    ),
  extractMetadata: () =>
    Promise.resolve({
      metadata: {},
      classifier: { schema_version: 1 as const, endpoint: "stub" as const },
      degradation_events: [],
    }),
};
const workspace = "embedding-smoke";
const scope = { workspace_id: workspace, visibility: "workspace" as const };
const auth = {
  door: "funnel" as const,
  sub: "embedding-owner-a",
  tokenLabel: null,
};
const other = { ...auth, sub: "embedding-owner-b" };
const readScope = {
  workspaceId: workspace,
  projectId: null,
  principal: auth.sub,
  visibilities: ["workspace" as const],
  visibility: "workspace" as const,
  ownerSubject: null,
};
const getSnapshot = async (id: number) => {
  const r = await admin.queryObject<{ snapshot: unknown }>(
    `SELECT jsonb_build_object('record', to_jsonb(s), 'index', to_jsonb(i), 'artifacts',
      (SELECT jsonb_agg(a ORDER BY position) FROM sessions.artifact a WHERE session_pk=s.id)) AS snapshot
     FROM sessions.session s LEFT JOIN sessions.embedding_index i ON i.session_id=s.id WHERE s.id=$1`,
    [id],
  );
  return r.rows[0].snapshot;
};
try {
  await admin.queryArray(
    "INSERT INTO memory_scope.workspace(id,default_visibility,personal_only) VALUES ($1,'workspace',false) ON CONFLICT DO NOTHING",
    [workspace],
  );
  const { backfillEmbeddingIndex } = await import("./embedding_backfill.ts");
  const generationBefore = await admin.queryObject(
    "SELECT * FROM memory_scope.embedding_generation",
  );
  let backfillCalls = 0;
  const backfillDeps = {
    ...deps,
    embed: (text: string) => {
      backfillCalls++;
      return deps.embed(text);
    },
  };
  await backfillEmbeddingIndex(admin, false, backfillDeps);
  assertEquals(backfillCalls, 0);
  assertEquals(
    await admin.queryObject("SELECT * FROM memory_scope.embedding_generation"),
    generationBefore,
  );
  await backfillEmbeddingIndex(admin, true, backfillDeps);
  backfillCalls = 0;
  await backfillEmbeddingIndex(admin, true, backfillDeps);
  assertEquals(backfillCalls, 0, "unchanged backfill must not rebuild vectors");
  const content = "ordinary garden passage ".repeat(500) +
    "tangerine late passage";
  const created = await services.captureThoughtWithMetadata(app, {
    content,
    scope,
    auth,
    via: "rest",
  }, deps);
  assertEquals(
    (await services.fetchThoughtInScope(app, created.id, { scope, auth }))
      ?.content,
    content,
  );
  const index = await admin.queryObject<{ n: number; hash: string }>(
    "SELECT cardinality(vectors) AS n, source_hash AS hash FROM public.thought_embedding_index WHERE thought_id=$1",
    [created.id],
  );
  assert(index.rows[0].n > 1);
  assertEquals(index.rows[0].hash, await sourceHash(content));
  const hits = await services.searchThoughtsByQuery(app, {
    query: "semantic-tail",
    scope,
    auth,
    threshold: 0.9,
  }, deps);
  assertEquals(hits.map((r) => r.id), [created.id]);
  // Case/whitespace deduplication retains canonical text and indexes THAT
  // source, including distinct late content, without minting another thought.
  const duplicate = await services.captureThoughtWithMetadata(app, {
    content: content.toUpperCase(),
    scope,
    auth,
    via: "rest",
  }, deps);
  assertEquals(duplicate.id, created.id);
  assertEquals(
    (await services.fetchThoughtInScope(app, created.id, { scope, auth }))
      ?.content,
    content,
  );
  const countBefore = await admin.queryObject(
    "SELECT count(*)::int AS n FROM thoughts",
  );
  let calls = 0;
  const failedDeps = {
    ...deps,
    embed: (text: string) => {
      if (++calls === 2) throw new Error("synthetic late-chunk failure");
      return deps.embed(text);
    },
  };
  await assertRejects(
    () =>
      services.captureThoughtWithMetadata(app, {
        content: content + "new",
        scope,
        auth,
        via: "rest",
      }, failedDeps),
    Error,
    "write=not_started",
  );
  assertEquals(
    await admin.queryObject("SELECT count(*)::int AS n FROM thoughts"),
    countBefore,
  );
  calls = 0;
  const thoughtBefore = await admin.queryObject(
    "SELECT to_jsonb(t) AS record, to_jsonb(i) AS index FROM thoughts t JOIN public.thought_embedding_index i ON i.thought_id=t.id WHERE t.id=$1",
    [created.id],
  );
  await assertRejects(
    () =>
      services.updateThoughtInScope(app, {
        id: created.id,
        content: content + "edited",
        scope,
        auth,
      }, failedDeps),
    Error,
    "write=not_started",
  );
  assertEquals(
    await admin.queryObject(
      "SELECT to_jsonb(t) AS record, to_jsonb(i) AS index FROM thoughts t JOIN public.thought_embedding_index i ON i.thought_id=t.id WHERE t.id=$1",
      [created.id],
    ),
    thoughtBefore,
  );

  const toml =
    `title = "long session"\nworkspace_id = "${workspace}"\nsummary = ${
      JSON.stringify(content)
    }\n[[artifacts]]\nkind = "note"\ntitle = "retained artifact"`;
  calls = 0;
  const sessionsBefore = await admin.queryObject(
    "SELECT count(*)::int AS n FROM sessions.session",
  );
  await assertRejects(
    () =>
      services.captureSessionFromToml(
        app,
        { tomlText: toml, auth },
        failedDeps,
      ),
    Error,
    "write=not_started",
  );
  assertEquals(
    await admin.queryObject("SELECT count(*)::int AS n FROM sessions.session"),
    sessionsBefore,
  );
  const session = await services.captureSessionFromToml(app, {
    tomlText: toml,
    auth,
  }, deps);
  const record = await services.getSessionInScope(app, session.id, {
    scope,
    auth,
  });
  assertEquals(record?.summary, content);
  assertEquals(record?.artifacts.length, 1);
  assertEquals(
    (await services.searchSessionsByQuery(app, {
      query: "semantic-tail",
      scope,
      auth,
      threshold: 0.9,
    }, deps)).map((r) => r.id),
    [session.id],
  );
  const snapshot = await getSnapshot(session.id);
  calls = 0;
  await assertRejects(
    () =>
      services.captureSessionFromToml(app, {
        tomlText: `id = ${session.id}\n` +
          toml.replace("late passage", "late revision"),
        auth,
      }, failedDeps),
    Error,
    "write=not_started",
  );
  assertEquals(await getSnapshot(session.id), snapshot);
  const noOp = await services.captureSessionFromToml(app, {
    tomlText: `id = ${session.id}\n` + toml,
    auth,
  }, deps);
  assertEquals(noOp.reembedded, false);
  const nullEquivalent = await services.captureSessionFromToml(app, {
    tomlText: `id = ${session.id}\ngoal = ""\n` + toml,
    auth,
  }, deps);
  assertEquals(nullEquivalent.reembedded, false);
  assertEquals(
    (await services.searchSessionsByQuery(app, {
      query: "semantic-tail",
      scope,
      auth,
      threshold: 0.9,
    }, deps)).map((r) => r.id),
    [session.id],
  );
  const revision = await services.captureSessionFromToml(app, {
    tomlText: `id = ${session.id}\n` +
      toml.replace("late passage", "changed tail"),
    auth,
  }, deps);
  assertEquals(revision.reembedded, true);

  // All embeddings succeeded, but the DB rejects the index write. The parent,
  // previous vectors and artifact set must still roll back together.
  const parsed = parseSessionToml(
    `id = ${session.id}\n` + toml.replace("late passage", "database failure"),
  );
  const badIndex = await buildEmbeddingIndex(
    "wrong source",
    ["title"],
    deps.embed,
    contract,
  );
  const beforeBadIndex = await getSnapshot(session.id);
  const failedHash = await computeContentHash(parsed.session);
  await assertRejects(() =>
    upsertSession(app, {
      session: parsed.session,
      artifacts: [],
      rawToml: parsed.rawToml,
      contentHash: failedHash,
      embedding: vector(0),
      index: badIndex,
      contract,
      provenance: { source: "funnel", sourceNode: auth.sub },
      scope: readScope,
    }), Error);
  assertEquals(await getSnapshot(session.id), beforeBadIndex);

  await services.moveThoughtInScope(app, {
    id: created.id,
    scope,
    auth,
    target: {
      workspace_id: workspace,
      project_id: null,
      visibility: "personal",
    },
  });
  assertEquals(
    await services.fetchThoughtInScope(app, created.id, {
      scope: { workspace_id: workspace },
      auth: other,
    }),
    null,
  );
  assertEquals(
    (await services.searchThoughtsByQuery(app, {
      query: "semantic-tail",
      scope: { workspace_id: workspace },
      auth: other,
      threshold: 0.9,
    }, deps)).some((r) => r.id === created.id),
    false,
  );
  assertEquals(
    (await services.searchThoughtsByQuery(app, {
      query: "semantic-tail",
      scope: { workspace_id: workspace },
      auth,
      threshold: 0.9,
    }, deps)).map((r) => r.id),
    [created.id],
  );
  const { withScopeClient } = await import("./scoped_db.ts");
  const deniedScope = {
    ...readScope,
    principal: other.sub,
    visibilities: ["personal" as const, "workspace" as const],
  };
  assertEquals(
    await withScopeClient(app, deniedScope, async (c) =>
      (await c.queryObject(
        "SELECT * FROM public.thought_embedding_index WHERE thought_id=$1",
        [created.id],
      )).rows),
    [],
  );
  const sharedSession = await services.captureSessionFromToml(app, {
    tomlText: toml + "\n",
    auth,
  }, deps);
  // Capture audience must be authored before [[artifacts]], in the root TOML.
  const privateSession = await services.captureSessionFromToml(app, {
    tomlText: 'visibility = "personal"\n' + toml,
    auth,
  }, deps);
  assertEquals(
    await services.getSessionInScope(app, privateSession.id, {
      scope: { workspace_id: workspace },
      auth: other,
    }),
    null,
  );
  assertEquals(
    await withScopeClient(app, deniedScope, async (c) =>
      (await c.queryObject(
        "SELECT * FROM sessions.embedding_index WHERE session_id=$1",
        [privateSession.id],
      )).rows),
    [],
  );
  const otherHits = await services.searchSessionsByQuery(app, {
    query: "semantic-tail",
    scope: { workspace_id: workspace },
    auth: other,
    threshold: 0.9,
  }, deps);
  assert(!otherHits.some((r) => r.id === privateSession.id));
  assert(otherHits.some((r) => r.id === sharedSession.id));
  await admin.queryArray("DELETE FROM sessions.session WHERE id=$1", [
    privateSession.id,
  ]);
  assertEquals(
    (await admin.queryObject(
      "SELECT * FROM sessions.embedding_index WHERE session_id=$1",
      [privateSession.id],
    )).rows,
    [],
  );
  await admin.queryArray("DELETE FROM thoughts WHERE id=$1", [created.id]);
  assertEquals(
    (await admin.queryObject(
      "SELECT * FROM public.thought_embedding_index WHERE thought_id=$1",
      [created.id],
    )).rows,
    [],
  );
  await assertRejects(
    () =>
      services.searchThoughtsByQuery(app, {
        query: "semantic-tail",
        scope,
        auth,
      }, { ...deps, contract: () => Promise.resolve("b".repeat(64)) }),
    services.UpstreamError,
    "backfill is incomplete",
  );
  // A matching generation alone is insufficient: the SQL guard must detect
  // a missing session index even when the request searches only thoughts.
  await admin.queryArray(
    "DELETE FROM sessions.embedding_index WHERE session_id=$1",
    [sharedSession.id],
  );
  await assertRejects(
    () =>
      services.searchThoughtsByQuery(app, {
        query: "semantic-tail",
        scope,
        auth,
      }, deps),
    services.UpstreamError,
    "backfill is incomplete",
  );
  await backfillEmbeddingIndex(admin, true, backfillDeps);
  // Preserve the existing operator-aware lexical union on the NEW vector
  // contract. Orthogonal query vectors keep this a lexical correctness test.
  const lexicalTexts = [
    "foo bar",
    "foo -bar",
    "foo alone",
    "OPS-275",
    "foo OR bar",
  ];
  const lexicalIds = new Map<string, string>();
  for (const content of lexicalTexts) {
    const row = await services.captureThoughtWithMetadata(app, {
      content,
      scope,
      auth,
      via: "rest",
    }, deps);
    lexicalIds.set(content, row.id);
  }
  const lexicalDeps = { ...deps, embed: () => Promise.resolve(vector(2)) };
  const lexical = async (query: string) =>
    (await services.searchThoughtsByQuery(app, {
      query,
      scope,
      auth,
      threshold: 1,
      limit: 100,
    }, lexicalDeps)).map((r) => r.id).sort();
  assertEquals(await lexical("foo -bar"), [lexicalIds.get("foo alone")]);
  assertEquals(await lexical("-bar"), []);
  assertEquals(await lexical('"foo alone"'), [lexicalIds.get("foo alone")]);
  assertEquals(await lexical("OPS-275"), [lexicalIds.get("OPS-275")]);
  assertEquals(
    await lexical("foo OR bar"),
    ["foo bar", "foo -bar", "foo alone", "foo OR bar"].map((t) =>
      lexicalIds.get(t)
    ).sort(),
  );
  assertEquals(await lexical("%__"), []);
  assertEquals(await lexical("xy"), []);

  // A legacy row with no old single vector becomes searchable after backfill.
  const legacy = await admin.queryObject<{ id: bigint }>(
    "INSERT INTO sessions.session(title,workspace_id,visibility) VALUES ('tangerine legacy',$1,'workspace') RETURNING id",
    [workspace],
  );
  await backfillEmbeddingIndex(admin, true, deps);
  assert(
    (await services.searchSessionsByQuery(app, {
      query: "semantic-tail",
      scope,
      auth,
      threshold: 0.9,
    }, deps)).some((r) => r.id === Number(legacy.rows[0].id)),
  );
  console.log(
    "embedding index: canonical records, late passages, dedupe, failure atomicity, hash refresh, scope moves and delete cleanup passed",
  );
} finally {
  await admin.queryArray("DELETE FROM thoughts WHERE workspace_id=$1", [
    workspace,
  ]);
  await admin.queryArray("DELETE FROM sessions.session WHERE workspace_id=$1", [
    workspace,
  ]);
  await admin.queryArray("DELETE FROM memory_scope.workspace WHERE id=$1", [
    workspace,
  ]);
  admin.release();
  await app.end();
  await adminPool.end();
}
