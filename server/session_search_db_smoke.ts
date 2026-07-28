// Explicit CI smoke for the filtered session-HNSW production boundary.
//
// This file intentionally is not named *_test.ts: the ordinary hermetic suite
// has no PostgreSQL dependency. db-init.yml runs it against its disposable,
// fully initialized pgvector container.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
import type { PoolClient } from "postgres";
import type { ResolvedReadScope } from "./scope_contract.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");
const rebuilds = Number(Deno.env.get("DB_SMOKE_REBUILDS") ?? "0");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");
assert(
  Number.isInteger(rebuilds) && rebuilds >= 0 && rebuilds <= 3,
  "DB_SMOKE_REBUILDS must be an integer from 0 through 3",
);

// session_queries.ts imports the production config graph. Install the same
// minimum runtime values as the shipped server before loading that graph.
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("MCP_ACCESS_KEY", "session-hnsw-smoke-key".repeat(4));

const [{ searchSessions }, { getClient }, { withScopeClient }] = await Promise
  .all([
    import("./session_queries.ts"),
    import("./db_pool.ts"),
    import("./scoped_db.ts"),
  ]);

const database = "openbrain";
const fixtureWorkspace = "session-hnsw-smoke-hidden";
const fixtureTitlePrefix = "session-hnsw-smoke-";
// Deliberately beyond pgvector 0.8.x's default hnsw.max_scan_tuples (20,000):
// the application-owned exact fallback must recover eligible rows after the
// bounded ANN leg underfills.
const hiddenNoiseRows = 26_000;
const embedding = [1, ...Array.from({ length: 767 }, () => 0)];
const embeddingLiteral = `[${embedding.join(",")}]`;

const defaultScope: ResolvedReadScope = {
  workspaceId: "default",
  projectId: null,
  principal: null,
  visibilities: ["workspace"],
};
const hiddenScope: ResolvedReadScope = {
  ...defaultScope,
  workspaceId: fixtureWorkspace,
};

const adminPool = new Pool(
  {
    hostname: host,
    port,
    database,
    user: "postgres",
    password: adminPassword,
  },
  1,
);
// One slot is deliberate: restoration checks must borrow the same pooled
// connection that the production transaction just released.
const appPool = new Pool(
  {
    hostname: host,
    port,
    database,
    user: "openbrain_app",
    password: appPassword,
  },
  1,
);

async function withAdmin<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function cleanFixture(): Promise<void> {
  await withAdmin(async (client) => {
    await client.queryArray(
      `DELETE FROM sessions.session
       WHERE title LIKE $1 OR workspace_id = $2`,
      [`${fixtureTitlePrefix}%`, fixtureWorkspace],
    );
    await client.queryArray(
      "DELETE FROM memory_scope.workspace WHERE id = $1",
      [fixtureWorkspace],
    );
  });
}

async function seedFixture(): Promise<void> {
  await withAdmin(async (client) => {
    await client.queryArray(
      `INSERT INTO memory_scope.workspace
         (id, description, default_visibility, personal_only)
       VALUES ($1, 'CI-only filtered HNSW fixture', 'workspace', false)`,
      [fixtureWorkspace],
    );

    // The closest rows exceed the deployed HNSW scan cap. They are useful to
    // the hidden-workspace limit case, but must be discarded by RLS for a
    // default-workspace caller and by each optional residual-filter case.
    await client.queryArray(
      `INSERT INTO sessions.session
         (title, status, repo_url, tags, workspace_id, project_id,
          visibility, owner_subject, embedding)
       SELECT $1 || g, 'active', 'noise/repo', ARRAY['noise'],
              $2, NULL, 'workspace', NULL,
              ('[' || '1,' || (g::double precision / 100000)::text || ',' ||
                rtrim(repeat('0,', 766), ',') || ']')::vector
       FROM generate_series(1, $3::integer) AS g`,
      [`${fixtureTitlePrefix}noise-`, fixtureWorkspace, hiddenNoiseRows],
    );

    await client.queryArray(
      `INSERT INTO sessions.session
         (title, status, repo_url, tags, workspace_id, project_id,
          visibility, owner_subject, embedding)
       SELECT $1 || g, 'done', 'noise/repo', ARRAY['noise'],
              $2, NULL, 'workspace', NULL,
              ('[' || '1,' || (0.1 + g::double precision / 100000)::text || ',' ||
                rtrim(repeat('0,', 766), ',') || ']')::vector
       FROM generate_series(1, 10) AS g`,
      [`${fixtureTitlePrefix}status-`, fixtureWorkspace],
    );
    await client.queryArray(
      `INSERT INTO sessions.session
         (title, status, repo_url, tags, workspace_id, project_id,
          visibility, owner_subject, embedding)
       SELECT $1 || g, 'active', 'target/repo', ARRAY['noise'],
              $2, NULL, 'workspace', NULL,
              ('[' || '1,' || (0.2 + g::double precision / 100000)::text || ',' ||
                rtrim(repeat('0,', 766), ',') || ']')::vector
       FROM generate_series(1, 10) AS g`,
      [`${fixtureTitlePrefix}repo-`, fixtureWorkspace],
    );
    await client.queryArray(
      `INSERT INTO sessions.session
         (title, status, repo_url, tags, workspace_id, project_id,
          visibility, owner_subject, embedding)
       SELECT $1 || g, 'active', 'noise/repo', ARRAY['target-tag'],
              $2, NULL, 'workspace', NULL,
              ('[' || '1,' || (0.3 + g::double precision / 100000)::text || ',' ||
                rtrim(repeat('0,', 766), ',') || ']')::vector
       FROM generate_series(1, 10) AS g`,
      [`${fixtureTitlePrefix}tag-`, fixtureWorkspace],
    );

    // These are farther than every hidden-workspace row. The production call
    // must iterate through those RLS-hidden candidates to find them.
    await client.queryArray(
      `INSERT INTO sessions.session
         (title, status, repo_url, tags, workspace_id, project_id,
          visibility, owner_subject, embedding)
       SELECT $1 || g, 'active', 'visible/repo', ARRAY['visible'],
              'default', NULL, 'workspace', NULL,
              ('[' || '1,' || (0.4 + g::double precision / 100000)::text || ',' ||
                rtrim(repeat('0,', 766), ',') || ']')::vector
       FROM generate_series(1, 10) AS g`,
      [`${fixtureTitlePrefix}rls-visible-`],
    );

    await client.queryArray("VACUUM ANALYZE sessions.session");
  });
}

