// Hermetic tests for the durable metadata notification ledger and adapters.
// No real Postgres or external notification service is contacted.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildMetadataNotification,
  type MetadataNotification,
  type MetadataNotificationAdapter,
  NtfyMetadataNotificationAdapter,
  PushoverMetadataNotificationAdapter,
  runMetadataNotificationCycle,
} from "./metadata_notifications.ts";
import { asPool, FakePool, type QueryHandler } from "./api_test_support.ts";

type Ledger = {
  last_event_id: string;
  pending_counts: Record<string, number>;
  notified_event_types: string[];
  last_notified_at_ms: string | null;
};

type Event = {
  id: string;
  event_type: string;
  failure_reason: string | null;
};

class NotificationDb {
  ledger: Ledger = {
    last_event_id: "0",
    pending_counts: {},
    notified_event_types: [],
    last_notified_at_ms: null,
  };
  events: Event[] = [];
  locked = false;
  missing = false;
  eventSelectSql = "";
  updates = 0;

  readonly handler: QueryHandler = (sql, params) => {
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      return { rows: this.locked || this.missing ? [] : [{ ...this.ledger }] };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("notification_state")) {
      return { rows: [[!this.missing]] };
    }
    if (
      sql.includes("FROM metadata_degradation_events") &&
      sql.includes("ORDER BY id")
    ) {
      this.eventSelectSql = sql;
      const after = BigInt(params[0] as string);
      const limit = Number(params[1]);
      return {
        rows: this.events.filter((event) => BigInt(event.id) > after).slice(
          0,
          limit,
        ),
      };
    }
    if (sql.includes("UPDATE metadata_degradation_notification_state")) {
      this.updates++;
      this.ledger.last_event_id = String(params[0]);
      this.ledger.pending_counts = JSON.parse(params[1] as string);
      this.ledger.notified_event_types = [...params[2] as string[]];
      if (params[3] !== null) {
        this.ledger.last_notified_at_ms = String(
          new Date(params[3] as string).getTime(),
        );
      }
      return { rows: [] };
    }
    return undefined;
  };

  pool() {
    return asPool(new FakePool(this.handler));
  }
}

class RecordingAdapter implements MetadataNotificationAdapter {
  readonly name = "pushover" as const;
  notifications: MetadataNotification[] = [];
  fail = false;

  send(notification: MetadataNotification): Promise<void> {
    this.notifications.push(notification);
    return this.fail
      ? Promise.reject(new Error("simulated secret-bearing provider error"))
      : Promise.resolve();
  }
}

const T0 = new Date("2026-07-29T12:00:00.000Z");
const options = (now: Date) => ({
  label: "Private memory",
  rollupMs: 30 * 60 * 1000,
  now: () => now,
});

Deno.test("metadata notification ledger: first occurrence, cooldown, retry, and replica lock", async (t) => {
  const db = new NotificationDb();
  const adapter = new RecordingAdapter();

  await t.step(
    "first primary/fallback batch delivers immediately",
    async () => {
      db.events.push(
        {
          id: "1",
          event_type: "primary_failure",
          failure_reason: "transport_or_timeout",
        },
        { id: "2", event_type: "fallback_used", failure_reason: null },
      );
      const result = await runMetadataNotificationCycle(
        db.pool(),
        [adapter],
        options(T0),
      );
      assertEquals(result, { outcome: "delivered", processed: 2 });
      assertEquals(db.ledger.last_event_id, "2");
      assertEquals(db.ledger.pending_counts, {});
      assertEquals(db.ledger.notified_event_types, [
        "fallback_used",
        "primary_failure",
      ]);
      assertEquals(adapter.notifications.length, 1);
      assertEquals(adapter.notifications[0].severity, "high");
      assertStringIncludes(
        adapter.notifications[0].message,
        "Fallback classifications: 1",
      );
      assertStringIncludes(
        adapter.notifications[0].message,
        "transport/timeout: 1",
      );
      assert(
        !db.eventSelectSql.includes("content") &&
          !db.eventSelectSql.includes("JOIN thoughts"),
        `worker query must never select thought content: ${db.eventSelectSql}`,
      );
    },
  );

  await t.step("known trigger inside cooldown is queued durably", async () => {
    db.events.push({
      id: "3",
      event_type: "primary_failure",
      failure_reason: "schema_rejection",
    });
    const result = await runMetadataNotificationCycle(
      db.pool(),
      [adapter],
      options(new Date(T0.getTime() + 5 * 60 * 1000)),
    );
    assertEquals(result, { outcome: "queued", processed: 1 });
    assertEquals(adapter.notifications.length, 1);
    assertEquals(db.ledger.pending_counts, {
      "primary_failure.schema_rejection": 1,
    });
  });

  await t.step(
    "first occurrence of a new trigger bypasses cooldown",
    async () => {
      db.events.push({
        id: "4",
        event_type: "stub_used",
        failure_reason: null,
      });
      const result = await runMetadataNotificationCycle(
        db.pool(),
        [adapter],
        options(new Date(T0.getTime() + 10 * 60 * 1000)),
      );
      assertEquals(result, { outcome: "delivered", processed: 1 });
      assertEquals(adapter.notifications.length, 2);
      assertStringIncludes(
        adapter.notifications[1].message,
        "Stub classifications: 1",
      );
      assertStringIncludes(
        adapter.notifications[1].message,
        "schema rejection: 1",
      );
      assertEquals(db.ledger.pending_counts, {});
      assertEquals(db.ledger.notified_event_types, [
        "fallback_used",
        "primary_failure",
        "stub_used",
      ]);
    },
  );

  await t.step("delivery failure retains one copy for retry", async () => {
    db.events.push({
      id: "5",
      event_type: "fallback_used",
      failure_reason: null,
    });
    adapter.fail = true;
    const failed = await runMetadataNotificationCycle(
      db.pool(),
      [adapter],
      options(new Date(T0.getTime() + 45 * 60 * 1000)),
    );
    assertEquals(failed, { outcome: "delivery_failed", processed: 1 });
    assertEquals(db.ledger.last_event_id, "5");
    assertEquals(db.ledger.pending_counts, { fallback_used: 1 });

    adapter.fail = false;
    const retried = await runMetadataNotificationCycle(
      db.pool(),
      [adapter],
      options(new Date(T0.getTime() + 50 * 60 * 1000)),
    );
    assertEquals(retried, { outcome: "delivered", processed: 0 });
    assertEquals(db.ledger.pending_counts, {});
    assertStringIncludes(
      adapter.notifications.at(-1)!.message,
      "Fallback classifications: 1",
    );
  });

  await t.step(
    "fallback failure is retained in history but is not a fourth alert class",
    async () => {
      db.events.push({
        id: "6",
        event_type: "fallback_failure",
        failure_reason: "non_2xx",
      });
      const before = adapter.notifications.length;
      const result = await runMetadataNotificationCycle(
        db.pool(),
        [adapter],
        options(new Date(T0.getTime() + 55 * 60 * 1000)),
      );
      assertEquals(result, { outcome: "idle", processed: 1 });
      assertEquals(db.ledger.last_event_id, "6");
      assertEquals(adapter.notifications.length, before);
    },
  );

  await t.step("a second replica skips a locked ledger", async () => {
    db.locked = true;
    const beforeUpdates = db.updates;
    const result = await runMetadataNotificationCycle(
      db.pool(),
      [adapter],
      options(new Date(T0.getTime() + 60 * 60 * 1000)),
    );
    assertEquals(result, { outcome: "locked", processed: 0 });
    assertEquals(db.updates, beforeUpdates);
  });

  await t.step(
    "a missing singleton fails loudly instead of looking locked",
    async () => {
      db.locked = false;
      db.missing = true;
      await assertRejects(
        () =>
          runMetadataNotificationCycle(
            db.pool(),
            [adapter],
            options(new Date(T0.getTime() + 65 * 60 * 1000)),
          ),
        Error,
        "ledger singleton is missing",
      );
    },
  );
});

