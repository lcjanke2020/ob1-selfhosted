-- Durable metadata-classification degradation audit + notification ledger.
--
-- This migration intentionally stores no thought content, API-key environment
-- value, notification credential, or endpoint URL userinfo/query/fragment.
-- `thought_id` links an event to the corpus; `capture_id` groups the finite
-- events emitted by one capture attempt. The application role can append and
-- read events but cannot rewrite history. Credential-scrubbed endpoint bases
-- remain auditable across configuration changes.
--
-- Existing deployments must apply this file as the database owner before
-- starting a server version that requires it, then run
-- db/03-grants-assertion.sql last. Fresh Compose installs mount it as 07.

BEGIN;

CREATE TABLE IF NOT EXISTS metadata_degradation_events (
  id              BIGSERIAL PRIMARY KEY,
  -- Capture always supplies a thought id. NULL is the tombstone left only when
  -- a database owner later deletes that thought; the app cannot update history.
  thought_id      UUID REFERENCES thoughts(id) ON DELETE SET NULL,
  capture_id      UUID NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'primary_failure',
                    'fallback_failure',
                    'fallback_used',
                    'stub_used'
                  )),
  endpoint_role   TEXT CHECK (endpoint_role IN ('primary', 'fallback')),
  failure_reason  TEXT CHECK (failure_reason IN (
                    'transport_or_timeout',
                    'non_2xx',
                    'invalid_response',
                    'unparseable_output',
                    'schema_rejection'
                  )),
  http_status       SMALLINT,
  endpoint_model    TEXT,
  endpoint_base_url TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Keep every row self-describing. Outcome events carry no failure fields;
  -- failure events must name the matching endpoint and finite reason.
  CONSTRAINT metadata_degradation_event_shape CHECK (
    (
      event_type = 'primary_failure'
      AND endpoint_role = 'primary'
      AND failure_reason IS NOT NULL
      AND endpoint_model IS NOT NULL
      AND endpoint_base_url IS NOT NULL
    ) OR (
      event_type = 'fallback_failure'
      AND endpoint_role = 'fallback'
      AND failure_reason IS NOT NULL
      AND endpoint_model IS NOT NULL
      AND endpoint_base_url IS NOT NULL
    ) OR (
      event_type = 'fallback_used'
      AND endpoint_role = 'fallback'
      AND failure_reason IS NULL
      AND endpoint_model IS NOT NULL
      AND endpoint_base_url IS NOT NULL
    ) OR (
      event_type = 'stub_used'
      AND endpoint_role IS NULL
      AND failure_reason IS NULL
      AND endpoint_model IS NULL
      AND endpoint_base_url IS NULL
    )
  ),
  CONSTRAINT metadata_degradation_http_status_shape CHECK (
    (
      failure_reason = 'non_2xx'
      AND http_status BETWEEN 100 AND 599
    ) OR (
      failure_reason IS DISTINCT FROM 'non_2xx'
      AND http_status IS NULL
    )
  )
);

