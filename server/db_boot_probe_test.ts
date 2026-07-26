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

class FakeClient {
  queryCalls: string[] = [];
  releaseCalls = 0;

  constructor(
    private hybridSchema: [boolean, boolean] = [true, true],
  ) {}

  queryArray(sql: string): Promise<{ rows: unknown[] }> {
    this.queryCalls.push(sql);
    if (sql.includes("to_regclass")) {
      return Promise.resolve({ rows: [this.hybridSchema] });
    }
    return Promise.resolve({ rows: [[1]] });
  }

  release(): void {
    this.releaseCalls++;
  }
}

Deno.test("probeDbAtBoot: success path validates connectivity and hybrid schema", async () => {
  const client = new FakeClient();
  const fakePool = {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;

  await probeDbAtBoot(fakePool, "db:5432");
  assertEquals(client.queryCalls.length, 2);
  assertEquals(client.queryCalls[0], "SELECT 1");
  assert(client.queryCalls[1].includes("idx_thoughts_content_tsv"));
  assert(client.queryCalls[1].includes("idx_thoughts_content_trgm"));
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: missing hybrid schema rejects with migration guidance", async () => {
  const client = new FakeClient([true, false]);
  const fakePool = {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;

  const err = await assertRejects(
    () => probeDbAtBoot(fakePool, "db:5432"),
    Error,
  );
  assertStringIncludes(err.message, "idx_thoughts_content_trgm");
  assertStringIncludes(err.message, "db/05-hybrid-search.sql");
  assertEquals(client.releaseCalls, 1);
});

Deno.test("probeDbAtBoot: client released even when the validation query fails", async () => {
  const client = new FakeClient();
  client.queryArray = () =>
    Promise.reject(new Error("Connection refused (os error 111)"));
  const fakePool = {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;

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
    resolveConnect(new FakeClient());
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
      connect: () => Promise.resolve(new FakeClient()),
    } as unknown as Pool;
    await probeDbAtBoot(fakePool, "db:5432", { slowWarnAfterMs: 20 });
    await delay(60); // would fire by now if the timer weren't cleared
    assertEquals(warns, []);
  } finally {
    console.warn = origWarn;
  }
});
