// Regression tests for the patched DeferredAccessStack
// (postgres_deferred_patched.ts — audit finding PR55-SRV-001: lazy pool
// slots permanently leaked when initialization threw inside pop()).
//
// Two layers:
//   1. The REAL pinned driver Pool, constructed exactly like the two
//      dedicated consumers (auth_audit.ts and log_ingester.ts both do
//      `new Pool(config, 2, true)`), pointed at a port with no listener.
//      This is the wiring test: it fails if the deno.json import-map
//      remap of the driver's utils/deferred.ts is ever dropped, because
//      the stock stack loses both slots after two failed borrows and the
//      third borrow parks forever.
//   2. The patched stack class directly, for the recovery-and-waiter
//      semantics a dead TCP port can't exercise deterministically.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Pool } from "postgres";
import { getClient } from "./db_pool.ts";
import { DeferredAccessStack } from "./postgres_deferred_patched.ts";

// An ephemeral port with nothing listening: bind, read the port, close.
// (The tiny reuse window between close and the test's connects is
// acceptable — CI machines don't race to squat just-freed high ports.)
function deadPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

function lazyPoolOfTwo(port: number): Pool {
  // Mirrors the dedicated auth-audit / log-ingester pool construction:
  // size 2, lazy.
  return new Pool(
    {
      hostname: "127.0.0.1",
      port,
      database: "openbrain",
      user: "test",
      password: "test",
    },
    2,
    true,
  );
}

Deno.test("lazy Pool: failed first borrows do not consume slots (real pinned driver)", async () => {
  const pool = lazyPoolOfTwo(deadPort());
  try {
    // The PR55-SRV-001 reproduction: two failed first borrows against an
    // unreachable database. Stock v0.19.3 leaves available === 0 here.
    await assertRejects(() => pool.connect());
    await assertRejects(() => pool.connect());
    assertEquals(
      pool.available,
      2,
      "both slots must be restored after failed initialization",
    );

    // Third borrow must fail fast like the first two — with the slots
    // leaked it instead parks forever in the stack's wait queue (the
    // hung-not-crashing production failure mode: consumers wedge and
    // stay wedged after PostgreSQL recovers).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parked = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("parked"), 2000);
    });
    const outcome = await Promise.race([
      pool.connect().then(() => "connected", () => "rejected"),
      parked,
    ]);
    clearTimeout(timer);
    assertEquals(outcome, "rejected");
    assertEquals(pool.available, 2);
  } finally {
    try {
      await pool.end();
    } catch {
      // uninitialized clients may refuse to end cleanly — irrelevant here
    }
  }
});

Deno.test("lazy Pool: getClient single-attempt borrows (audit-pool shape) preserve capacity", async () => {
  const pool = lazyPoolOfTwo(deadPort());
  try {
    // auth_audit.ts borrows with getClient(pool, 1) — fast-fail, no
    // retry. Two such failures burned both slots pre-patch.
    await assertRejects(() => getClient(pool, 1));
    await assertRejects(() => getClient(pool, 1));
    assertEquals(pool.available, 2);
    await assertRejects(() => getClient(pool, 1));
    assertEquals(pool.available, 2);
  } finally {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
});

Deno.test("patched DeferredAccessStack: waiters fail fast during outage, reconnect after recovery", async () => {
  interface Conn {
    name: string;
    initialized: boolean;
  }
  let dbUp = false;
  const stack = new DeferredAccessStack<Conn>(
    [
      { name: "a", initialized: false },
      { name: "b", initialized: false },
    ],
    (conn) => {
      if (!dbUp) return Promise.reject(new Error("connection refused"));
      conn.initialized = true;
      return Promise.resolve();
    },
    (conn) => conn.initialized,
  );

  // Outage: every pop fails fast and the element count is preserved.
  await assertRejects(() => stack.pop(), Error, "connection refused");
  await assertRejects(() => stack.pop(), Error, "connection refused");
  assertEquals(stack.available, 2);

  // Recovery without any process restart: the very next pop initializes.
  dbUp = true;
  const c1 = await stack.pop();
  assert(c1.initialized);
  const c2 = await stack.pop();
  assertEquals(stack.available, 0);

  // A parked waiter woken by push() while the database is DOWN again and
  // the pushed element needs re-initialization (the evicted-client shape
  // getClient produces): the waiter must get a prompt rejection — not
  // hang — and the element must return to the stack.
  dbUp = false;
  c1.initialized = false; // simulate getClient's end()+release eviction
  const waiter = stack.pop(); // parks: both elements checked out
  stack.push(c1); // release wakes the waiter with an evicted element
  await assertRejects(() => waiter, Error, "connection refused");
  assertEquals(stack.available, 1);

  // And once the database returns, the same evicted element revives.
  dbUp = true;
  const revived = await stack.pop();
  assert(revived.initialized);
  stack.push(revived);
  stack.push(c2);
  assertEquals(stack.available, 2);
});
