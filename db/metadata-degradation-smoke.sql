-- CI/local integration smoke for db/07-metadata-degradation.sql.
--
-- Exercises the real application role inside the same audience context used by
-- captureThought. The fixture is rolled back: this proves append/read access,
-- event-shape constraints, immutable history, and ledger update without leaving
-- a synthetic thought or moving the durable notification cursor.

\set ON_ERROR_STOP on

SET ROLE openbrain_app;
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);

INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000701',
  'metadata degradation smoke fixture',
  '{"_metadata_degradation_smoke_fixture":true}'::jsonb,
  'metadata-degradation-smoke-fingerprint',
  'default', NULL, 'workspace', NULL
);

INSERT INTO public.metadata_degradation_events (
  thought_id, capture_id, event_type, endpoint_role, failure_reason,
  http_status, endpoint_model, endpoint_base_url
) VALUES
  (
    '00000000-0000-0000-0000-000000000701',
    '00000000-0000-0000-0000-000000000702',
    'primary_failure', 'primary', 'non_2xx', 503,
    'smoke-primary', 'https://classifier.example/v1'
  ),
  (
    '00000000-0000-0000-0000-000000000701',
    '00000000-0000-0000-0000-000000000702',
    'fallback_used', 'fallback', NULL, NULL,
    'smoke-fallback', 'https://fallback.example/v1'
  );

DO $$
DECLARE
  event_count integer;
BEGIN
  SELECT count(*) INTO event_count
  FROM public.metadata_degradation_events
  WHERE capture_id = '00000000-0000-0000-0000-000000000702';
  IF event_count <> 2 THEN
    RAISE EXCEPTION 'app role expected 2 degradation events, found %', event_count;
  END IF;

  BEGIN
    EXECUTE $sql$
      UPDATE public.metadata_degradation_events
      SET endpoint_model = 'rewritten'
      WHERE capture_id = '00000000-0000-0000-0000-000000000702'
    $sql$;
    RAISE EXCEPTION 'app role unexpectedly rewrote degradation history';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE $sql$
      DELETE FROM public.metadata_degradation_events
      WHERE capture_id = '00000000-0000-0000-0000-000000000702'
    $sql$;
    RAISE EXCEPTION 'app role unexpectedly deleted degradation history';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.metadata_degradation_events (
      thought_id, capture_id, event_type, endpoint_role, failure_reason,
      http_status, endpoint_model, endpoint_base_url
    ) VALUES (
      '00000000-0000-0000-0000-000000000701',
      '00000000-0000-0000-0000-000000000703',
      'stub_used', 'fallback', NULL, NULL,
      'incoherent-model', 'https://fallback.example/v1'
    );
    RAISE EXCEPTION 'incoherent degradation event unexpectedly passed checks';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE public.metadata_degradation_notification_state
  SET pending_counts = pending_counts
  WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification ledger singleton is missing';
  END IF;
END;
$$;

ROLLBACK;
RESET ROLE;
