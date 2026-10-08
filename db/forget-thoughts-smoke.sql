-- CI/local integration smoke for db/17-forget-thoughts.sql.
--
-- Runs as the database owner, switches to the real application role for the
-- assertions, and cleans up every fixture at the end. It proves the database
-- side of forget_thought/restore_thought: a forgotten row is invisible to
-- every app-role statement (reads, updates, history, embedding-index rows,
-- the RLS-bypassing candidate search and move helper), the app can neither
-- write the marker nor insert a forgotten row, the helpers act only on rows
-- the caller can read by audience and record the verified actor, re-capturing
-- forgotten text creates a fresh row, and restore reports a live duplicate —
-- stored or legacy-NULL fingerprint — as a conflict and heals a legacy NULL
-- fingerprint.

\set ON_ERROR_STOP on

-- ---------- Fixtures (owner) ------------------------------------------------

DELETE FROM public.thoughts
WHERE metadata @> '{"_forget_smoke_fixture":true}'::jsonb;
DELETE FROM memory_scope.project WHERE workspace_id = '__forget_smoke_team';
DELETE FROM memory_scope.workspace WHERE id = '__forget_smoke_team';

INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES (
  '__forget_smoke_team',
  'Ephemeral db/forget-thoughts-smoke.sql fixture',
  'workspace',
  false
);

-- A unit vector along one axis, so each fixture is its own exact
-- nearest neighbour in the vector leg.
CREATE TEMP TABLE forget_smoke_axis AS
SELECT axis,
       (
         SELECT array_agg(CASE WHEN i = axis THEN 1.0 ELSE 0.0 END ORDER BY i)
         FROM generate_series(1, 768) AS i
       )::vector AS v
FROM generate_series(1, 4) AS axis;
GRANT SELECT ON forget_smoke_axis TO openbrain_app;

-- G1: default/workspace — the forget → re-capture → restore-conflict cycle.
-- G2: team/personal alice — owner-only forget.
-- G3: default/workspace legacy row with NO fingerprint — restore heals it.
-- G4: default/workspace — restore conflicts with a legacy NULL-fingerprint
--     live copy inserted later.
-- G5 + G6: identical text in team/workspace and alice's team/personal — a
--     forgotten resident no longer blocks a move.
INSERT INTO public.thoughts (
  id, content, embedding, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES
  (
    '00000000-0000-0000-0000-000000002001',
    'forget smoke one',
    (SELECT v FROM forget_smoke_axis WHERE axis = 1),
    '{"_forget_smoke_fixture":true,"type":"observation","topics":["one"]}'::jsonb,
    encode(sha256(convert_to('forget smoke one', 'UTF8')), 'hex'),
    'default', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000002002',
    'forget smoke personal',
    (SELECT v FROM forget_smoke_axis WHERE axis = 2),
    '{"_forget_smoke_fixture":true}'::jsonb,
    encode(sha256(convert_to('forget smoke personal', 'UTF8')), 'hex'),
    '__forget_smoke_team', NULL, 'personal', 'auth0|alice'
  ),
  (
    '00000000-0000-0000-0000-000000002003',
    'forget smoke legacy text',
    (SELECT v FROM forget_smoke_axis WHERE axis = 3),
    '{"_forget_smoke_fixture":true}'::jsonb,
    NULL,
    'default', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000002004',
    'forget smoke duplicate text',
    (SELECT v FROM forget_smoke_axis WHERE axis = 4),
    '{"_forget_smoke_fixture":true}'::jsonb,
    encode(sha256(convert_to('forget smoke duplicate text', 'UTF8')), 'hex'),
    'default', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000002005',
    'forget smoke resident text',
    NULL,
    '{"_forget_smoke_fixture":true}'::jsonb,
    encode(sha256(convert_to('forget smoke resident text', 'UTF8')), 'hex'),
    '__forget_smoke_team', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000002006',
    'forget smoke resident text',
    NULL,
    '{"_forget_smoke_fixture":true}'::jsonb,
    encode(sha256(convert_to('forget smoke resident text', 'UTF8')), 'hex'),
    '__forget_smoke_team', NULL, 'personal', 'auth0|alice'
  );

-- An embedding-index row for G1 (owner write: no activated contract needed),
-- to prove index rows follow their head's visibility.
INSERT INTO public.thought_embedding_index (
  thought_id, contract, source_hash, vectors
) VALUES (
  '00000000-0000-0000-0000-000000002001',
  repeat('f', 64),
  encode(sha256(convert_to('forget smoke one', 'UTF8')), 'hex'),
  ARRAY[(SELECT v FROM forget_smoke_axis WHERE axis = 1)]
);

SET ROLE openbrain_app;

-- ---------- Before: G1 is a vector AND lexical candidate ---------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r
  FROM memory_scope.search_thought_candidates(
    (SELECT v FROM forget_smoke_axis WHERE axis = 1), 0.0,
    'forget smoke one', 'forget smoke one', true, NULL, '[]'::jsonb, 100
  )
  WHERE candidate_id = '00000000-0000-0000-0000-000000002001';
  IF NOT FOUND OR r.vector_rank IS NULL OR r.lexical_rank IS NULL THEN
    RAISE EXCEPTION 'live G1 must be a candidate in both legs: %', r;
  END IF;
  IF (SELECT count(*) FROM public.thought_embedding_index
      WHERE thought_id = '00000000-0000-0000-0000-000000002001') <> 1 THEN
    RAISE EXCEPTION 'live G1 embedding-index row must be visible';
  END IF;
END;
$$;
COMMIT;

-- ---------- Forget G1 (no principal: workspace audience) ----------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record; again record;
BEGIN
  SELECT * INTO r FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002001', 'tailnet', 'smoke-token'
  );
  IF NOT FOUND OR r.outcome <> 'forgotten' OR r.revision <> 1
     OR r.forgotten_at IS NULL OR r.workspace_id <> 'default'
     OR r.project_id IS NOT NULL OR r.visibility <> 'workspace' THEN
    RAISE EXCEPTION 'unexpected forget outcome: %', r;
  END IF;
  -- Idempotent: the same call is a no-op that reports the original time.
  SELECT * INTO again FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002001', 'tailnet', 'smoke-token'
  );
  IF again.outcome <> 'unchanged' OR again.revision <> 1
     OR again.forgotten_at <> r.forgotten_at THEN
    RAISE EXCEPTION 'repeated forget must be unchanged: %', again;
  END IF;