type SearchCase = {
  name: string;
  scope: ResolvedReadScope;
  limit: number;
  status?: string;
  repo_url?: string;
  tag?: string;
  titlePrefix?: string;
};

const cases: SearchCase[] = [
  {
    name: "RLS audience",
    scope: defaultScope,
    limit: 5,
    titlePrefix: `${fixtureTitlePrefix}rls-visible-`,
  },
  {
    name: "status residual filter",
    scope: hiddenScope,
    limit: 5,
    status: "done",
    titlePrefix: `${fixtureTitlePrefix}status-`,
  },
  {
    name: "repository residual filter",
    scope: hiddenScope,
    limit: 5,
    repo_url: "target/repo",
    titlePrefix: `${fixtureTitlePrefix}repo-`,
  },
  {
    name: "tag residual filter",
    scope: hiddenScope,
    limit: 5,
    tag: "target-tag",
    titlePrefix: `${fixtureTitlePrefix}tag-`,
  },
  {
    name: "request above default ef_search",
    scope: hiddenScope,
    limit: 50,
  },
];

function exactQuery(testCase: SearchCase): {
  sql: string;
  params: unknown[];
} {
  const conditions = ["embedding IS NOT NULL"];
  const params: unknown[] = [embeddingLiteral];
  let p = 2;
  if (testCase.status) {
    conditions.push(`status = $${p++}::sessions.session_status`);
    params.push(testCase.status);
  }
  if (testCase.repo_url) {
    conditions.push(`repo_url = $${p++}`);
    params.push(testCase.repo_url);
  }
  if (testCase.tag) {
    conditions.push(`tags @> ARRAY[$${p++}]::text[]`);
    params.push(testCase.tag);
  }
  params.push(testCase.limit);
  return {
    sql: `SELECT title
          FROM sessions.session
          WHERE ${conditions.join(" AND ")}
          ORDER BY embedding <=> $1::vector
          LIMIT $${p}`,
    params,
  };
}

async function exactTitles(testCase: SearchCase): Promise<string[]> {
  return await withScopeClient(appPool, testCase.scope, async (client) => {
    // Force and verify the ground-truth path. An ORDER BY distance query is
    // not exact merely because it looks exact while an ANN index is enabled.
    await client.queryArray("SET LOCAL enable_indexscan = off");
    await client.queryArray("SET LOCAL enable_bitmapscan = off");
    const query = exactQuery(testCase);
    const explained = await client.queryArray(
      `EXPLAIN ${query.sql}`,
      query.params,
    );
    const plan = explained.rows.flat().join("\n");
    assert(
      !plan.includes("idx_session_embedding_hnsw"),
      `${testCase.name}: exact reference unexpectedly used HNSW\n${plan}`,
    );
    const result = await client.queryObject<{ title: string }>(
      query.sql,
      query.params,
    );
    return result.rows.map((row) => row.title);
  });
}

