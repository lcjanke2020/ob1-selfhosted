// Explicit CI smoke for the PRE-1.20 → 1.20 auth-audit upgrade path.
//
// This is not a *_test.ts file: db-init.yml runs it only against its
// disposable PostgreSQL container. The companion auth_audit_db_smoke.ts
// proves fresh-install + idempotent-replay + emitter mapping — but the
// db-init database is BORN converged, so nothing there exercises the
// load-bearing sequence a real pre-1.20 deployment goes through. This smoke
// does, with the REAL boot probe, in two phases around the workflow's
// `psql < db/02-observability.sql` step:
//
//   UPGRADE_SMOKE_PHASE=refuse  — clone the initialized database
//     (CREATE DATABASE … TEMPLATE), downgrade `mcp_auth_events` to the
//     pre-1.20 denied-only shape, seed legacy rows, and assert
//     `probeDbAtBoot` (as the real `openbrain_app` role) REFUSES with the
//     migration guidance an operator would see.
//   UPGRADE_SMOKE_PHASE=accept  — after the workflow converges the clone
//     with the current db/02: assert the same probe now accepts, the legacy
//     rows survived backfilled as `outcome='denied'` with reasons intact,
//     the shape constraints exist, and the app role can land an allowed row.
//
// The scratch database is a TEMPLATE clone so the probe's OTHER contracts
// (hybrid search, spaces, metadata ledger, native tokens) are all present —
// exactly the state of a fully-migrated deployment that has not yet applied
// the 1.20 audit re-apply, which is the deployment this PR's boot gate
// exists for.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Pool, type PoolClient } from "postgres";
import { probeDbAtBoot } from "./db_boot_probe.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");
const phase = Deno.env.get("UPGRADE_SMOKE_PHASE");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");
assert(
  phase === "refuse" || phase === "accept",
  'UPGRADE_SMOKE_PHASE must be "refuse" or "accept"',
);

const TEMPLATE_DB = "openbrain";
const SCRATCH_DB = "openbrain_upgrade";

