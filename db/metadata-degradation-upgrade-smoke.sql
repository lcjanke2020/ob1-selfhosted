-- Assertions and cleanup after current migration 07 is applied over
-- metadata-degradation-legacy-fixture.sql.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  required_state_columns integer;
  queued_events integer;
  pending jsonb;
BEGIN
  SELECT count(*) INTO required_state_columns
  FROM pg_attribute
  WHERE attrelid =
          'public.metadata_degradation_notification_state'::regclass
    AND attname::text = ANY(ARRAY[
      'singleton',
      'pending_counts',
      'notified_event_types',
      'last_notified_at',
      'last_delivery_attempt_at',
      'last_failed_channels',
      'updated_at'
    ])
    AND attnum > 0
    AND NOT attisdropped;
  IF required_state_columns <> 7 THEN
    RAISE EXCEPTION
      'preview upgrade expected 7 ledger columns, found %',
      required_state_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid =
            'public.metadata_degradation_notification_state'::regclass
      AND attname = 'last_event_id'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'preview upgrade left legacy last_event_id behind';
  END IF;

  SELECT count(*) INTO queued_events
  FROM public.metadata_degradation_outbox AS outbox
  JOIN public.metadata_degradation_events AS event
    ON event.id = outbox.event_id
  WHERE event.capture_id = ANY(ARRAY[
      '00000000-0000-0000-0000-000000000752'::uuid,
      '00000000-0000-0000-0000-000000000753'::uuid
    ])
    AND outbox.created_at = event.created_at;
  IF queued_events <> 2 THEN
    RAISE EXCEPTION
      'preview upgrade expected two timestamped queued events, found %',
      queued_events;
  END IF;

  SELECT pending_counts INTO pending
  FROM public.metadata_degradation_notification_state
  WHERE singleton;
  IF pending <> '{}'::jsonb THEN
    RAISE EXCEPTION
      'preview upgrade expected old aggregate counts to reset, found %', pending;
  END IF;

  IF COALESCE((
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'public.metadata_degradation_events'::regclass
      AND attname = 'thought_id'
      AND attnum > 0
      AND NOT attisdropped
  ), true) THEN
    RAISE EXCEPTION 'preview upgrade left thought_id NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.metadata_degradation_events'::regclass
      AND conname = 'metadata_degradation_events_thought_id_fkey'
      AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'preview upgrade did not install ON DELETE SET NULL';
  END IF;

  BEGIN
    UPDATE public.metadata_degradation_notification_state
    SET last_failed_channels = ARRAY['unknown-provider']::text[]
    WHERE singleton;
    RAISE EXCEPTION 'preview upgrade did not enforce failed-channel shape';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

DELETE FROM public.thoughts
WHERE id = '00000000-0000-0000-0000-000000000751';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.metadata_degradation_events
    WHERE capture_id = ANY(ARRAY[
        '00000000-0000-0000-0000-000000000752'::uuid,
        '00000000-0000-0000-0000-000000000753'::uuid
      ])
      AND thought_id IS NULL
    GROUP BY thought_id
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION
      'preview-upgraded audit did not detach after owner thought deletion';
  END IF;
END;
$$;

DELETE FROM public.metadata_degradation_events
WHERE capture_id = ANY(ARRAY[
    '00000000-0000-0000-0000-000000000752'::uuid,
    '00000000-0000-0000-0000-000000000753'::uuid
  ]);

UPDATE public.metadata_degradation_notification_state
SET pending_counts = '{}'::jsonb,
    notified_event_types = '{}'::text[],
    last_notified_at = NULL,
    last_delivery_attempt_at = NULL,
    last_failed_channels = '{}'::text[],
    updated_at = now()
WHERE singleton;

COMMIT;
