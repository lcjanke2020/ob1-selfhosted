// Explicit CI smoke for the production auth-audit SQL boundary.
//
// This is not a *_test.ts file: db-init.yml runs it only against its
// disposable, freshly initialized PostgreSQL container. Every unit test runs
// the audit emitter with `OBS_AUTH_EVENTS_ENABLED=false`, so without this
// smoke the eight-column INSERT text, the record→row mapping, and the
// app-role grants have no executable coverage — and because the emitter is
// deliberately fire-and-forget, a regression there loses the audit silently
// instead of failing a request. This file drives the REAL `auth_audit.ts`
// module, as the real `openbrain_app` role, through every row shape the
// middleware emits, and then pins the row-shape constraints by attempting
// the malformed inserts the schema must refuse.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");

const database = "openbrain";

// Point the emitter at the smoke database as the application role BEFORE the
// module import — auth_audit.ts reads its connection env at module load.
Deno.env.set("DB_HOST", host);
Deno.env.set("DB_PORT", String(port));
Deno.env.set("DB_NAME", database);
Deno.env.set("DB_USER", "openbrain_app");
Deno.env.set("DB_PASSWORD", appPassword);
Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "true");

const {
  logAuthFailure,
  logAuthSuccess,
  getAuditMetricsForTests,
  shutdownAuthAuditForTests,
} = await import("./auth_audit.ts");

const adminPool = new Pool({
  hostname: host,
  port,
  database,
  user: "postgres",
  password: adminPassword,
}, 1);
const appPool = new Pool({
  hostname: host,
  port,
  database,
  user: "openbrain_app",
  password: appPassword,
}, 1);

type AuditRow = {
  outcome: string;
  reason: string | null;
  middleware: string;
  door: string | null;
  subject: string | null;
  token_label: string | null;
  client_ip: string | null;
  path: string | null;
};

async function fetchRows(): Promise<AuditRow[]> {
  const client = await adminPool.connect();
  try {
    const result = await client.queryObject<AuditRow>(
      `SELECT outcome, reason, middleware, door, subject, token_label,
              host(client_ip) AS client_ip, path
       FROM mcp_auth_events ORDER BY id`,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

try {
  // Start from a clean table so the ordered row assertions below are exact.
  {
    const client = await adminPool.connect();
    try {
      await client.queryArray(`DELETE FROM mcp_auth_events`);
    } finally {
      client.release();
    }
  }

  // ---- 1. Fire every shape the middleware emits (auth.ts success branches
  // and unauthorized()), in a fixed order the ordered SELECT can assert on.
  logAuthSuccess({
    door: "tailnet",
    middleware: "require_auth",
    clientIp: "192.0.2.1",
    path: "/mcp",
  });
  logAuthSuccess({
    door: "tailnet",
    middleware: "require_auth",
    tokenLabel: "smoke-native-label",
    clientIp: "192.0.2.2",
    path: "/mcp",
  });
  logAuthSuccess({
    door: "funnel",
    middleware: "require_auth",
    subject: "auth0|smoke-user",
    clientIp: "192.0.2.3",
    path: "/",
  });
  logAuthSuccess({
    door: "service",
    middleware: "require_auth",
    subject: "smoke-machine@clients",
    path: "/api/v1/thoughts",
  });
  logAuthFailure({
    reason: "subject_not_allowed",
    middleware: "require_auth",
    subject: "auth0|smoke-refused",
    clientIp: "192.0.2.4",
    path: "/mcp",
  });
  logAuthFailure({
    reason: "missing_credentials",
    middleware: "require_auth",
    clientIp: "192.0.2.5",
    path: "/",
  });

  // The emitter is fire-and-forget; poll until all six land (or time out —
  // a lost row is exactly the regression this smoke exists to catch).
  const deadline = Date.now() + 15_000;
  let rows: AuditRow[] = [];
  while (Date.now() < deadline) {
    rows = await fetchRows();
    if (rows.length >= 6) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assertEquals(
    rows.length,
    6,
    `expected all six audit rows to land, got ${rows.length}`,
  );
  assertEquals(getAuditMetricsForTests().droppedTotal, 0);

  // ---- 2. Exact record→row mapping, per shape.
  const expected: AuditRow[] = [
    {
      outcome: "allowed",
      reason: null,
      middleware: "require_auth",
      door: "tailnet",
      subject: null,
      token_label: null,
      client_ip: "192.0.2.1",
      path: "/mcp",
    },
    {
      outcome: "allowed",
      reason: null,
      middleware: "require_auth",
      door: "tailnet",
      subject: null,
      token_label: "smoke-native-label",
      client_ip: "192.0.2.2",
      path: "/mcp",
    },
    {
      outcome: "allowed",
      reason: null,
      middleware: "require_auth",
      door: "funnel",
      subject: "auth0|smoke-user",
      token_label: null,
      client_ip: "192.0.2.3",
      path: "/",
    },
    {
      outcome: "allowed",
      reason: null,
      middleware: "require_auth",
      door: "service",
      subject: "smoke-machine@clients",
      token_label: null,
      client_ip: null,
      path: "/api/v1/thoughts",
    },
    {
      outcome: "denied",
      reason: "subject_not_allowed",
      middleware: "require_auth",
      door: null,
      subject: "auth0|smoke-refused",
      token_label: null,
      client_ip: "192.0.2.4",
      path: "/mcp",
    },
    {
      outcome: "denied",
      reason: "missing_credentials",
      middleware: "require_auth",
      door: null,
      subject: null,
      token_label: null,
      client_ip: "192.0.2.5",
      path: "/",
    },
  ];
  assertEquals(rows, expected);

  // ---- 3. Row-shape constraints refuse malformed inserts, as the app role
  // (so the negative also proves the constraint is not bypassable by the
  // role the emitter actually uses).
  const appClient = await appPool.connect();
  try {
    const malformed: Array<[string, string]> = [
      [
        "allowed row with a reason",
        `INSERT INTO mcp_auth_events (outcome, reason, middleware, door)
         VALUES ('allowed', 'missing_credentials', 'require_auth', 'funnel')`,
      ],
      [
        "denied row without a reason",
        `INSERT INTO mcp_auth_events (outcome, reason, middleware)
         VALUES ('denied', NULL, 'require_auth')`,
      ],
      [
        "unknown door",
        `INSERT INTO mcp_auth_events (outcome, reason, middleware, door)
         VALUES ('allowed', NULL, 'require_auth', 'backdoor')`,
      ],
      [
        "unknown outcome",
        `INSERT INTO mcp_auth_events (outcome, reason, middleware)
         VALUES ('mystery', NULL, 'require_auth')`,
      ],
    ];
    for (const [label, sql] of malformed) {
      await assertRejects(
        () => appClient.queryArray(sql),
        Error,
        undefined,
        `${label} must be refused by a row-shape constraint`,
      );
    }
  } finally {
    appClient.release();
  }

  // Malformed attempts must not have landed.
  assertEquals((await fetchRows()).length, 6);

  console.log(
    "auth audit smoke: six emitter shapes landed with exact mapping, " +
      "zero drops, and all malformed shapes were refused",
  );
} finally {
  const adminClient = await adminPool.connect();
  try {
    await adminClient.queryArray(`DELETE FROM mcp_auth_events`);
  } finally {
    adminClient.release();
  }
  await shutdownAuthAuditForTests();
  await adminPool.end();
  await appPool.end();
}