// The pre-1.20 shape, verbatim from db/02-observability.sql before this
// change (reason NOT NULL, no outcome/door/subject/token_label, no shape
// constraints), including the grants that file carried. NEVER apply this to
// a real database — it exists only so CI can regression-pin the upgrade.
const LEGACY_DDL = [
  `DROP TABLE IF EXISTS mcp_auth_events`,
  `CREATE TABLE mcp_auth_events (
     id             BIGSERIAL PRIMARY KEY,
     ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
     reason         TEXT NOT NULL,
     middleware     TEXT NOT NULL,
     client_ip      INET,
     path           TEXT,
     inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX idx_mcp_auth_events_ts        ON mcp_auth_events (ts DESC)`,
  `CREATE INDEX idx_mcp_auth_events_reason_ts ON mcp_auth_events (reason, ts DESC)`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_auth_events TO openbrain_app`,
  `GRANT USAGE ON SEQUENCE mcp_auth_events_id_seq TO openbrain_app`,
  `GRANT SELECT ON mcp_auth_events TO openbrain_readonly`,
  `GRANT SELECT ON SEQUENCE mcp_auth_events_id_seq TO openbrain_readonly`,
];

// The exact rows a pre-1.20 server would have written (old 4-column shape).
const LEGACY_ROWS: Array<[string, string, string | null, string]> = [
  ["missing_credentials", "require_auth", "192.0.2.77", "/mcp"],
  ["token_validation_failed", "require_auth", null, "/"],
];

function makePool(database: string, user: string, password: string): Pool {
  return new Pool({ hostname: host, port, database, user, password }, 1, true);
}

async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

if (phase === "refuse") {
  // Maintenance connection must NOT target the template or the scratch db.
  const maintenance = makePool("postgres", "postgres", adminPassword);
  try {
    await withClient(maintenance, async (client) => {
      await client.queryArray(
        `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`,
      );
      // Requires zero live connections to the template; the workflow's prior
      // psql steps have all exited by this point.
      await client.queryArray(
        `CREATE DATABASE ${SCRATCH_DB} TEMPLATE ${TEMPLATE_DB}`,
      );
    });
  } finally {
    await maintenance.end();
  }

  const scratchAdmin = makePool(SCRATCH_DB, "postgres", adminPassword);
  try {
    await withClient(scratchAdmin, async (client) => {
      for (const statement of LEGACY_DDL) {
        await client.queryArray(statement);
      }
      for (const [reason, middleware, clientIp, path] of LEGACY_ROWS) {
        await client.queryArray(
          `INSERT INTO mcp_auth_events (reason, middleware, client_ip, path)
           VALUES ($1, $2, $3::inet, $4)`,
          [reason, middleware, clientIp, path],
        );
      }
    });
  } finally {
    await scratchAdmin.end();
  }

  // The REAL probe, as the REAL app role, against the pre-1.20 clone: this is
  // what a 1.20 container boot sees on a deployment that skipped the db/02
  // re-apply. It must refuse and it must name the fix.
  const appPool = makePool(SCRATCH_DB, "openbrain_app", appPassword);
  try {
    const err = await assertRejects(
      () => probeDbAtBoot(appPool, `${host}:${port}/${SCRATCH_DB}`),
      Error,
    );
    assertStringIncludes(err.message, "mcp_auth_events");
    assertStringIncludes(err.message, "db/02-observability.sql");
  } finally {
    await appPool.end();
  }
  console.log(
    "upgrade smoke phase 1: pre-1.20 clone built (2 legacy rows) and the " +
      "real boot probe refused it with db/02 migration guidance",
  );
} else {
  // The workflow has now applied the current db/02 to the scratch database —
  // the operator's migration step. The same probe must accept…
  const appPool = makePool(SCRATCH_DB, "openbrain_app", appPassword);
  try {
    await probeDbAtBoot(appPool, `${host}:${port}/${SCRATCH_DB}`);

    // …the legacy rows must have survived, backfilled as denied with their
    // reasons intact…
    await withClient(appPool, async (client) => {
      const rows = await client.queryObject<{
        outcome: string;
        reason: string;
        door: string | null;
        subject: string | null;
      }>(
        `SELECT outcome, reason, door, subject
         FROM mcp_auth_events ORDER BY id`,
      );
      assertEquals(rows.rows.length, LEGACY_ROWS.length);
      rows.rows.forEach((row, i) => {
        assertEquals(row.outcome, "denied");
        assertEquals(row.reason, LEGACY_ROWS[i][0]);
        assertEquals(row.door, null);
        assertEquals(row.subject, null);
      });

      const constraints = await client.queryObject<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'mcp_auth_events'::regclass AND contype = 'c'
         ORDER BY conname`,
      );
      assertEquals(constraints.rows.map((r) => r.conname), [
        "mcp_auth_events_door_check",
        "mcp_auth_events_outcome_check",
        "mcp_auth_events_outcome_shape_check",
      ]);

      // …and the converged shape must accept an allowed row from the app
      // role (the first row a rolling 1.20 deployment writes post-migration).
      await client.queryArray(
        `INSERT INTO mcp_auth_events
           (outcome, reason, middleware, door, subject, token_label, client_ip, path)
         VALUES ('allowed', NULL, 'require_auth', 'funnel',
                 'auth0|upgrade-smoke', NULL, NULL, '/mcp')`,
      );
    });
  } finally {
    await appPool.end();
  }

  const maintenance = makePool("postgres", "postgres", adminPassword);
  try {
    await withClient(
      maintenance,
      (client) => client.queryArray(`DROP DATABASE ${SCRATCH_DB} WITH (FORCE)`),
    );
  } finally {
    await maintenance.end();
  }
  console.log(
    "upgrade smoke phase 2: converged clone passed the real boot probe, " +
      "legacy rows backfilled denied with reasons preserved, constraints " +
      "present, allowed row accepted; scratch database dropped",
  );
}
