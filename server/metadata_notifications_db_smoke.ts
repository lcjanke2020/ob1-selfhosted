// Explicit CI smoke for the production metadata-notification SQL boundary.
//
// This is not a *_test.ts file: db-init.yml runs it only against its disposable,
// freshly initialized PostgreSQL container. It proves the real deno-postgres
// row types, lock/query/update statements, and app-role grants work together.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Pool } from "postgres";
import {
  type MetadataNotification,
  type MetadataNotificationAdapter,
  runMetadataNotificationCycle,
} from "./metadata_notifications.ts";

const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const adminPassword = Deno.env.get("POSTGRES_PASSWORD");
const appPassword = Deno.env.get("OPENBRAIN_APP_PASSWORD");

assert(adminPassword, "POSTGRES_PASSWORD is required");
assert(appPassword, "OPENBRAIN_APP_PASSWORD is required");
assert(Number.isInteger(port) && port > 0, "DB_SMOKE_PORT must be a port");

const database = "openbrain";
const thoughtId = "00000000-0000-0000-0000-000000000711";
const captureId = "00000000-0000-0000-0000-000000000712";
const fixtureContent = "metadata notification worker smoke fixture";

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

class RecordingAdapter implements MetadataNotificationAdapter {
  readonly name = "ntfy" as const;
  readonly notifications: MetadataNotification[] = [];

  send(notification: MetadataNotification): Promise<void> {
    this.notifications.push(notification);
    return Promise.resolve();
  }
}

async function assertPristineFixture(): Promise<void> {
  const client = await adminPool.connect();
  try {
    const result = await client.queryObject<{
      event_count: string;
      fixture_thought_count: string;
      last_event_id: string;
      pending_counts: Record<string, number>;
      notified_event_types: string[];
      last_notified_at: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM metadata_degradation_events) AS event_count,
         (SELECT count(*)::text FROM thoughts WHERE id = $1) AS fixture_thought_count,
         last_event_id::text AS last_event_id,
         pending_counts,
         notified_event_types,
         last_notified_at::text AS last_notified_at
       FROM metadata_degradation_notification_state
       WHERE singleton`,
      [thoughtId],
    );
    assertEquals(result.rows, [{
      event_count: "0",
      fixture_thought_count: "0",
      last_event_id: "0",
      pending_counts: {},
      notified_event_types: [],
      last_notified_at: null,
    }], "db-init notification fixture must start pristine");
  } finally {
    client.release();
  }
}

async function seedFixture(): Promise<string> {
  const client = await adminPool.connect();
  try {
    await client.queryArray(
      `INSERT INTO thoughts (
         id, content, metadata, content_fingerprint,
         workspace_id, project_id, visibility, owner_subject
       ) VALUES ($1, $2, '{"_metadata_notification_smoke":true}'::jsonb,
                 'metadata-notification-worker-smoke',
                 'default', NULL, 'workspace', NULL)`,
      [thoughtId, fixtureContent],
    );
    const event = await client.queryObject<{ id: string }>(
      `INSERT INTO metadata_degradation_events (
         thought_id, capture_id, event_type, endpoint_role, failure_reason,
         http_status, endpoint_model, endpoint_base_url
       ) VALUES ($1, $2, 'primary_failure', 'primary',
                 'transport_or_timeout', NULL,
                 'smoke-primary', 'https://classifier.example/v1')
       RETURNING id::text AS id`,
      [thoughtId, captureId],
    );
    const eventId = event.rows[0]?.id;
    assert(eventId, "fixture event insert returned no id");
    return eventId;
  } finally {
    client.release();
  }
}

async function cleanFixture(): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.queryArray(
      "DELETE FROM metadata_degradation_events WHERE capture_id = $1",
      [captureId],
    );
    await client.queryArray("DELETE FROM thoughts WHERE id = $1", [thoughtId]);
    await client.queryArray(
      `UPDATE metadata_degradation_notification_state
       SET last_event_id = 0,
           pending_counts = '{}'::jsonb,
           notified_event_types = '{}'::text[],
           last_notified_at = NULL,
           updated_at = now()
       WHERE singleton`,
    );
  } finally {
    client.release();
  }
}

let seedAttempted = false;
try {
  await assertPristineFixture();
  seedAttempted = true;
  const eventId = await seedFixture();
  const adapter = new RecordingAdapter();
  const result = await runMetadataNotificationCycle(appPool, [adapter], {
    label: "CI fixture",
    rollupMs: 1_800_000,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });

  assertEquals(result, { outcome: "delivered", processed: 1 });
  assertEquals(adapter.notifications.length, 1);
  const notification = adapter.notifications[0];
  assertStringIncludes(notification.message, "Primary failures: 1");
  assertStringIncludes(notification.message, "transport/timeout: 1");
  for (
    const forbidden of [
      fixtureContent,
      thoughtId,
      captureId,
      "smoke-primary",
      "classifier.example",
    ]
  ) {
    assertEquals(notification.message.includes(forbidden), false);
  }

  const client = await adminPool.connect();
  try {
    const ledger = await client.queryObject<{
      last_event_id: string;
      pending_counts: Record<string, number>;
      notified_event_types: string[];
    }>(
      `SELECT last_event_id::text AS last_event_id,
              pending_counts, notified_event_types
       FROM metadata_degradation_notification_state
       WHERE singleton`,
    );
    assertEquals(ledger.rows, [{
      last_event_id: eventId,
      pending_counts: {},
      notified_event_types: ["primary_failure"],
    }]);
  } finally {
    client.release();
  }
} finally {
  try {
    if (seedAttempted) await cleanFixture();
  } finally {
    await Promise.all([appPool.end(), adminPool.end()]);
  }
}