END;
$$;
COMMIT;

-- ---------- The forgotten row is gone for the app ----------------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE n integer; r record;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000002001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'forgotten thought still readable by the app';
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'history of a forgotten thought is readable by the app';
  END IF;
  SELECT count(*) INTO n FROM public.thought_embedding_index
  WHERE thought_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'embedding index of a forgotten thought is readable';
  END IF;

  -- The RLS-bypassing candidate search skips it in both legs.
  SELECT count(*) INTO n
  FROM memory_scope.search_thought_candidates(
    (SELECT v FROM forget_smoke_axis WHERE axis = 1), 0.0,
    'forget smoke one', 'forget smoke one', true, NULL, '[]'::jsonb, 100
  )
  WHERE candidate_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'candidate search returned a forgotten thought';
  END IF;

  -- No app-role write reaches it.
  UPDATE public.thoughts SET content = 'forget smoke rewritten'
  WHERE id = '00000000-0000-0000-0000-000000002001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app UPDATE reached a forgotten thought';
  END IF;

  -- The move helper treats it as unknown.
  SELECT count(*) INTO n FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000002001',
    '__forget_smoke_team', NULL, 'workspace', 'tailnet', NULL
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'move_thought acted on a forgotten thought';
  END IF;
END;
$$;
ROLLBACK;

-- The marker is not app-writable, and the app cannot create a forgotten row.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
BEGIN
  BEGIN
    UPDATE public.thoughts SET forgotten_at = now()
    WHERE id = '00000000-0000-0000-0000-000000002004';
    RAISE EXCEPTION 'app UPDATE of forgotten_at was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'permission denied%' THEN
      RAISE;
    END IF;
  END;
  BEGIN
    INSERT INTO public.thoughts (
      content, metadata, content_fingerprint,
      workspace_id, project_id, visibility, owner_subject, forgotten_at
    ) VALUES (
      'forget smoke pre-forgotten', '{"_forget_smoke_fixture":true}'::jsonb,
      'forget-smoke-pre-forgotten', 'default', NULL, 'workspace', NULL, now()
    );
    RAISE EXCEPTION 'app INSERT of a forgotten row was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%row-level security%' THEN
      RAISE;
    END IF;
  END;
END;
$$;
ROLLBACK;

-- ---------- Re-capturing forgotten text creates a fresh row ------------------

