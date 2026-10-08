// Explicit PostgreSQL regression for the production forget/restore path:
// forgetThoughtInScope / restoreThoughtInScope (services.ts → queries.ts →
// memory_scope.forget_thought / restore_thought) and every read path a
// forgotten thought must leave, as the forced-RLS application role against
// db/17-forget-thoughts.sql.
//
// This file intentionally is not named *_test.ts: the hermetic suite has no
// PostgreSQL dependency. db-init.yml runs it against its disposable, fully
// initialized pgvector container. Vectors are deterministic test data, so
// these are correctness assertions, never claims about recall quality. It
// proves that the capture upsert's conflict target matches the live-rows
// index (a re-capture of forgotten text creates a new thought), that contract
// search (both legs), list, fetch, stats, update, and move all lose a
// forgotten thought while the corpus stays embedding-ready, and that restore
// brings it back or reports the live duplicate.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";

const hostname = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
assertEquals(hostname, "127.0.0.1");
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");
assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");

// services.ts imports the production config graph. Install the same minimum
// runtime values as the shipped server before loading that graph.
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("MCP_ACCESS_KEY", "forget-ci-only-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");

const services = await import("./services.ts");
const { backfillEmbeddingIndex } = await import("./embedding_backfill.ts");

const adminPool = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "postgres",
  password: adminPassword,
}, 1);
const app = new Pool({
  hostname,
  port,
  database: "openbrain",
  user: "openbrain_app",
  password: appPassword,
}, 3);
const admin = await adminPool.connect();

const contract = "a".repeat(64);
const vector = (n: number) =>
  Array.from({ length: 768 }, (_, i) => i === n ? 1 : 0);
let embedCalls = 0;
const deps = {
  contract: () => Promise.resolve(contract),
  embed: (text: string) => {
    embedCalls++;
    return Promise.resolve(vector(text.includes("kumquat") ? 5 : 0));
  },
  extractMetadata: () =>
    Promise.resolve({
      metadata: {},
      classifier: { schema_version: 1 as const, endpoint: "stub" as const },
      degradation_events: [],
    }),
};

const workspace = "__forget_db_smoke";
const scope = { workspace_id: workspace, visibility: "workspace" as const };
const personal = { workspace_id: workspace, visibility: "personal" as const };
const owner = {
  door: "funnel" as const,
  sub: "forget-owner",
  tokenLabel: null,
};
const other = { ...owner, sub: "forget-other" };
const CONTENT = "forget db smoke kumquat ledger-zq7";

const searchIds = async (query: string) =>
  (await services.searchThoughtsByQuery(app, {
    query,
    scope,
    auth: owner,
    threshold: 0.9,
    limit: 100,
  }, deps)).map((r) => r.id);
const listIds = async () =>
  (await services.listThoughtsInScope(app, {
    scope,
    auth: owner,
    limit: 100,
  })).map((r) => r.id);
const statsCount = async () =>
  (await services.getThoughtStatsInScope(app, { scope, auth: owner })).count;

