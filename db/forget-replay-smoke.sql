-- Checks db/forget-replay-fixture.sql after scripts/ci/db_init_schema_smoke.sh
-- has replayed the documented upgrade migrations over it, then removes it.
-- The replay itself must have completed (every file under ON_ERROR_STOP);
-- this proves it kept the retained history and the forgotten/live pair, and
-- that forget/restore still work on the replayed catalog.

\set ON_ERROR_STOP on

DO $$
DECLARE
  history TEXT[];
BEGIN
  SELECT array_agg(change_kind ORDER BY revision) INTO history
  FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-4000-8000-0000000017a1';
  IF history IS DISTINCT FROM ARRAY['forget', 'restore'] THEN
    RAISE EXCEPTION 'replay lost the restored thought''s history: %', history;
  END IF;
  SELECT array_agg(change_kind ORDER BY revision) INTO history
  FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-4000-8000-0000000017a2';
  IF history IS DISTINCT FROM ARRAY['forget'] THEN
    RAISE EXCEPTION 'replay lost the forgotten thought''s history: %', history;
  END IF;
  IF (
    SELECT array_agg(id::text || ':' || (forgotten_at IS NULL)::text ORDER BY id)
    FROM public.thoughts WHERE workspace_id = '__forget_replay'
  ) IS DISTINCT FROM ARRAY[
    '00000000-0000-4000-8000-0000000017a1:true',
    '00000000-0000-4000-8000-0000000017a2:false',
    '00000000-0000-4000-8000-0000000017a3:true'
  ] THEN
    RAISE EXCEPTION 'replay changed which fixture thoughts are forgotten';
  END IF;
END;
$$;

BEGIN;
SET LOCAL ROLE openbrain_app;
SELECT
  set_config('openbrain.workspace_id', '__forget_replay', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE
  restored RECORD;
  outcome TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.thoughts
    WHERE id = '00000000-0000-4000-8000-0000000017a2'
  ) THEN
    RAISE EXCEPTION 'the forgotten thought is visible to the app after replay';
  END IF;
  SELECT * INTO restored FROM memory_scope.restore_thought(
    '00000000-0000-4000-8000-0000000017a2', 'tailnet', NULL);
  IF restored.outcome IS DISTINCT FROM 'conflict'
     OR restored.conflict_thought_id
       IS DISTINCT FROM '00000000-0000-4000-8000-0000000017a3' THEN
    RAISE EXCEPTION 'restore beside the live copy must conflict: %', restored;
  END IF;
  SELECT f.outcome INTO outcome FROM memory_scope.forget_thought(
    '00000000-0000-4000-8000-0000000017a3', 'tailnet', NULL) AS f;
  IF outcome IS DISTINCT FROM 'forgotten' THEN
    RAISE EXCEPTION 'forget on the replayed catalog returned %', outcome;
  END IF;
  SELECT r.outcome INTO outcome FROM memory_scope.restore_thought(
    '00000000-0000-4000-8000-0000000017a2', 'tailnet', NULL) AS r;
  IF outcome IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'restore on the replayed catalog returned %', outcome;
  END IF;
END;
$$;
COMMIT;

DELETE FROM public.thoughts WHERE workspace_id = '__forget_replay';
DELETE FROM memory_scope.workspace WHERE id = '__forget_replay';