async function assertApproximatePlanUsesHnsw(
  testCase: SearchCase,
): Promise<void> {
  await withScopeClient(appPool, testCase.scope, async (client) => {
    // Keep this planner assertion separate from the result-count contract.
    // It proves the stabilized fixture exercises HNSW; runCase independently
    // proves the production boundary recovers a complete eligible result.
    await client.queryArray(
      "SELECT set_config('hnsw.ef_search', $1::text, true)",
      [String(Math.max(50, testCase.limit))],
    );
    await client.queryArray("SET LOCAL hnsw.iterative_scan = strict_order");
    const query = exactQuery(testCase);
    const explained = await client.queryArray(
      `EXPLAIN ${query.sql}`,
      query.params,
    );
    const plan = explained.rows.flat().join("\n");
    assert(
      plan.includes("idx_session_embedding_hnsw"),
      `${testCase.name}: production-shaped plan did not use HNSW\n${plan}`,
    );
  });
}

async function readHnswSettings(): Promise<{
  ef_search: string;
  iterative_scan: string;
  max_scan_tuples: string;
}> {
  const client = await getClient(appPool);
  try {
    // pgvector registers its HNSW GUCs lazily in each backend. Load the
    // extension before capturing the connection's baseline; otherwise a new
    // pooled backend reports "unrecognized configuration parameter" and a
    // before/after comparison would confuse module initialization with state
    // leakage.
    await client.queryArray("SELECT $1::vector", [embeddingLiteral]);
    const result = await client.queryObject<{
      ef_search: string;
      iterative_scan: string;
      max_scan_tuples: string;
    }>(
      `SELECT current_setting('hnsw.ef_search') AS ef_search,
              current_setting('hnsw.iterative_scan') AS iterative_scan,
              current_setting('hnsw.max_scan_tuples') AS max_scan_tuples`,
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function runCase(testCase: SearchCase): Promise<void> {
  const exact = await exactTitles(testCase);
  assertEquals(
    exact.length,
    testCase.limit,
    `${testCase.name}: exact fixture does not contain enough eligible rows`,
  );
  if (testCase.titlePrefix) {
    assert(
      exact.every((title) => title.startsWith(testCase.titlePrefix!)),
      `${testCase.name}: exact reference returned an unexpected fixture row`,
    );
  }

  const rows = await searchSessions(
    appPool,
    {
      embedding,
      limit: testCase.limit,
      status: testCase.status,
      repo_url: testCase.repo_url,
      tag: testCase.tag,
    },
    testCase.scope,
  );
  assertEquals(
    rows.length,
    testCase.limit,
    `${testCase.name}: production HNSW search underfilled`,
  );
  assert(
    rows.every((row) => row.workspace_id === testCase.scope.workspaceId),
    `${testCase.name}: production search crossed the workspace audience`,
  );
  if (testCase.titlePrefix) {
    assert(
      rows.every((row) => row.title.startsWith(testCase.titlePrefix!)),
      `${testCase.name}: production search returned a filtered-out row`,
    );
  }
}

async function runAllCases(): Promise<void> {
  await assertApproximatePlanUsesHnsw(cases[0]);
  for (const testCase of cases) await runCase(testCase);
}

try {
  await cleanFixture();
  await seedFixture();

  const settingsBefore = await readHnswSettings();
  assert(
    hiddenNoiseRows > Number(settingsBefore.max_scan_tuples),
    "hidden-noise fixture must exceed the deployed HNSW scan-tuple cap",
  );
  await runAllCases();
  assertEquals(
    await readHnswSettings(),
    settingsBefore,
    "successful searches leaked transaction-local HNSW settings",
  );

  // Invalid enum input fails only when the final query runs, after both HNSW
  // controls have been installed. This exercises the real rollback path.
  await assertRejects(() =>
    searchSessions(
      appPool,
      { embedding, limit: 5, status: "not-a-session-status" },
      hiddenScope,
    )
  );
  assertEquals(
    await readHnswSettings(),
    settingsBefore,
    "failed search leaked transaction-local HNSW settings after rollback",
  );

  // A valid call after the rollback proves the one-slot pool remains reusable.
  await runCase(cases[0]);
  assertEquals(await readHnswSettings(), settingsBefore);

  for (let rebuild = 1; rebuild <= rebuilds; rebuild++) {
    await withAdmin(async (client) => {
      await client.queryArray(
        "REINDEX INDEX sessions.idx_session_embedding_hnsw",
      );
      await client.queryArray("VACUUM ANALYZE sessions.session");
    });
    await runAllCases();
    assertEquals(await readHnswSettings(), settingsBefore);
    console.log(`session HNSW smoke passed after rebuild ${rebuild}`);
  }

  console.log(
    `session HNSW smoke passed ${cases.length} cases; ` +
      `settings restored after commit, rollback, and pooled reuse`,
  );
} finally {
  await cleanFixture().catch(() => {});
  await appPool.end().catch(() => {});
  await adminPool.end().catch(() => {});
}
