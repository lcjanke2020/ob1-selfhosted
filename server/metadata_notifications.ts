// Durable, content-free metadata-degradation notifications.
//
// Capture writes finite event codes to metadata_degradation_events. This
// worker polls those rows, coordinates replicas through one locked ledger row,
// and delivers first-occurrence alerts plus periodic rollups. It never selects
// thoughts.content (or any request data), so a future payload edit cannot
// accidentally quote the thought that triggered the alert.

import type { Pool, PoolClient } from "postgres";
import { getClient } from "./db_pool.ts";

export type MetadataNotificationSeverity = "normal" | "high";

export type MetadataNotification = {
  title: string;
  message: string;
  severity: MetadataNotificationSeverity;
};

export interface MetadataNotificationAdapter {
  readonly name: "pushover" | "ntfy";
  send(notification: MetadataNotification): Promise<void>;
}

type FetchLike = typeof fetch;

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Status is authoritative. Body cleanup must not replace it with a less
    // useful error (or surface a provider response that may echo secrets).
  }
}

async function boundedFetch(
  fetchFn: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  adapterName: MetadataNotificationAdapter["name"],
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } catch {
    // Deliberately discard the underlying fetch message: ntfy topics and
    // tokens are credentials, and runtimes commonly include the URL in it.
    throw new Error(`${adapterName} request failed or timed out`);
  } finally {
    clearTimeout(timer);
  }
}

export class PushoverMetadataNotificationAdapter
  implements MetadataNotificationAdapter {
  readonly name = "pushover" as const;

  constructor(
    private readonly token: string,
    private readonly user: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async send(notification: MetadataNotification): Promise<void> {
    const body = new URLSearchParams({
      token: this.token,
      user: this.user,
      title: notification.title,
      message: notification.message,
      priority: notification.severity === "high" ? "1" : "0",
    });
    const response = await boundedFetch(
      this.fetchFn,
      "https://api.pushover.net/1/messages.json",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      this.timeoutMs,
      this.name,
    );
    const status = response.status;
    await cancelBody(response);
    if (!response.ok) {
      throw new Error(`pushover returned HTTP ${status}`);
    }
  }
}

export class NtfyMetadataNotificationAdapter
  implements MetadataNotificationAdapter {
  readonly name = "ntfy" as const;

  constructor(
    serverUrl: string,
    private readonly topic: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
  }

  private readonly serverUrl: string;

  async send(notification: MetadataNotification): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      title: notification.title,
      priority: notification.severity === "high" ? "urgent" : "high",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await boundedFetch(
      this.fetchFn,
      `${this.serverUrl}/${encodeURIComponent(this.topic)}`,
      { method: "POST", headers, body: notification.message },
      this.timeoutMs,
      this.name,
    );
    const status = response.status;
    await cancelBody(response);
    if (!response.ok) throw new Error(`ntfy returned HTTP ${status}`);
  }
}

const PRIMARY_REASONS = [
  "transport_or_timeout",
  "non_2xx",
  "invalid_response",
  "unparseable_output",
  "schema_rejection",
] as const;

type PrimaryFailureReason = typeof PRIMARY_REASONS[number];
type TriggerEventType = "primary_failure" | "fallback_used" | "stub_used";

const COUNT_KEYS = [
  ...PRIMARY_REASONS.map((reason) => `primary_failure.${reason}`),
  "fallback_used",
  "stub_used",
] as const;

type CountKey = typeof COUNT_KEYS[number];
export type MetadataNotificationCounts = Partial<Record<CountKey, number>>;

const COUNT_KEY_SET = new Set<string>(COUNT_KEYS);
const TRIGGER_EVENT_TYPES = new Set<TriggerEventType>([
  "primary_failure",
  "fallback_used",
  "stub_used",
]);

function normalizedCounts(value: unknown): MetadataNotificationCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "metadata notification ledger pending_counts is not an object",
    );
  }
  const counts: MetadataNotificationCounts = {};
  for (const [key, count] of Object.entries(value)) {
    if (
      !COUNT_KEY_SET.has(key) || !Number.isSafeInteger(count) ||
      (count as number) < 0
    ) {
      throw new Error("metadata notification ledger contains invalid counts");
    }
    if ((count as number) > 0) counts[key as CountKey] = count as number;
  }
  return counts;
}

function increment(
  counts: MetadataNotificationCounts,
  key: CountKey,
  amount = 1,
): void {
  const next = (counts[key] ?? 0) + amount;
  if (!Number.isSafeInteger(next)) {
    throw new Error("metadata notification count overflow");
  }
  counts[key] = next;
}

