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
];

function bootQueryHandler(
  requiredSchema: RequiredSchema = COMPLETE_SCHEMA,
  defaultWorkspaceExists = true,
  notificationStateExists = true,
): QueryHandler {
  return (sql) => {
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
  assertEquals(queries.length, 4);
  assertEquals(queries[0], "SELECT 1");
  assert(queries[1].includes("idx_thoughts_content_tsv"));
  assert(queries[1].includes("idx_thoughts_content_trgm"));
  assert(queries[1].includes("metadata_degradation_events_id_seq"));
  assert(queries[1].includes("metadata_degradation_outbox"));
  assert(queries[1].includes("last_delivery_attempt_at"));
  assert(queries[1].includes("last_failed_channels"));
  assert(queries[1].includes("last_event_id"));
  assert(queries[1].includes("created_at"));
  assert(queries[1].includes("native_auth.access_token"));
  assert(queries[1].includes("mcp_auth_events"));
  assert(queries[1].includes("mcp_auth_events_outcome_shape_check"));
  assert(queries[1].includes("public.thought_revisions"));
  assert(queries[1].includes("thought_revisions_app_head"));
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
  assert(queries[2].includes("metadata_degradation_notification_state"));
  assert(queries[3].includes("memory_scope.workspace"));
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
  ]));

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "mcp_auth_events");
  assertStringIncludes(err.message, "db/02-observability.sql");
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
    false,
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
  });

  await assertRejects(() => probeDbAtBoot(fakePool, "db:5432"), Error);
  assertEquals(client.releaseCalls, 1);
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
