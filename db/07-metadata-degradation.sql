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
  thought_id      UUID NOT NULL REFERENCES thoughts(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS idx_metadata_degradation_thought_ts
  ON metadata_degradation_events (thought_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_degradation_type_ts
  ON metadata_degradation_events (event_type, created_at DESC);

-- One durable cursor/cooldown row coordinates every server process. A worker
-- takes FOR UPDATE SKIP LOCKED before reading/updating it, so replicas cannot
-- deliver the same batch concurrently. `pending_counts` contains only finite
-- event/reason keys and integer counts; no request or thought data enters it.
CREATE TABLE IF NOT EXISTS metadata_degradation_notification_state (
  singleton             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_event_id         BIGINT NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
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
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO metadata_degradation_notification_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Re-applying the ordered migrations after 01-schema.sql must restore exactly
-- these narrow privileges: append/read audit history, mutate only the delivery
-- ledger, and never delete either relation.
REVOKE ALL ON metadata_degradation_events
  FROM openbrain_app;
REVOKE ALL ON metadata_degradation_notification_state
  FROM openbrain_app;
REVOKE ALL ON SEQUENCE metadata_degradation_events_id_seq
  FROM openbrain_app;

GRANT SELECT, INSERT ON metadata_degradation_events
  TO openbrain_app;
GRANT SELECT, UPDATE ON metadata_degradation_notification_state
  TO openbrain_app;
GRANT USAGE ON SEQUENCE metadata_degradation_events_id_seq
  TO openbrain_app;

-- The trusted backup/inspection role intentionally sees the content-free audit
-- rows and must be able to dump the BIGSERIAL sequence state.
GRANT SELECT ON metadata_degradation_events
  TO openbrain_readonly;
GRANT SELECT ON metadata_degradation_notification_state
  TO openbrain_readonly;
GRANT SELECT ON SEQUENCE metadata_degradation_events_id_seq
  TO openbrain_readonly;

COMMIT;