function triggerTypesIn(
  counts: MetadataNotificationCounts,
): TriggerEventType[] {
  const types = new Set<TriggerEventType>();
  for (const [key, count] of Object.entries(counts)) {
    if (!count) continue;
    types.add(
      key.startsWith("primary_failure.")
        ? "primary_failure"
        : key as TriggerEventType,
    );
  }
  return [...types];
}

function totalFor(
  counts: MetadataNotificationCounts,
  eventType: TriggerEventType,
): number {
  if (eventType !== "primary_failure") return counts[eventType] ?? 0;
  return PRIMARY_REASONS.reduce(
    (sum, reason) => sum + (counts[`primary_failure.${reason}`] ?? 0),
    0,
  );
}

const REASON_LABELS: Record<PrimaryFailureReason, string> = {
  transport_or_timeout: "transport/timeout",
  non_2xx: "non-2xx response",
  invalid_response: "invalid response",
  unparseable_output: "unparseable output",
  schema_rejection: "schema rejection",
};

export function buildMetadataNotification(
  counts: MetadataNotificationCounts,
  label: string,
  now: Date,
): MetadataNotification {
  const fallback = totalFor(counts, "fallback_used");
  const stub = totalFor(counts, "stub_used");
  const primary = totalFor(counts, "primary_failure");
  const lines = [
    `Metadata classification degraded for ${label}.`,
    `Window ending: ${now.toISOString()}`,
    `Fallback classifications: ${fallback}`,
    `Stub classifications: ${stub}`,
    `Primary failures: ${primary}`,
  ];
  for (const reason of PRIMARY_REASONS) {
    const count = counts[`primary_failure.${reason}`] ?? 0;
    if (count > 0) lines.push(`- ${REASON_LABELS[reason]}: ${count}`);
  }
  lines.push("No thought content is included in this alert.");
  return {
    // ntfy carries this in an HTTP header. Keep the fixed title ASCII; the
    // operator label stays in the UTF-8 body where arbitrary Unicode is safe.
    title: "OpenBrain metadata alert",
    message: lines.join("\n"),
    severity: fallback > 0 ? "high" : "normal",
  };
}

type LedgerRow = {
  last_event_id: string;
  pending_counts: unknown;
  notified_event_types: string[];
  last_notified_at_ms: string | null;
};

type EventRow = {
  id: string;
  event_type: string;
  failure_reason: string | null;
};

export type MetadataNotificationCycleOptions = {
  label: string;
  rollupMs: number;
  batchSize?: number;
  now?: () => Date;
};

export type MetadataNotificationCycleResult =
  | { outcome: "locked" | "idle"; processed: number }
  | { outcome: "queued" | "delivered" | "delivery_failed"; processed: number };

async function deliver(
  adapters: MetadataNotificationAdapter[],
  notification: MetadataNotification,
): Promise<boolean> {
  const outcomes = await Promise.all(adapters.map(async (adapter) => {
    try {
      await adapter.send(notification);
      return true;
    } catch {
      // Adapter implementations intentionally redact underlying request errors.
      // Keep this log equally sparse so topic/token/user values cannot escape.
      console.warn(`[metadata_notify] ${adapter.name} delivery failed`);
      return false;
    }
  }));
  return outcomes.some(Boolean);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.queryArray("ROLLBACK");
  } catch { /* preserve the original error */ }
}

