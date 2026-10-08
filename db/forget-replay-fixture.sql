-- Fixture for the documented-upgrade replay regression in
-- scripts/ci/db_init_schema_smoke.sh. Leaves the state an upgrade replay
-- meets once forget_thought has been used, created through the real helpers
-- as openbrain_app:
--
--   R  forgotten, then restored: live, with retained forget + restore
--      revisions (the pre-17 change-kind CHECK rejects both kinds);
--   F  forgotten, with a retained forget revision;
--   L  the same text as F captured again: a live row beside the forgotten
--      one (the pre-17 fingerprint index rejects the pair).
--
-- db/forget-replay-smoke.sql checks the fixture after the replay and
-- removes it. Never apply this to a real corpus.

\set ON_ERROR_STOP on

DELETE FROM public.thoughts WHERE workspace_id = '__forget_replay';
DELETE FROM memory_scope.workspace WHERE id = '__forget_replay';
INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES (
  '__forget_replay',
  'Ephemeral db/forget-replay-fixture.sql fixture',
  'workspace',
  false
);

BEGIN;
SET LOCAL ROLE openbrain_app;
SELECT
  set_config('openbrain.workspace_id', '__forget_replay', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);

INSERT INTO public.thoughts (
  id, content, content_fingerprint, workspace_id, visibility
) VALUES
  (
    '00000000-0000-4000-8000-0000000017a1',
    'forget replay restored',
    encode(sha256(convert_to('forget replay restored', 'UTF8')), 'hex'),
    '__forget_replay', 'workspace'
  ),
  (
    '00000000-0000-4000-8000-0000000017a2',
    'forget replay duplicate',
    encode(sha256(convert_to('forget replay duplicate', 'UTF8')), 'hex'),
    '__forget_replay', 'workspace'
  );

DO $$
DECLARE
  outcome TEXT;
BEGIN
  SELECT f.outcome INTO outcome FROM memory_scope.forget_thought(
    '00000000-0000-4000-8000-0000000017a1', 'tailnet', NULL) AS f;
  IF outcome IS DISTINCT FROM 'forgotten' THEN
    RAISE EXCEPTION 'forget replay fixture: forget R returned %', outcome;
  END IF;
  SELECT r.outcome INTO outcome FROM memory_scope.restore_thought(
    '00000000-0000-4000-8000-0000000017a1', 'tailnet', NULL) AS r;
  IF outcome IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'forget replay fixture: restore R returned %', outcome;
  END IF;
  SELECT f.outcome INTO outcome FROM memory_scope.forget_thought(
    '00000000-0000-4000-8000-0000000017a2', 'tailnet', NULL) AS f;
  IF outcome IS DISTINCT FROM 'forgotten' THEN
    RAISE EXCEPTION 'forget replay fixture: forget F returned %', outcome;
  END IF;
END;
$$;

-- The capture-shaped upsert: forgotten text becomes a fresh live row.
INSERT INTO public.thoughts (
  id, content, content_fingerprint, workspace_id, visibility
) VALUES (
  '00000000-0000-4000-8000-0000000017a3',
  'forget replay duplicate',
  encode(sha256(convert_to('forget replay duplicate', 'UTF8')), 'hex'),
  '__forget_replay', 'workspace'
)
ON CONFLICT (workspace_id, project_id, visibility, owner_subject, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL AND forgotten_at IS NULL
DO UPDATE SET updated_at = now();
COMMIT;
