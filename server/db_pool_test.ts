// Unit tests for the connection-pool resilience helper. No real database:
// the fakes model the two behaviours getClient() depends on —
//   1. a borrowed client whose socket is dead throws a connection-level error
//      on its first query, and
//   2. once a client is end()'d, the pool re-establishes it on the next
//      connect() (mirroring deno-postgres's DeferredAccessStack.pop(), which
//      reconnects any client whose `connected` flag is false).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ConnectionError } from "postgres";
import type { Pool } from "postgres";
import { getClient, isConnectionError } from "./db_pool.ts";

// ---------------------------------------------------------------------------
// isConnectionError
// ---------------------------------------------------------------------------

Deno.test("isConnectionError: typed ConnectionError", () => {
  assert(isConnectionError(new ConnectionError("the session was terminated")));
});

Deno.test("isConnectionError: raw OS socket errors", () => {
  assert(isConnectionError(new Error("write: Broken pipe (os error 32)")));
  assert(
    isConnectionError(new Error("Connection reset by peer (os error 104)")),
  );
  assert(isConnectionError(new Error("Bad resource ID")));
  assert(
    isConnectionError(
      new Error("Connection to the database has been terminated"),
    ),
  );
});

Deno.test("isConnectionError: SQL / non-connection errors are NOT matched", () => {
  assertEquals(
    isConnectionError(
      new Error("duplicate key value violates unique constraint"),
    ),
    false,
  );
  assertEquals(isConnectionError("not an error object"), false);
  assertEquals(isConnectionError(undefined), false);
});

// ---------------------------------------------------------------------------
// getClient — fakes
// ---------------------------------------------------------------------------

type FailKind = "broken-pipe" | "sql" | null;

class FakeClient {
  alive: boolean;
  ended = false;
  failKind: FailKind;
  endCalls = 0;
  releaseCalls = 0;
  queryCalls = 0;

  constructor(alive: boolean, failKind: FailKind = "broken-pipe") {
    this.alive = alive;
    this.failKind = failKind;
  }

  // deno-postgres PoolClient surface that getClient() touches:
  queryArray(_sql: string): Promise<{ rows: unknown[] }> {
    this.queryCalls++;
    if (!this.alive) {
      if (this.failKind === "sql") {
        return Promise.reject(
          new Error("duplicate key value violates unique constraint"),
        );
      }
      return Promise.reject(new Error("write: Broken pipe (os error 32)"));
    }
    return Promise.resolve({ rows: [] });
  }

  end(): Promise<void> {
    this.endCalls++;
    this.alive = false;
    this.ended = true;
    return Promise.resolve();
  }

  release(): void {
    this.releaseCalls++;
  }
}

// reconnectable: connect() revives an end()'d client (DB is back).
// down: connect() hands the dead client back unchanged (DB still gone).
class FakePool {
  connectCalls = 0;
  constructor(
    public client: FakeClient,
    private mode: "reconnectable" | "down",
  ) {}
  connect(): Promise<FakeClient> {
    this.connectCalls++;
    if (this.mode === "reconnectable" && this.client.ended) {
      this.client.ended = false;
      this.client.alive = true;
    }
    return Promise.resolve(this.client);
  }
}

const asPool = (p: FakePool): Pool => p as unknown as Pool;

// ---------------------------------------------------------------------------
// getClient — behaviour
// ---------------------------------------------------------------------------

Deno.test("getClient: returns a healthy client directly (single probe)", async () => {
  const client = new FakeClient(true);
  const pool = new FakePool(client, "reconnectable");

  const got = await getClient(asPool(pool));

  assertEquals(got as unknown as FakeClient, client);
  assertEquals(client.queryCalls, 1); // one validation probe
  assertEquals(client.endCalls, 0);
  assertEquals(client.releaseCalls, 0); // caller releases later
});

Deno.test("getClient: recovers a dead pooled connection after a DB restart", async () => {
  // Stale-dead socket: first probe fails, getClient evicts (end) + releases,
  // the pool reconnects on the next borrow, second probe succeeds.
  const client = new FakeClient(false);
  const pool = new FakePool(client, "reconnectable");

  const got = await getClient(asPool(pool));

  assertEquals(got as unknown as FakeClient, client);
  assertEquals(client.endCalls, 1); // dead client evicted exactly once
  assertEquals(client.queryCalls, 2); // failed probe + successful probe
  assert(pool.connectCalls >= 2); // re-borrowed to get the reconnect
});

Deno.test("getClient: throws when the database stays down", async () => {
  const client = new FakeClient(false);
  const pool = new FakePool(client, "down");

  await assertRejects(
    () => getClient(asPool(pool), 2),
    Error,
    "Broken pipe",
  );
  assertEquals(client.endCalls, 2); // evicted on every attempt
});

Deno.test("getClient: propagates a non-connection (SQL) error without retrying", async () => {
  const client = new FakeClient(false, "sql");
  const pool = new FakePool(client, "down");

  await assertRejects(
    () => getClient(asPool(pool)),
    Error,
    "duplicate key",
  );
  assertEquals(client.endCalls, 0); // not a dead socket — not evicted
  assertEquals(client.releaseCalls, 1); // released back, then rethrown
  assertEquals(client.queryCalls, 1); // no retry
});