export async function runMetadataNotificationCycle(
  pool: Pool,
  adapters: MetadataNotificationAdapter[],
  options: MetadataNotificationCycleOptions,
): Promise<MetadataNotificationCycleResult> {
  if (adapters.length === 0) return { outcome: "idle", processed: 0 };
  const now = options.now?.() ?? new Date();
  const batchSize = options.batchSize ?? 10_000;
  const client = await getClient(pool);
  let transactionOpen = false;
  try {
    await client.queryArray("BEGIN");
    transactionOpen = true;
    const ledgerResult = await client.queryObject<LedgerRow>(
      `SELECT
         last_event_id::text AS last_event_id,
         pending_counts,
         notified_event_types,
         CASE WHEN last_notified_at IS NULL THEN NULL
              ELSE (extract(epoch FROM last_notified_at) * 1000)::bigint::text
         END AS last_notified_at_ms
       FROM metadata_degradation_notification_state
       WHERE singleton
       FOR UPDATE SKIP LOCKED`,
    );
    const ledger = ledgerResult.rows[0];
    if (!ledger) {
      // SKIP LOCKED and a missing singleton both return no row. Distinguish
      // them so a post-boot schema/state deletion cannot turn monitoring off
      // silently while ordinary replica contention remains a cheap no-op.
      const stateExists = await client.queryArray<[boolean]>(
        `SELECT EXISTS (
           SELECT 1
           FROM metadata_degradation_notification_state
           WHERE singleton
         )`,
      );
      if (stateExists.rows[0]?.[0] !== true) {
        throw new Error("metadata notification ledger singleton is missing");
      }
      await client.queryArray("COMMIT");
      transactionOpen = false;
      return { outcome: "locked", processed: 0 };
    }

    const counts = normalizedCounts(ledger.pending_counts);
    const notifiedTypes = new Set<TriggerEventType>();
    for (const eventType of ledger.notified_event_types) {
      if (!TRIGGER_EVENT_TYPES.has(eventType as TriggerEventType)) {
        throw new Error(
          "metadata notification ledger contains an invalid event type",
        );
      }
      notifiedTypes.add(eventType as TriggerEventType);
    }

    const eventResult = await client.queryObject<EventRow>(
      `SELECT id::text AS id, event_type, failure_reason
       FROM metadata_degradation_events
       WHERE id > $1::bigint
       ORDER BY id
       LIMIT $2`,
      [ledger.last_event_id, batchSize],
    );
    let lastEventId = ledger.last_event_id;
    for (const event of eventResult.rows) {
      lastEventId = event.id;
      if (event.event_type === "primary_failure") {
        if (
          !PRIMARY_REASONS.includes(
            event.failure_reason as PrimaryFailureReason,
          )
        ) {
          throw new Error(
            "metadata degradation event has an invalid primary failure reason",
          );
        }
        increment(
          counts,
          `primary_failure.${event.failure_reason}` as CountKey,
        );
      } else if (event.event_type === "fallback_used") {
        increment(counts, "fallback_used");
      } else if (event.event_type === "stub_used") {
        increment(counts, "stub_used");
      } else if (event.event_type !== "fallback_failure") {
        throw new Error("metadata degradation event has an invalid event type");
      }
    }

    const pendingTypes = triggerTypesIn(counts);
    const firstOccurrence = pendingTypes.some((type) =>
      !notifiedTypes.has(type)
    );
    const lastNotifiedMs = ledger.last_notified_at_ms === null
      ? null
      : Number(ledger.last_notified_at_ms);
    if (lastNotifiedMs !== null && !Number.isFinite(lastNotifiedMs)) {
      throw new Error("metadata notification ledger has an invalid timestamp");
    }
    const cooldownElapsed = lastNotifiedMs === null ||
      now.getTime() - lastNotifiedMs >= options.rollupMs;
    const shouldDeliver = pendingTypes.length > 0 &&
      (firstOccurrence || cooldownElapsed);

    let delivered = false;
    if (shouldDeliver) {
      delivered = await deliver(
        adapters,
        buildMetadataNotification(counts, options.label, now),
      );
    }

    const persistedCounts = delivered ? {} : counts;
    if (delivered) {
      for (const type of pendingTypes) notifiedTypes.add(type);
    }
    await client.queryArray(
      `UPDATE metadata_degradation_notification_state
       SET last_event_id = $1::bigint,
           pending_counts = $2::jsonb,
           notified_event_types = $3::text[],
           last_notified_at = COALESCE($4::timestamptz, last_notified_at),
           updated_at = now()
       WHERE singleton`,
      [
        lastEventId,
        JSON.stringify(persistedCounts),
        [...notifiedTypes].sort(),
        delivered ? now.toISOString() : null,
      ],
    );
    await client.queryArray("COMMIT");
    transactionOpen = false;

    if (delivered) {
      return { outcome: "delivered", processed: eventResult.rows.length };
    }
    if (shouldDeliver) {
      return { outcome: "delivery_failed", processed: eventResult.rows.length };
    }
    if (pendingTypes.length > 0) {
      return { outcome: "queued", processed: eventResult.rows.length };
    }
    return { outcome: "idle", processed: eventResult.rows.length };
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export type MetadataNotificationWorker = {
  stop(): Promise<void>;
};

export function startMetadataNotificationWorker(
  pool: Pool,
  adapters: MetadataNotificationAdapter[],
  options: MetadataNotificationCycleOptions & { pollIntervalMs: number },
): MetadataNotificationWorker {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = runMetadataNotificationCycle(pool, adapters, options)
        .then((result) => {
          if (result.outcome === "delivered") {
            console.log(
              `[metadata_notify] delivered durable alert batch (${result.processed} new events scanned)`,
            );
          }
        })
        .catch((error) => {
          console.warn(
            `[metadata_notify] cycle failed: ${(error as Error).message}`,
          );
        })
        .finally(() => {
          active = null;
          schedule(options.pollIntervalMs);
        });
    }, delayMs);
  };

  schedule(0);
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await active;
    },
  };
}