-- `CREATE TABLE IF NOT EXISTS` does not update a table created by an earlier
-- preview of this migration. Converge that preview's restrictive, NOT NULL
-- link to the current deletion-safe contract without rebuilding history.
ALTER TABLE metadata_degradation_events
  ALTER COLUMN thought_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.metadata_degradation_events'::regclass
      AND conname = 'metadata_degradation_events_thought_id_fkey'
      AND confdeltype = 'n' -- ON DELETE SET NULL
  ) THEN
    ALTER TABLE metadata_degradation_events
      DROP CONSTRAINT IF EXISTS metadata_degradation_events_thought_id_fkey;
    ALTER TABLE metadata_degradation_events
      ADD CONSTRAINT metadata_degradation_events_thought_id_fkey
      FOREIGN KEY (thought_id) REFERENCES thoughts(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_metadata_degradation_thought_ts
  ON metadata_degradation_events (thought_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_degradation_type_ts
  ON metadata_degradation_events (event_type, created_at DESC);

-- A transactional outbox separates commit visibility from BIGSERIAL order.
-- Capture inserts this row in the same transaction as its immutable history
-- row. The worker deletes only committed queue rows; rollback restores a claim,
-- so an older transaction that commits after a newer event can never be skipped.
CREATE TABLE IF NOT EXISTS metadata_degradation_outbox (
  event_id BIGINT PRIMARY KEY
             REFERENCES metadata_degradation_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE metadata_degradation_outbox
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Preserve meaningful queue age when upgrading the round-two preview, whose
-- outbox existed without this column. Every queued id has immutable history.
UPDATE metadata_degradation_outbox AS outbox
SET created_at = event.created_at
FROM metadata_degradation_events AS event
WHERE event.id = outbox.event_id
  AND outbox.created_at IS NULL;

ALTER TABLE metadata_degradation_outbox
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_metadata_degradation_outbox_created_at
  ON metadata_degradation_outbox (created_at, event_id);

-- One durable cooldown/count row coordinates every server process. A worker
-- takes FOR UPDATE SKIP LOCKED on this singleton before claiming outbox rows,
-- so replicas cannot deliver the same batch concurrently. `pending_counts`
-- contains only finite event/reason keys and integer counts; no request or
-- thought data enters it.
CREATE TABLE IF NOT EXISTS metadata_degradation_notification_state (
  singleton             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  pending_counts        JSONB NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(pending_counts) = 'object'),
  notified_event_types  TEXT[] NOT NULL DEFAULT '{}'::text[]
                          CHECK (
                            notified_event_types <@ ARRAY[
                              'primary_failure',
                              'fallback_used',
                              'stub_used'
                            ]::text[]
                          ),
  last_notified_at      TIMESTAMPTZ,
  last_delivery_attempt_at TIMESTAMPTZ,
  last_failed_channels  TEXT[] NOT NULL DEFAULT '{}'::text[]
                          CONSTRAINT metadata_degradation_failed_channels_shape
                          CHECK (
                            last_failed_channels <@ ARRAY[
                              'pushover',
                              'ntfy'
                            ]::text[]
                          ),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE metadata_degradation_notification_state
  ADD COLUMN IF NOT EXISTS last_delivery_attempt_at TIMESTAMPTZ;

ALTER TABLE metadata_degradation_notification_state
  ADD COLUMN IF NOT EXISTS last_failed_channels TEXT[]
    NOT NULL DEFAULT '{}'::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid =
            'public.metadata_degradation_notification_state'::regclass
      AND conname = 'metadata_degradation_failed_channels_shape'
  ) THEN
    ALTER TABLE metadata_degradation_notification_state
      ADD CONSTRAINT metadata_degradation_failed_channels_shape
      CHECK (
        last_failed_channels <@ ARRAY['pushover', 'ntfy']::text[]
      );
  END IF;
END;
$$;

INSERT INTO metadata_degradation_notification_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Migrate the preview revision's sequence cursor once. Cursor order was not
-- commit order, so no exact processed/unprocessed split can be reconstructed.
-- Requeue every immutable history row and clear its aggregated pending counts:
-- this can repeat a preview alert, but it cannot silently lose one or double
-- count a retained batch. Dropping the marker makes reapplication a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid =
            'public.metadata_degradation_notification_state'::regclass
      AND attname = 'last_event_id'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    INSERT INTO metadata_degradation_outbox (event_id, created_at)
    SELECT id, created_at
    FROM metadata_degradation_events
    ON CONFLICT (event_id) DO NOTHING;

    UPDATE metadata_degradation_notification_state
    SET pending_counts = '{}'::jsonb,
        updated_at = now()
    WHERE singleton;

    ALTER TABLE metadata_degradation_notification_state
      DROP COLUMN last_event_id;
  END IF;
END;
$$;

-- Re-applying the ordered migrations after 01-schema.sql must restore exactly
-- these narrow privileges: append/read immutable history, enqueue/consume the
-- pending-delivery outbox, and mutate only the delivery ledger.
REVOKE ALL ON metadata_degradation_events
  FROM openbrain_app;
REVOKE ALL ON metadata_degradation_outbox
  FROM openbrain_app;
REVOKE ALL ON metadata_degradation_notification_state
  FROM openbrain_app;
REVOKE ALL ON SEQUENCE metadata_degradation_events_id_seq
  FROM openbrain_app;

GRANT SELECT, INSERT ON metadata_degradation_events
  TO openbrain_app;
GRANT SELECT, INSERT, DELETE ON metadata_degradation_outbox
  TO openbrain_app;
GRANT SELECT, UPDATE ON metadata_degradation_notification_state
  TO openbrain_app;
GRANT USAGE ON SEQUENCE metadata_degradation_events_id_seq
  TO openbrain_app;

-- The trusted backup/inspection role intentionally sees the content-free audit
-- rows and must be able to dump the BIGSERIAL sequence state.
GRANT SELECT ON metadata_degradation_events
  TO openbrain_readonly;
GRANT SELECT ON metadata_degradation_outbox
  TO openbrain_readonly;
GRANT SELECT ON metadata_degradation_notification_state
  TO openbrain_readonly;
GRANT SELECT ON SEQUENCE metadata_degradation_events_id_seq
  TO openbrain_readonly;

COMMIT;
