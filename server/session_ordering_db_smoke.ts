// Explicit PostgreSQL regression for public "newest session" semantics.
//
// This file intentionally is not named *_test.ts: the ordinary hermetic suite
// has no PostgreSQL dependency. db-init.yml runs it against its disposable,
// fully initialized pgvector container and the forced-RLS application role.

import { assert, assertEquals } from "@std/assert";
import { Pool } from "postgres";
import type { PoolClient } from "postgres";
import type { ResolvedReadScope } from "./scope_contract.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");

// session_queries.ts imports the production config graph. Install the same
// minimum runtime values as the shipped server before loading that graph.
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("MCP_ACCESS_KEY", "session-ordering-smoke-key".repeat(4));

const { listSessions, resumeSession } = await import("./session_queries.ts");

const database = "openbrain";
const fixturePrefix = "session-ordering-smoke-";
const defaultScope: ResolvedReadScope = {
  workspaceId: "default",
  projectId: null,
  principal: null,
  visibilities: ["workspace"],
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
      "DELETE FROM sessions.session WHERE branch LIKE $1",
      [`${fixturePrefix}%`],
    );
  });
}

type FixtureRow = {
  title: string;
  branch: string;
  lastUpdate: string | null;
  updatedAt: string;
};

async function insertFixture(
  client: PoolClient,
  row: FixtureRow,
): Promise<number> {
  const result = await client.queryObject<{ id: bigint }>(
    `INSERT INTO sessions.session
       (title, branch, last_update, created_at, updated_at,
        workspace_id, project_id, visibility, owner_subject)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $4::timestamptz,
             'default', NULL, 'workspace', NULL)
     RETURNING id`,
    [row.title, row.branch, row.lastUpdate, row.updatedAt],
  );
  return Number(result.rows[0].id);
}

type Fixture = {
  audit: { branch: string; expected: number[] };
  explicit: { branch: string; expected: number[] };
  tie: { branch: string; expected: number[] };
};

async function seedFixture(): Promise<Fixture> {
  return await withAdmin(async (client) => {
    const auditBranch = `${fixturePrefix}audit`;
    const auditOlderExplicit = await insertFixture(client, {
      title: `${fixturePrefix}audit-older-explicit`,
      branch: auditBranch,
      lastUpdate: "2026-07-01T12:00:00Z",
      updatedAt: "2026-07-01T12:00:00Z",
    });
    const auditNewerImplicit = await insertFixture(client, {
      title: `${fixturePrefix}audit-newer-implicit`,
      branch: auditBranch,
      lastUpdate: null,
      updatedAt: "2026-07-02T12:00:00Z",
    });

    const explicitBranch = `${fixturePrefix}explicit`;
    const explicitFallback = await insertFixture(client, {
      title: `${fixturePrefix}explicit-fallback`,
      branch: explicitBranch,
      lastUpdate: null,
      updatedAt: "2026-07-04T12:00:00Z",
    });
    const explicitCaller = await insertFixture(client, {
      title: `${fixturePrefix}explicit-caller`,
      branch: explicitBranch,
      lastUpdate: "2026-07-05T12:00:00Z",
      updatedAt: "2026-06-01T12:00:00Z",
    });

    const tieBranch = `${fixturePrefix}tie`;
    const tieFirst = await insertFixture(client, {
      title: `${fixturePrefix}tie-first`,
      branch: tieBranch,
      lastUpdate: null,
      updatedAt: "2026-07-06T12:00:00Z",
    });
    const tieSecond = await insertFixture(client, {
      title: `${fixturePrefix}tie-second`,
      branch: tieBranch,
      lastUpdate: null,
      updatedAt: "2026-07-06T12:00:00Z",
    });

    return {
      audit: {
        branch: auditBranch,
        expected: [auditNewerImplicit, auditOlderExplicit],
      },
      explicit: {
        branch: explicitBranch,
        expected: [explicitCaller, explicitFallback],
      },
      tie: { branch: tieBranch, expected: [tieSecond, tieFirst] },
    };
  });
}

async function assertLookupAndListAgree(
  name: string,
  branch: string,
  expected: number[],
): Promise<void> {
  const lookup = await resumeSession(appPool, { branch }, defaultScope);
  assert(lookup, `${name}: branch lookup returned no row`);
  assertEquals(
    lookup.id,
    expected[0],
    `${name}: branch lookup chose the wrong effective freshness`,
  );

  const listed = await listSessions(
    appPool,
    { branch, limit: expected.length },
    defaultScope,
  );
  assertEquals(
    listed.map((row) => row.id),
    expected,
    `${name}: default list did not use branch lookup's effective order`,
  );
}

try {
  await cleanFixture();
  const fixture = await seedFixture();

  await assertLookupAndListAgree(
    "newer stored row with omitted caller timestamp",
    fixture.audit.branch,
    fixture.audit.expected,
  );
  await assertLookupAndListAgree(
    "meaningful explicit caller timestamp",
    fixture.explicit.branch,
    fixture.explicit.expected,
  );
  await assertLookupAndListAgree(
    "exact effective-freshness tie",
    fixture.tie.branch,
    fixture.tie.expected,
  );

  console.log(
    "session ordering smoke passed null, explicit, and deterministic-tie cases",
  );
} finally {
  await cleanFixture().catch(() => {});
  await appPool.end().catch(() => {});
  await adminPool.end().catch(() => {});
}
