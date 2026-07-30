-- Recreate the incomplete live shape produced when the round-two preview was
-- applied over the first preview: the old ledger/FK remained, while the new
-- outbox existed without queue timestamps or historical backfill. The DB-init
-- workflow applies current migration 07 and proves that it converges safely.

\set ON_ERROR_STOP on

BEGIN;

DROP TABLE public.metadata_degradation_outbox;

CREATE TABLE public.metadata_degradation_outbox (
  event_id BIGINT PRIMARY KEY
             REFERENCES public.metadata_degradation_events(id) ON DELETE CASCADE
);

ALTER TABLE public.metadata_degradation_events
  DROP CONSTRAINT IF EXISTS metadata_degradation_events_thought_id_fkey;
ALTER TABLE public.metadata_degradation_events
  ALTER COLUMN thought_id SET NOT NULL;
ALTER TABLE public.metadata_degradation_events
  ADD CONSTRAINT metadata_degradation_events_thought_id_fkey
  FOREIGN KEY (thought_id) REFERENCES public.thoughts(id) ON DELETE RESTRICT;

ALTER TABLE public.metadata_degradation_notification_state
  DROP COLUMN IF EXISTS last_delivery_attempt_at,
  DROP COLUMN IF EXISTS last_failed_channels;
ALTER TABLE public.metadata_degradation_notification_state
  ADD COLUMN last_event_id BIGINT NOT NULL DEFAULT 0
    CHECK (last_event_id >= 0);

INSERT INTO public.thoughts (
  id, content, embedding, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000751',
  'metadata degradation preview-upgrade fixture',
  array_fill(0.0::real, ARRAY[768])::vector,
  '{}'::jsonb,
  digest('metadata degradation preview-upgrade fixture', 'sha256'),
  'default', NULL, 'workspace', NULL
);

INSERT INTO public.metadata_degradation_events (
  thought_id, capture_id, event_type, endpoint_role, failure_reason,
  http_status, endpoint_model, endpoint_base_url, created_at
) VALUES
  (
    '00000000-0000-0000-0000-000000000751',
    '00000000-0000-0000-0000-000000000752',
    'fallback_used', 'fallback', NULL, NULL,
    'preview-fallback', 'https://fallback.example/v1',
    '2026-07-29T00:00:00Z'
  ),
  (
    '00000000-0000-0000-0000-000000000751',
    '00000000-0000-0000-0000-000000000753',
    'stub_used', NULL, NULL, NULL, NULL, NULL,
    '2026-07-29T00:01:00Z'
  );

-- Model a post-round-two capture: this event reached the old outbox, but the
-- older fallback history above did not. Neither row may be lost on upgrade.
INSERT INTO public.metadata_degradation_outbox (event_id)
SELECT id
FROM public.metadata_degradation_events
WHERE capture_id = '00000000-0000-0000-0000-000000000753';

UPDATE public.metadata_degradation_notification_state
SET last_event_id = (
      SELECT max(id) FROM public.metadata_degradation_events
    ),
    pending_counts = '{"stub_used": 2}'::jsonb,
    notified_event_types = ARRAY['stub_used']::text[],
    last_notified_at = '2026-07-29T00:05:00Z',
    updated_at = now()
WHERE singleton;

COMMIT;
