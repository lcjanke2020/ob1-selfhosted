// Explicit CI smoke for the production metadata-notification SQL boundary.
//
// This is not a *_test.ts file: db-init.yml runs it only against its disposable,
// freshly initialized PostgreSQL container. It proves the real deno-postgres
// row types, outbox/ledger statements, app-role grants, and the commit-order
// regression that a BIGSERIAL high-water cursor would silently lose.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Pool, type PoolClient } from "postgres";
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
const lateCaptureId = "00000000-0000-0000-0000-000000000713";
const earlyCommitCaptureId = "00000000-0000-0000-0000-000000000714";
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
}, 4);

class RecordingAdapter implements MetadataNotificationAdapter {
  readonly name = "ntfy" as const;
  readonly notifications: MetadataNotification[] = [];

  send(notification: MetadataNotification): Promise<void> {
    this.notifications.push(notification);
    return Promise.resolve();
  }
}

async function installScope(client: PoolClient): Promise<void> {
  await client.queryArray(
    `SELECT
       set_config('openbrain.workspace_id', 'default', true),
       set_config('openbrain.project_id', '', true),
       set_config('openbrain.principal', '', true),
       set_config('openbrain.visibilities', 'workspace', true)`,
  );
}

type FixtureEvent =
  | "primary_failure"
  | "fallback_used"
  | "stub_used";

async function enqueueEvent(
  client: PoolClient,
  capture: string,
  eventType: FixtureEvent,
): Promise<string> {
  const primaryFailure = eventType === "primary_failure";
  const fallbackUsed = eventType === "fallback_used";
  const result = await client.queryObject<{ id: string }>(
    `WITH inserted_event AS (
       INSERT INTO metadata_degradation_events (
         thought_id, capture_id, event_type, endpoint_role, failure_reason,
         http_status, endpoint_model, endpoint_base_url
       ) VALUES (
         $1, $2, $3,
         $4, $5, NULL, $6, $7
       )
       RETURNING id
     ), queued AS (
       INSERT INTO metadata_degradation_outbox (event_id)
       SELECT id FROM inserted_event
       RETURNING event_id
     )
     SELECT event_id::text AS id FROM queued`,
    [
      thoughtId,
      capture,
      eventType,
      primaryFailure ? "primary" : fallbackUsed ? "fallback" : null,
      primaryFailure ? "transport_or_timeout" : null,
      primaryFailure ? "smoke-primary" : fallbackUsed ? "smoke-fallback" : null,
      primaryFailure
        ? "https://classifier.example/v1"
        : fallbackUsed
        ? "https://fallback.example/v1"
        : null,
    ],
  );
  const eventId = result.rows[0]?.id;
  assert(eventId, "fixture event enqueue returned no id");
  return eventId;
}

async function assertPristineFixture(): Promise<void> {
  const client = await adminPool.connect();
  try {
    const result = await client.queryObject<{
      event_count: string;
      outbox_count: string;
      fixture_thought_count: string;
      pending_counts: Record<string, number>;
      notified_event_types: string[];
      last_notified_at: string | null;
      last_delivery_attempt_at: string | null;
      last_failed_channels: string[];
    }>(
      `SELECT
         (SELECT count(*)::text FROM metadata_degradation_events) AS event_count,
         (SELECT count(*)::text FROM metadata_degradation_outbox) AS outbox_count,
         (SELECT count(*)::text FROM thoughts WHERE id = $1) AS fixture_thought_count,
         pending_counts,
         notified_event_types,
         last_notified_at::text AS last_notified_at,
         last_delivery_attempt_at::text AS last_delivery_attempt_at,
         last_failed_channels
       FROM metadata_degradation_notification_state
       WHERE singleton`,
      [thoughtId],
    );
    assertEquals(result.rows, [{
      event_count: "0",
      outbox_count: "0",
      fixture_thought_count: "0",
      pending_counts: {},
      notified_event_types: [],
      last_notified_at: null,
      last_delivery_attempt_at: null,
      last_failed_channels: [],
    }], "db-init notification fixture must start pristine");
  } finally {
    client.release();
  }
}

async function seedThoughtAndPrimaryEvent(): Promise<void> {
  const admin = await adminPool.connect();
  try {
    await admin.queryArray(
      `INSERT INTO thoughts (
         id, content, metadata, content_fingerprint,
         workspace_id, project_id, visibility, owner_subject
       ) VALUES ($1, $2, '{"_metadata_notification_smoke":true}'::jsonb,
                 'metadata-notification-worker-smoke',
                 'default', NULL, 'workspace', NULL)`,
      [thoughtId, fixtureContent],
    );
  } finally {
    admin.release();
  }

  const app = await appPool.connect();
  try {
    await app.queryArray("BEGIN");
    await installScope(app);
    await enqueueEvent(app, captureId, "primary_failure");
    await app.queryArray("COMMIT");
  } catch (error) {
    await app.queryArray("ROLLBACK");
    throw error;
  } finally {
    app.release();
  }
}