try {
  await admin.queryArray(
    "INSERT INTO memory_scope.workspace(id,default_visibility,personal_only) VALUES ($1,'workspace',false) ON CONFLICT DO NOTHING",
    [workspace],
  );
  // Contract search requires the whole corpus indexed for this contract.
  await backfillEmbeddingIndex(admin, true, deps);

  const a = await services.captureThoughtWithMetadata(app, {
    content: CONTENT,
    scope,
    auth: owner,
    via: "rest",
  }, deps);
  assert((await searchIds("kumquat")).includes(a.id), "vector leg baseline");
  assert((await searchIds("ledger-zq7")).includes(a.id), "lexical baseline");
  assert((await listIds()).includes(a.id));
  const liveCount = await statsCount();

  // ---- forget ------------------------------------------------------------
  const forgotten = await services.forgetThoughtInScope(app, {
    id: a.id,
    scope,
    auth: owner,
  });
  assertEquals(forgotten?.outcome, "forgotten");
  assertEquals(forgotten?.revision, 1);
  assertEquals(forgotten?.workspace_id, workspace);
  assertEquals(
    (await services.forgetThoughtInScope(app, {
      id: a.id,
      scope,
      auth: owner,
    }))?.outcome,
    "unchanged",
  );

  // Every read path loses it; the corpus stays embedding-ready (searches
  // above and below would raise otherwise).
  assertEquals((await searchIds("kumquat")).includes(a.id), false);
  assertEquals((await searchIds("ledger-zq7")).includes(a.id), false);
  assertEquals((await listIds()).includes(a.id), false);
  assertEquals(
    await services.fetchThoughtInScope(app, a.id, { scope, auth: owner }),
    null,
  );
  assertEquals(await statsCount(), liveCount - 1);
  assertEquals(
    await services.updateThoughtInScope(app, {
      id: a.id,
      content: "forget db smoke rewritten",
      scope,
      auth: owner,
    }, deps),
    null,
  );
  assertEquals(
    await services.moveThoughtInScope(app, {
      id: a.id,
      target: { workspace_id: workspace, visibility: "personal" },
      scope,
      auth: owner,
    }),
    null,
  );

  // The offline backfill still covers the forgotten row without rebuilding
  // it, so a restore needs no re-embedding.
  embedCalls = 0;
  await backfillEmbeddingIndex(admin, true, deps);
  assertEquals(embedCalls, 0, "forgotten rows keep their passage index");

  // ---- re-capture creates a fresh thought ----------------------------------
  const b = await services.captureThoughtWithMetadata(app, {
    content: CONTENT,
    scope,
    auth: owner,
    via: "rest",
  }, deps);
  assert(b.id !== a.id, "re-capture must not resurrect the forgotten row");
  assertEquals(
    (await searchIds("kumquat")).filter((id) => id === a.id || id === b.id),
    [b.id],
  );

  // ---- restore -------------------------------------------------------------
  const conflict = await assertRejects(
    () => services.restoreThoughtInScope(app, { id: a.id, scope, auth: owner }),
    services.ConflictError,
  );
  assert(conflict.message.includes(b.id));

  assertEquals(
    (await services.forgetThoughtInScope(app, {
      id: b.id,
      scope,
      auth: owner,
    }))?.outcome,
    "forgotten",
  );
  const restored = await services.restoreThoughtInScope(app, {
    id: a.id,
    scope,
    auth: owner,
  });
  assertEquals(restored?.outcome, "restored");
  assertEquals(restored?.revision, 2);
  assertEquals(
    (await services.fetchThoughtInScope(app, a.id, { scope, auth: owner }))
      ?.content,
    CONTENT,
  );
  assert((await searchIds("kumquat")).includes(a.id));
  assert((await searchIds("ledger-zq7")).includes(a.id));
  assertEquals(await statsCount(), liveCount);

  // History as the owner role sees it: forget then restore, verified actor.
  const history = await admin.queryObject<
    { change_kind: string; changed_by_subject: string; door: string }
  >(
    `SELECT change_kind, changed_by_subject, changed_by_door AS door
     FROM public.thought_revisions WHERE thought_id = $1 ORDER BY revision`,
    [a.id],
  );
  assertEquals(history.rows, [
    { change_kind: "forget", changed_by_subject: owner.sub, door: "funnel" },
    { change_kind: "restore", changed_by_subject: owner.sub, door: "funnel" },
  ]);

  // ---- personal thoughts: owner only ---------------------------------------
  const mine = await services.captureThoughtWithMetadata(app, {
    content: "forget db smoke personal note",
    scope: personal,
    auth: owner,
    via: "rest",
  }, deps);
  assertEquals(
    await services.forgetThoughtInScope(app, {
      id: mine.id,
      scope: personal,
      auth: other,
    }),
    null,
  );
  assertEquals(
    (await services.forgetThoughtInScope(app, {
      id: mine.id,
      scope: personal,
      auth: owner,
    }))?.outcome,
    "forgotten",
  );

  console.log(
    "forget/restore: read paths (contract search both legs, list, fetch, stats), update/move refusal, readiness and backfill coverage, fresh re-capture, restore conflict and success, history, and owner-only personal forget passed",
  );
} finally {
  await admin.queryArray("DELETE FROM thoughts WHERE workspace_id=$1", [
    workspace,
  ]);
  await admin.queryArray("DELETE FROM memory_scope.workspace WHERE id=$1", [
    workspace,
  ]);
  admin.release();
  await app.end();
  await adminPool.end();
}
