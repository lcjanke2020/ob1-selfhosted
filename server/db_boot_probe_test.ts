// Regression tests for the boot probe: an eagerly-initialized deno-postgres
// Pool pointed at an unreachable Postgres must not take the process down with
// an unhandled rejection — the boot probe adopts the constructor's
// fire-and-forget init promise and rejects with operator guidance instead.
//
// The unreachable-port test uses a REAL Pool against a closed 127.0.0.1 port
// (covered by the test task's --allow-net=127.0.0.1): it is load-bearing
// precisely because the driver's rejection originates in the constructor,
// which fakes cannot reproduce. If the probe ever stops adopting that
// promise, this test dies as an unhandled-rejection test failure rather
// than a clean assertion.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { makeFakePool, type QueryHandler } from "./api_test_support.ts";
import { probeDbAtBoot } from "./db_boot_probe.ts";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Nothing listens here — connections are refused immediately.
const CLOSED_TARGET = { hostname: "127.0.0.1", port: 59999 };

Deno.test("probeDbAtBoot: unreachable Postgres rejects with guidance, no unhandled rejection", async () => {
  const pool = new Pool(
    {
      ...CLOSED_TARGET,
      database: "openbrain",
      user: "x",
      password: "x",
    },
    2, // eager, like db.ts — the probe must observe the constructor's init
  );
  const err = await assertRejects(
    () => probeDbAtBoot(pool, "127.0.0.1:59999"),
    Error,
  );
  // Operator-facing: names the target and the env vars to check.
  assertStringIncludes(err.message, "127.0.0.1:59999");
  assertStringIncludes(err.message, "DB_HOST");
  assertStringIncludes(err.message, "DB_PASSWORD");
  // Underlying driver reason is preserved for diagnosis.
  assertStringIncludes(err.message.toLowerCase(), "refused");
  // end() re-surfaces the failed init; the pool never opened resources.
  await pool.end().catch(() => {});
});

// ---------------------------------------------------------------------------
// Fake-pool tests for the probe's own behavior (validate + release + warn).
// Only the surface probeDbAtBoot touches is modeled.
// ---------------------------------------------------------------------------

type RequiredSchema = [
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
];

const COMPLETE_SCHEMA: RequiredSchema = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

function bootQueryHandler(
  requiredSchema: RequiredSchema = COMPLETE_SCHEMA,
  defaultWorkspaceExists = true,
  notificationStateExists = true,
): QueryHandler {
  return (sql) => {
    if (sql.includes("FROM native_auth.access_token")) return { rows: [] };
    if (sql.includes("FROM oauth_auth.allowed_subject")) return { rows: [] };
    if (sql.includes("oauth_auth.allowed_subject")) return { rows: [[true]] };
    if (sql.includes("to_regclass")) {
      return { rows: [requiredSchema] };
    }
    if (sql.includes("FROM public.metadata_degradation_notification_state")) {
      return { rows: [[notificationStateExists]] };
    }
    if (sql.includes("FROM memory_scope.workspace WHERE id")) {
      return { rows: [[defaultWorkspaceExists]] };
    }
    if (sql.trim() === "SELECT 1") return { rows: [[1]] };
    return undefined;
  };
}