-- The exact upsert shape server/queries.ts captureThought issues, with the
-- conflict target naming the live-rows index predicate.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
INSERT INTO public.thoughts (
  content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  'forget smoke one', '{"_forget_smoke_fixture":true,"recaptured":true}'::jsonb,
  encode(sha256(convert_to('forget smoke one', 'UTF8')), 'hex'),
  'default', NULL, 'workspace', NULL
)
ON CONFLICT (
  workspace_id, project_id, visibility, owner_subject, content_fingerprint
) WHERE content_fingerprint IS NOT NULL AND forgotten_at IS NULL
DO UPDATE SET metadata = thoughts.metadata || EXCLUDED.metadata;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts
  WHERE content = 'forget smoke one'
    AND id <> '00000000-0000-0000-0000-000000002001'
    AND metadata @> '{"recaptured":true}'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 're-capture of forgotten text did not create a fresh row';
  END IF;
END;
$$;
COMMIT;

-- ---------- Restore conflicts with the live copy, then succeeds --------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record; live uuid; n integer;
BEGIN
  SELECT id INTO live FROM public.thoughts
  WHERE content = 'forget smoke one'
    AND id <> '00000000-0000-0000-0000-000000002001';

  SELECT * INTO r FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002001', 'funnel', NULL
  );
  IF r.outcome <> 'conflict' OR r.conflict_thought_id <> live
     OR r.revision IS NOT NULL THEN
    RAISE EXCEPTION 'restore over a live duplicate must conflict: %', r;
  END IF;

  -- Retire the live copy; now the original comes back.
  SELECT * INTO r FROM memory_scope.forget_thought(live, 'funnel', NULL);
  IF r.outcome <> 'forgotten' THEN
    RAISE EXCEPTION 'forgetting the live copy failed: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002001', 'funnel', NULL
  );
  IF r.outcome <> 'restored' OR r.revision <> 2
     OR r.conflict_thought_id IS NOT NULL OR r.workspace_id <> 'default'
     OR r.visibility <> 'workspace' THEN
    RAISE EXCEPTION 'unexpected restore outcome: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002001', 'funnel', NULL
  );
  IF r.outcome <> 'unchanged' OR r.revision <> 2 THEN
    RAISE EXCEPTION 'restoring a live thought must be unchanged: %', r;
  END IF;

  -- Head, history, and embedding index are visible again.
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000002001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'restored thought is not readable';
  END IF;
  SELECT count(*) INTO n FROM public.thought_embedding_index
  WHERE thought_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'restored thought lost its embedding-index row';
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 2 THEN
    RAISE EXCEPTION 'restored thought must show 2 revisions, saw %', n;
  END IF;
  SELECT count(*) INTO n FROM memory_scope.search_thought_candidates(
    (SELECT v FROM forget_smoke_axis WHERE axis = 1), 0.0,
    'forget smoke one', 'forget smoke one', true, NULL, '[]'::jsonb, 100
  )
  WHERE candidate_id = '00000000-0000-0000-0000-000000002001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'restored thought is not a search candidate';
  END IF;

  -- History is append-only for the app. (Inner block: its handler must not
  -- roll back the restore above.)
  BEGIN
    UPDATE public.thought_revisions SET changed_by_door = 'x'
    WHERE thought_id = '00000000-0000-0000-0000-000000002001';
    RAISE EXCEPTION 'app UPDATE of thought_revisions was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
COMMIT;

-- ---------- Owner-only forget of a personal thought --------------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__forget_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|bob', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002002', 'funnel', NULL
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'bob could forget alice''s personal thought';
  END IF;
  SELECT count(*) INTO n FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002002', 'funnel', NULL
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'bob could act on alice''s personal thought via restore';
  END IF;
END;
$$;
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__forget_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002002', 'funnel', NULL
  );
  IF r.outcome <> 'forgotten' OR r.visibility <> 'personal' THEN
    RAISE EXCEPTION 'alice could not forget her own thought: %', r;
  END IF;
END;
$$;
COMMIT;

-- ---------- Legacy fingerprints ----------------------------------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002003', 'tailnet', NULL
  );
  IF r.outcome <> 'forgotten' THEN
    RAISE EXCEPTION 'legacy forget failed: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002003', 'tailnet', NULL
  );
  IF r.outcome <> 'restored' THEN
    RAISE EXCEPTION 'legacy restore failed: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002004', 'tailnet', NULL
  );
  IF r.outcome <> 'forgotten' THEN
    RAISE EXCEPTION 'G4 forget failed: %', r;
  END IF;
END;
$$;
COMMIT;

RESET ROLE;

