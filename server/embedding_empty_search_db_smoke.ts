// Run before schema/data fixtures populate thoughts. PostgreSQL can skip the
// candidate function (and its readiness guard) when the joined table is empty.
// Exercise the real service as openbrain_app with deterministic embeddings.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
import { UpstreamError } from "./errors.ts";

const hostname = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
assertEquals(hostname, "127.0.0.1");
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const password = Deno.env.get("OPENBRAIN_APP_PASSWORD");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
assert(password, "OPENBRAIN_APP_PASSWORD is required");
assert(adminPassword, "POSTGRES_PASSWORD is required");
Deno.env.set("DB_PASSWORD", password);
Deno.env.set("MCP_ACCESS_KEY", "empty-search-ci-only-key".repeat(4));
Deno.env.set("METADATA_FALLBACK_POLICY", "off");
const { searchThoughtsByQuery } = await import("./services.ts");
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
  password,
}, 1);
const admin = await adminPool.connect();
const contract = "a".repeat(64);
const deps = {
  contract: () => Promise.resolve(contract),
  embed: () =>
    Promise.resolve(Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)),
  extractMetadata: () =>
    Promise.resolve({
      metadata: {},
      classifier: { schema_version: 1 as const, endpoint: "stub" as const },
      degradation_events: [],
    }),
};
const search = () =>
  searchThoughtsByQuery(app, {
    query: "empty-corpus-probe",
    scope: { workspace_id: "default", visibility: "workspace" },
    auth: { door: "funnel", sub: "empty-search-smoke", tokenLabel: null },
  }, deps);
let generationBefore: { contract: string | null } | undefined;
let sessionId: bigint | undefined;
try {
  // Read as superuser: an empty RLS audience is not the physical-empty-table
  // plan that exposed the regression. Never remove somebody else's fixtures.
  const counts = await admin.queryObject<
    { thoughts: number; sessions: number }
  >(
    `SELECT (SELECT count(*)::int FROM thoughts) AS thoughts,
            (SELECT count(*)::int FROM sessions.session) AS sessions`,
  );
  assertEquals(counts.rows[0], { thoughts: 0, sessions: 0 });
  const generation = await admin.queryObject<{ contract: string | null }>(
    "SELECT contract FROM memory_scope.embedding_generation WHERE singleton",
  );
  assertEquals(generation.rows.length, 1);
  generationBefore = generation.rows[0];

  await admin.queryArray(
    "UPDATE memory_scope.embedding_generation SET contract=NULL WHERE singleton",
  );
  await assertRejects(search, UpstreamError, "embedding index unavailable");

  await admin.queryArray(
    "UPDATE memory_scope.embedding_generation SET contract=$1 WHERE singleton",
    [contract],
  );
  assertEquals(await search(), [], "an activated empty corpus is valid");

  await admin.queryArray(
    "UPDATE memory_scope.embedding_generation SET contract=$1 WHERE singleton",
    ["b".repeat(64)],
  );
  await assertRejects(search, UpstreamError, "embedding index unavailable");

  await admin.queryArray(
    "UPDATE memory_scope.embedding_generation SET contract=$1 WHERE singleton",
    [contract],
  );
  const session = await admin.queryObject<{ id: bigint }>(
    `INSERT INTO sessions.session(title,workspace_id,visibility)
     VALUES ('empty-thought-search missing session index','default','workspace')
     RETURNING id`,
  );
  sessionId = session.rows[0].id;
  await assertRejects(search, UpstreamError, "embedding index unavailable");
  console.log(
    "empty thought search: inactive generation, valid empty corpus, contract drift and missing session index passed",
  );
} finally {
  try {
    if (sessionId !== undefined) {
      await admin.queryArray("DELETE FROM sessions.session WHERE id=$1", [
        sessionId,
      ]);
    }
    if (generationBefore !== undefined) {
      await admin.queryArray(
        "UPDATE memory_scope.embedding_generation SET contract=$1 WHERE singleton",
        [generationBefore.contract],
      );
    }
  } finally {
    admin.release();
    await app.end();
    await adminPool.end();
  }
}