Deno.test("metadata notification payload is finite and content-free", () => {
  const notification = buildMetadataNotification(
    {
      "primary_failure.non_2xx": 2,
      "primary_failure.invalid_response": 1,
      fallback_used: 3,
      stub_used: 1,
    },
    "Generic label",
    T0,
  );
  assertEquals(notification.title, "OpenBrain metadata alert");
  assertEquals(notification.severity, "high");
  assertStringIncludes(notification.message, "Primary failures: 3");
  assertStringIncludes(notification.message, "Fallback classifications: 3");
  assertStringIncludes(notification.message, "No thought content is included");
  assert(
    !notification.message.includes("thought body") &&
      !notification.message.includes("thought_id"),
  );
});

Deno.test("Pushover adapter sends form data and redacts thrown fetch errors", async () => {
  let requestUrl = "";
  let requestInit: RequestInit = {};
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init ?? {};
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  const adapter = new PushoverMetadataNotificationAdapter(
    "app-secret",
    "user-secret",
    1000,
    fakeFetch,
  );
  await adapter.send({ title: "Title", message: "Body", severity: "high" });
  assertEquals(requestUrl, "https://api.pushover.net/1/messages.json");
  const body = requestInit.body as URLSearchParams;
  assertEquals(body.get("token"), "app-secret");
  assertEquals(body.get("user"), "user-secret");
  assertEquals(body.get("priority"), "1");

  const leakingFetch =
    (() => Promise.reject(new Error("app-secret user-secret"))) as typeof fetch;
  const redacting = new PushoverMetadataNotificationAdapter(
    "app-secret",
    "user-secret",
    1000,
    leakingFetch,
  );
  const error = await assertRejects(
    () =>
      redacting.send({ title: "Title", message: "Body", severity: "normal" }),
    Error,
  );
  assertEquals(error.message.includes("app-secret"), false);
  assertEquals(error.message.includes("user-secret"), false);
});

Deno.test("ntfy adapter encodes its topic, applies auth, and redacts errors", async () => {
  let requestUrl = "";
  let requestInit: RequestInit = {};
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    // Construct the real Fetch primitives so non-ByteString header values fail
    // here exactly as they would before a network request in production.
    new Request(input, init);
    requestUrl = String(input);
    requestInit = init ?? {};
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const adapter = new NtfyMetadataNotificationAdapter(
    "https://notify.example/",
    "secret/topic",
    "bearer-secret",
    1000,
    fakeFetch,
  );
  const unicodeBody = buildMetadataNotification(
    { stub_used: 1 },
    "Private memory 🧠",
    T0,
  );
  await adapter.send(unicodeBody);
  assertEquals(requestUrl, "https://notify.example/secret%2Ftopic");
  const headers = requestInit.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer bearer-secret");
  assertEquals(headers.priority, "high");
  assertStringIncludes(String(requestInit.body), "Private memory 🧠");

  const leakingFetch =
    (() =>
      Promise.reject(new Error("secret/topic bearer-secret"))) as typeof fetch;
  const redacting = new NtfyMetadataNotificationAdapter(
    "https://notify.example",
    "secret/topic",
    "bearer-secret",
    1000,
    leakingFetch,
  );
  const error = await assertRejects(
    () =>
      redacting.send({ title: "Title", message: "Body", severity: "normal" }),
    Error,
  );
  assertEquals(error.message.includes("secret/topic"), false);
  assertEquals(error.message.includes("bearer-secret"), false);
});