-- Restore healed G3's NULL fingerprint to the canonical capture value.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.thoughts
    WHERE id = '00000000-0000-0000-0000-000000002003'
      AND forgotten_at IS NULL
      AND content_fingerprint = encode(sha256(convert_to(lower(trim(
        regexp_replace('forget smoke legacy text', '\s+', ' ', 'g')
      )), 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'restore did not heal the legacy NULL fingerprint';
  END IF;
END;
$$;

-- A legacy NULL-fingerprint live copy of G4's text (outside the partial
-- index, so only the derived-fingerprint probe can see the collision).
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000002014',
  'forget smoke duplicate text',
  '{"_forget_smoke_fixture":true}'::jsonb,
  NULL,
  'default', NULL, 'workspace', NULL
);

SET ROLE openbrain_app;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM memory_scope.restore_thought(
    '00000000-0000-0000-0000-000000002004', 'tailnet', NULL
  );
  IF r.outcome <> 'conflict'
     OR r.conflict_thought_id <> '00000000-0000-0000-0000-000000002014' THEN
    RAISE EXCEPTION 'restore over a legacy live copy must conflict: %', r;
  END IF;
END;
$$;
COMMIT;

-- ---------- A forgotten resident does not block a move ------------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__forget_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000002006',
    '__forget_smoke_team', NULL, 'workspace', 'funnel', NULL
  );
  IF r.outcome <> 'conflict'
     OR r.conflict_thought_id <> '00000000-0000-0000-0000-000000002005' THEN
    RAISE EXCEPTION 'move onto a live resident must conflict: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.forget_thought(
    '00000000-0000-0000-0000-000000002005', 'funnel', NULL
  );
  IF r.outcome <> 'forgotten' THEN
    RAISE EXCEPTION 'forgetting the resident failed: %', r;
  END IF;
  SELECT * INTO r FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000002006',
    '__forget_smoke_team', NULL, 'workspace', 'funnel', NULL
  );
  IF r.outcome <> 'moved' THEN
    RAISE EXCEPTION 'a forgotten resident blocked the move: %', r;
  END IF;
END;
$$;
COMMIT;

RESET ROLE;

-- ---------- History records the verified actor (owner view) -----------------

DO $$
DECLARE r record; kinds text[];
BEGIN
  SELECT array_agg(change_kind ORDER BY revision) INTO kinds
  FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000002001';
  IF kinds <> ARRAY['forget', 'restore'] THEN
    RAISE EXCEPTION 'G1 history must be forget, restore; saw %', kinds;
  END IF;
  SELECT * INTO r FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000002001' AND revision = 1;
  IF r.changed_by_door <> 'tailnet' OR r.changed_by_token_label <> 'smoke-token'
     OR r.changed_by_subject IS NOT NULL
     OR r.prior_content <> 'forget smoke one'
     OR r.prior_workspace_id <> 'default' OR r.prior_visibility <> 'workspace'
     OR NOT (r.prior_metadata @> '{"topics":["one"]}'::jsonb) THEN
    RAISE EXCEPTION 'forget revision does not snapshot the head/actor: %', r;
  END IF;
  SELECT * INTO r FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000002002';
  IF r.change_kind <> 'forget' OR r.changed_by_subject <> 'auth0|alice'
     OR r.prior_owner_subject <> 'auth0|alice' THEN
    RAISE EXCEPTION 'personal forget must record alice: %', r;
  END IF;

  -- Forgotten rows remain for audit, with the marker, to the owner and the
  -- read-only (backup) role.
  IF (SELECT count(*) FROM public.thoughts
      WHERE metadata @> '{"_forget_smoke_fixture":true}'::jsonb
        AND forgotten_at IS NOT NULL) <> 4 THEN
    RAISE EXCEPTION 'expected 4 forgotten fixtures (live copy of G1, G2, G4, G5)';
  END IF;
END;
$$;

SET ROLE openbrain_readonly;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.thoughts
      WHERE metadata @> '{"_forget_smoke_fixture":true}'::jsonb
        AND forgotten_at IS NOT NULL) <> 4 THEN
    RAISE EXCEPTION 'the read-only role must dump forgotten rows';
  END IF;
END;
$$;
RESET ROLE;

-- ---------- Cleanup (owner) -------------------------------------------------

DELETE FROM public.thoughts
WHERE metadata @> '{"_forget_smoke_fixture":true}'::jsonb;
DELETE FROM memory_scope.workspace WHERE id = '__forget_smoke_team';
DROP TABLE forget_smoke_axis;