async function cleanFixture(): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.queryArray(
      `DELETE FROM metadata_degradation_events
       WHERE capture_id = ANY($1::uuid[])`,
      [[captureId, lateCaptureId, earlyCommitCaptureId]],
    );
    await client.queryArray("DELETE FROM thoughts WHERE id = $1", [thoughtId]);
    await client.queryArray(
      `UPDATE metadata_degradation_notification_state
       SET pending_counts = '{}'::jsonb,
           notified_event_types = '{}'::text[],
           last_notified_at = NULL,
           last_delivery_attempt_at = NULL,
           last_failed_channels = '{}'::text[],
           updated_at = now()
       WHERE singleton`,
    );
  } finally {
    client.release();
  }
}

let seedAttempted = false;
let lateClient: PoolClient | null = null;
let lateTransactionOpen = false;
try {
  await assertPristineFixture();
  seedAttempted = true;
  await seedThoughtAndPrimaryEvent();

  const adapter = new RecordingAdapter();
  const first = await runMetadataNotificationCycle(appPool, [adapter], {
    label: "CI fixture",
    rollupMs: 1_800_000,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });
  assertEquals(first, { outcome: "delivered", processed: 1 });
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

  // Regression: allocate the older id in a transaction that stays open, commit
  // a newer id first, and poll between commits. A sequence cursor loses the
  // older fallback forever; the transactional outbox consumes it next cycle.
  lateClient = await appPool.connect();
  await lateClient.queryArray("BEGIN");
  lateTransactionOpen = true;
  await installScope(lateClient);
  const lateFallbackId = await enqueueEvent(
    lateClient,
    lateCaptureId,
    "fallback_used",
  );

  const earlyClient = await appPool.connect();
  let earlyCommitId: string;
  try {
    await earlyClient.queryArray("BEGIN");
    await installScope(earlyClient);
    earlyCommitId = await enqueueEvent(
      earlyClient,
      earlyCommitCaptureId,
      "stub_used",
    );
    await earlyClient.queryArray("COMMIT");
  } catch (error) {
    await earlyClient.queryArray("ROLLBACK");
    throw error;
  } finally {
    earlyClient.release();
  }
  assert(
    BigInt(lateFallbackId) < BigInt(earlyCommitId),
    "late transaction must own the older sequence id",
  );

  const betweenCommits = await runMetadataNotificationCycle(
    appPool,
    [adapter],
    {
      label: "CI fixture",
      rollupMs: 1_800_000,
      now: () => new Date("2026-07-29T12:01:00.000Z"),
    },
  );
  assertEquals(betweenCommits, { outcome: "delivered", processed: 1 });
  assertStringIncludes(
    adapter.notifications.at(-1)!.message,
    "Stub classifications: 1",
  );

  await lateClient.queryArray("COMMIT");
  lateTransactionOpen = false;
  lateClient.release();
  lateClient = null;

  const afterLateCommit = await runMetadataNotificationCycle(
    appPool,
    [adapter],
    {
      label: "CI fixture",
      rollupMs: 1_800_000,
      now: () => new Date("2026-07-29T12:02:00.000Z"),
    },
  );
  assertEquals(afterLateCommit, { outcome: "delivered", processed: 1 });
  assertStringIncludes(
    adapter.notifications.at(-1)!.message,
    "Fallback classifications: 1",
  );
  assertEquals(adapter.notifications.length, 3);

  const admin = await adminPool.connect();
  try {
    const ledger = await admin.queryObject<{
      outbox_count: string;
      pending_counts: Record<string, number>;
      notified_event_types: string[];
      attempted: boolean;
      last_failed_channels: string[];
    }>(
      `SELECT
         (SELECT count(*)::text FROM metadata_degradation_outbox) AS outbox_count,
         pending_counts,
         notified_event_types,
         last_delivery_attempt_at IS NOT NULL AS attempted,
         last_failed_channels
       FROM metadata_degradation_notification_state
       WHERE singleton`,
    );
    assertEquals(ledger.rows, [{
      outbox_count: "0",
      pending_counts: {},
      notified_event_types: [
        "fallback_used",
        "primary_failure",
        "stub_used",
      ],
      attempted: true,
      last_failed_channels: [],
    }]);

    // Audit history survives owner-directed thought deletion without retaining
    // a dangling identifier or blocking a future forget/retention feature.
    await admin.queryArray("DELETE FROM thoughts WHERE id = $1", [thoughtId]);
    const detached = await admin.queryArray<[boolean]>(
      `SELECT bool_and(thought_id IS NULL)
       FROM metadata_degradation_events
       WHERE capture_id = ANY($1::uuid[])`,
      [[captureId, lateCaptureId, earlyCommitCaptureId]],
    );
    assertEquals(detached.rows, [[true]]);
  } finally {
    admin.release();
  }
} finally {
  if (lateClient) {
    try {
      if (lateTransactionOpen) await lateClient.queryArray("ROLLBACK");
    } finally {
      lateClient.release();
    }
  }
  try {
    if (seedAttempted) await cleanFixture();
  } finally {
    await Promise.all([appPool.end(), adminPool.end()]);
  }
}