Deno.test("probeDbAtBoot: success path validates connectivity and hybrid schema", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler());

  await probeDbAtBoot(fakePool, "db:5432");
  const queries = client.queryArrayCalls.map(({ sql }) => sql);
  assertEquals(queries.length, 7);
  assertEquals(queries[0], "SELECT 1");
  assert(queries[1].includes("idx_thoughts_content_tsv"));
  assert(queries[1].includes("idx_thoughts_content_trgm"));
  assert(queries[1].includes("thought_embedding_index"));
  assert(queries[1].includes("sessions.embedding_index"));
  assert(queries[1].includes("memory_scope.embedding_generation"));
  assert(queries[1].includes("memory_scope.embedding_ready(text)"));
  assert(queries[1].includes("boolean,jsonb,jsonb,integer,text)"));
  assert(queries[1].includes("metadata_degradation_events_id_seq"));
  assert(queries[1].includes("metadata_degradation_outbox"));
  assert(queries[1].includes("last_delivery_attempt_at"));
  assert(queries[1].includes("last_failed_channels"));
  assert(queries[1].includes("last_event_id"));
  assert(queries[1].includes("created_at"));
  assert(queries[1].includes("native_auth.access_token"));
  assert(queries[1].includes("mcp_auth_events"));
  assert(queries[1].includes("mcp_auth_events_id_seq"));
  assert(queries[1].includes("mcp_auth_events_outcome_shape_check"));
  assert(queries[1].includes("openbrain_auth_rollup"));
  assert(queries[1].includes("UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER"));
  assert(queries[1].includes("AS application_membership"));
  assert(queries[1].includes("AS readonly_membership"));
  assert(queries[1].includes("FROM pg_auth_members AS membership"));
  assert(queries[1].includes("FROM pg_roles AS readonly"));
  assert(queries[1].includes("FROM pg_class AS relation"));
  assert(queries[1].includes("FROM pg_proc AS routine"));
  assert(queries[1].includes("FROM pg_namespace AS usage_namespace"));
  assert(queries[1].includes("aclexplode(usage_namespace.nspacl)"));
  assert(queries[1].includes("usage_acl.privilege_type = 'USAGE'"));
  assert(queries[1].includes("grantable_usage_acl.is_grantable"));
  assert(queries[1].includes("FROM pg_default_acl AS rollup_default_acl"));
  assert(queries[1].includes("aclexplode(guarded_relation.relacl)"));
  assert(queries[1].includes("direct_acl.is_grantable"));
  assert(queries[1].includes("has_sequence_privilege"));
  assert(queries[1].includes("has_function_privilege"));
  assert(queries[1].includes("has_schema_privilege"));
  assert(queries[1].includes("has_database_privilege"));
  assert(queries[1].includes("public.thought_revisions"));
  assert(queries[1].includes("thought_revisions_app_head"));
  assert(queries[1].includes("sessions.session"));
  assert(queries[1].includes("sessions.artifact"));
  assert(queries[1].includes("session_update_columns"));
  assert(queries[1].includes("FROM pg_attribute AS live_column"));
  assert(queries[1].includes("allowed.attname = live_column.attname::text"));
  assert(queries[1].includes("has_any_column_privilege"));
  assert(
    queries[1].includes(
      "memory_scope.move_thought(uuid,text,text,memory_scope.visibility,text,text)",
    ),
  );
  assert(
    queries[1].includes(
      "metadata_degradation_failed_channels_shape",
    ),
  );
  assert(
    queries[2].includes("principal, revoked_at FROM native_auth.access_token"),
  );
  assert(queries[3].includes("oauth_auth.allowed_subject"));
  assert(queries[4].includes("FROM oauth_auth.allowed_subject"));
  assert(queries[5].includes("metadata_degradation_notification_state"));
  assert(queries[6].includes("memory_scope.workspace"));
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing passage schema names migration and activation", async () => {
  const schema: RequiredSchema = [...COMPLETE_SCHEMA];
  schema[6] = false;
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler(schema));
  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "db/15-embedding-index.sql");
  assertStringIncludes(err.message, "db/03-grants-assertion.sql");
  assertStringIncludes(err.message, "offline backfill");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing hybrid schema rejects with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "idx_thoughts_content_trgm");
  assertStringIncludes(err.message, "db/05-hybrid-search.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing spaces schema rejects with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "session audience columns");
  assertStringIncludes(err.message, "db/06-spaces.sql");
  assertStringIncludes(err.message, "PostgreSQL superuser");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing audience indexes rejects before serving", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "audience-aware indexes");
  assertStringIncludes(err.message, "db/06-spaces.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing native token schema rejects with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "native access-token schema");
  assertStringIncludes(err.message, "db/08-access-tokens.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: pre-1.20 auth-audit table shape rejects with migration guidance", async () => {
  // The denied-only mcp_auth_events shape (no outcome/door/subject/token_label
  // or shape constraint) must refuse boot: without this gate a missed db/02
  // re-apply leaves the server healthy while the fire-and-forget emitter
  // silently drops every audit row.
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "mcp_auth_events");
  assertStringIncludes(err.message, "db/02-observability.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: widened auth-audit grants reject with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "auth-audit grants");
  assertStringIncludes(err.message, "openbrain_auth_rollup");
  assertStringIncludes(err.message, "db/12-auth-audit-grants.sql");
  assertStringIncludes(err.message, "db/03-grants-assertion.sql");
  assertStringIncludes(err.message, "openbrain_readonly membership");
  assertStringIncludes(err.message, "alternate-grantor schema grant option");
  assertStringIncludes(err.message, "default ACL");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing thought-mutation schema rejects with migration guidance", async () => {
  // update_thought/move_thought would otherwise fail per call against an
  // otherwise healthy 1.22.0 server; the gate names the migration to apply.
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "thought_revisions");
  assertStringIncludes(err.message, "memory_scope.move_thought");
  assertStringIncludes(err.message, "db/10-thought-mutations.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: widened session UPDATE grants reject with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "session UPDATE grants");
  assertStringIncludes(err.message, "db/11-session-update-grants.sql");
  assertStringIncludes(err.message, "db/03-grants-assertion.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing or incomplete metadata audit schema rejects with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(bootQueryHandler([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "missing or incompatible");
  assertStringIncludes(err.message, "metadata-degradation audit schema");
  assertStringIncludes(err.message, "db/07-metadata-degradation.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing metadata notification singleton rejects with migration guidance", async () => {
  const { pool: fakePool, client } = makeFakePool(
    bootQueryHandler(COMPLETE_SCHEMA, true, false),
  );

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "notification ledger row");
  assertStringIncludes(err.message, "db/07-metadata-degradation.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: unknown configured workspace rejects before serving", async () => {
  const { pool: fakePool, client } = makeFakePool(
    bootQueryHandler(COMPLETE_SCHEMA, false),
  );

  const err = await assertRejects(
    () =>
      probeDbAtBoot(fakePool, "db:5432", {
        defaultWorkspaceId: "misspelled",
      }),
    Error,
  );
  assertStringIncludes(err.message, "misspelled");
  assertStringIncludes(err.message, "DEFAULT_WORKSPACE_ID");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: client released even when the validation query fails", async () => {
  const { pool: fakePool, client } = makeFakePool(() => {
    throw new Error("Connection refused (os error 111)");
  }, { scriptValidation: true });

  await assertRejects(() => probeDbAtBoot(fakePool, "db:5432"), Error);
  assertEquals(client.releaseCalls, 1);
  assertEquals(
    client.queryArrayCalls.map(({ sql }) => sql),
    ["SELECT 1"],
    "the initial validation query must be the failing query",
  );
});

Deno.test("probeDbAtBoot: hung connect warns after slowWarnAfterMs, then resolves cleanly", async () => {
  let resolveConnect!: (c: unknown) => void;
  const fakePool = {
    connect: () =>
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
  } as unknown as Pool;

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.join(" "));
  };
  try {
    const probe = probeDbAtBoot(fakePool, "db.example:5432", {
      slowWarnAfterMs: 20,
    });
    await delay(60);
    assert(
      warns.some((w) =>
        w.includes("still trying") && w.includes("db.example:5432")
      ),
      `expected a slow-connect warning, got: ${JSON.stringify(warns)}`,
    );
    // Un-hang: the probe must still complete normally after a late connect.
    resolveConnect(makeFakePool(bootQueryHandler()).client);
    await probe;
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("probeDbAtBoot: hung connect rejects at deadlineMs with operator guidance", async () => {
  // Connect never settles — models an endpoint that accepts TCP but never
  // completes the handshake (the driver has no client-side connect timeout,
  // so without the deadline this would await forever).
  const fakePool = {
    connect: () => new Promise(() => {}),
  } as unknown as Pool;

  const err = await assertRejects(
    () =>
      probeDbAtBoot(fakePool, "db.example:5432", {
        slowWarnAfterMs: 10_000, // must not fire during this test
        deadlineMs: 40,
      }),
    Error,
  );
  assertStringIncludes(err.message, "db.example:5432");
  assertStringIncludes(err.message, "DB_BOOT_PROBE_TIMEOUT_MS");
});

Deno.test("probeDbAtBoot: fast success never emits the slow-connect warning", async () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.join(" "));
  };
  try {
    const fakePool = {
      connect: () => Promise.resolve(makeFakePool(bootQueryHandler()).client),
    } as unknown as Pool;
    await probeDbAtBoot(fakePool, "db:5432", { slowWarnAfterMs: 20 });
    await delay(60); // would fire by now if the timer weren't cleared
    assertEquals(warns, []);
  } finally {
    console.warn = origWarn;
  }
});

Deno.test("probeDbAtBoot: missing OAuth admission requires migration before startup", async () => {
  const baseline = bootQueryHandler();
  const { pool, client } = makeFakePool((sql, args) =>
    sql.includes("oauth_auth.allowed_subject")
      ? { rows: [[false]] }
      : baseline(sql, args)
  );
  const error = await assertRejects(
    () => probeDbAtBoot(pool, "db:5432"),
    Error,
  );
  assertStringIncludes(error.message, "db/13-oauth-subjects.sql");
  assertStringIncludes(error.message, "server 1.26.0");
  assertStringIncludes(error.message, "If OAuth is enabled");
  assertStringIncludes(error.message, "subject-admin allow");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: unreadable OAuth admission rejects with grant recovery guidance", async () => {
  const baseline = bootQueryHandler();
  const { pool, client } = makeFakePool((sql, args) => {
    if (sql.includes("FROM native_auth.access_token")) return { rows: [] };
    if (sql.includes("FROM oauth_auth.allowed_subject")) {
      throw new Error("permission denied for table allowed_subject");
    }
    return baseline(sql, args);
  });
  const error = await assertRejects(
    () => probeDbAtBoot(pool, "db:5432"),
    Error,
  );
  assertStringIncludes(
    error.message,
    "Cannot read required OAuth admission columns",
  );
  assertStringIncludes(error.message, "db/13-oauth-subjects.sql");
  assertStringIncludes(error.message, "db/03-grants-assertion.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: unreadable native principal fails before serving", async () => {
  const baseline = bootQueryHandler();
  const { pool } = makeFakePool((sql) => {
    if (sql.includes("FROM native_auth.access_token")) {
      throw new Error("permission denied");
    }
    return baseline(sql, []);
  });
  const error = await assertRejects(
    () => probeDbAtBoot(pool, "db:5432"),
    Error,
  );
  assertStringIncludes(error.message, "db/14-native-token-principals.sql");
});
