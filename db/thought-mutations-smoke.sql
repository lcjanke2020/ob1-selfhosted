-- CI/local integration smoke for db/10-thought-mutations.sql.
--
-- Runs as the database owner, switches to the real application role for the
-- assertions, and cleans up every fixture at the end. It proves the database
-- side of update_thought/move_thought: the SECURITY DEFINER move helper only
-- acts on rows the caller can already read, only into shape-valid registered
-- audiences, stamps personal owners from the transaction-local principal,
-- refuses to violate audience-aware deduplication, and writes revision history
-- that follows the head's audience under forced RLS; and the app-role update
-- path (the exact statements server/queries.ts issues) is confined to the
-- caller's audience.

\set ON_ERROR_STOP on

-- ---------- Fixtures (owner) ------------------------------------------------

DELETE FROM public.thoughts
WHERE metadata @> '{"_mut_smoke_fixture":true}'::jsonb;
DELETE FROM memory_scope.project WHERE workspace_id = '__mut_smoke_team';
DELETE FROM memory_scope.workspace WHERE id = '__mut_smoke_team';

INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES (
  '__mut_smoke_team',
  'Ephemeral db/thought-mutations-smoke.sql fixture',
  'workspace',
  false
);
INSERT INTO memory_scope.project (workspace_id, id, description)
VALUES ('__mut_smoke_team', 'alpha', 'alpha fixture');

-- T1: default/workspace — the "misfiled, move me to personal" case.
-- T2: team/personal alice — later moved to team/project alpha, then updated.
-- T3 + T4: identical fingerprint in default/workspace and default/personal
--          alice — the move-conflict case.
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES
  (
    '00000000-0000-0000-0000-000000001001',
    'mutation smoke one',
    '{"_mut_smoke_fixture":true,"type":"observation","topics":["one"],"source":"mcp","door":"funnel","sub":"auth0|alice","token_label":null}'::jsonb,
    'mut-smoke-fp-1',
    'default', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000001002',
    'mutation smoke two',
    '{"_mut_smoke_fixture":true,"type":"observation"}'::jsonb,
    'mut-smoke-fp-2',
    '__mut_smoke_team', NULL, 'personal', 'auth0|alice'
  ),
  (
    '00000000-0000-0000-0000-000000001003',
    'mutation smoke shared text',
    '{"_mut_smoke_fixture":true}'::jsonb,
    'mut-smoke-fp-3',
    'default', NULL, 'workspace', NULL
  ),
  (
    '00000000-0000-0000-0000-000000001004',
    'mutation smoke shared text',
    '{"_mut_smoke_fixture":true}'::jsonb,
    'mut-smoke-fp-3',
    'default', NULL, 'personal', 'auth0|alice'
  );

SET ROLE openbrain_app;

-- Missing audience settings must expose no history, never every row.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thought_revisions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'missing scope exposed % revision rows', n;
  END IF;
END;
$$;

-- ---------- Move: default/workspace → team/personal (alice) -----------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r
  FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000001001',
    '__mut_smoke_team', NULL, 'personal', 'funnel', NULL
  );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'move of a visible thought returned no row';
  END IF;
  IF r.outcome <> 'moved' OR r.revision <> 1
     OR r.workspace_id <> '__mut_smoke_team' OR r.project_id IS NOT NULL
     OR r.visibility <> 'personal' THEN
    RAISE EXCEPTION 'unexpected move outcome: %', r;
  END IF;
END;
$$;
COMMIT;

-- The head left its old audience: default/workspace readers see neither the
-- thought nor its history.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'moved thought still visible to its old audience';
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000001001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'revision history visible to the audience the head left';
  END IF;
END;
$$;
ROLLBACK;

-- Another principal in the destination workspace sees nothing either, and
-- cannot move what it cannot see (no row, not an error).
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|bob', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'bob can see alice''s personal thought';
  END IF;
  SELECT count(*) INTO n
  FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000001001',
    '__mut_smoke_team', NULL, 'workspace', 'funnel', NULL
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'bob could act on a thought he cannot read';
  END IF;
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001001';
  IF n <> 0 THEN
    RAISE EXCEPTION 'invisible-source move still widened the thought';
  END IF;
END;
$$;
ROLLBACK;

-- The owner sees the head and exactly one revision that snapshots the prior
-- audience and the verified actor; history is append-only for the app role.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001001';
  IF NOT FOUND OR r.owner_subject <> 'auth0|alice'
     OR r.content <> 'mutation smoke one'
     OR r.content_fingerprint <> 'mut-smoke-fp-1' THEN
    RAISE EXCEPTION 'moved head is wrong or invisible to its owner: %', r;
  END IF;
  SELECT * INTO r FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000001001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner cannot see the revision row';
  END IF;
  IF r.revision <> 1 OR r.change_kind <> 'scope'
     OR r.prior_workspace_id <> 'default' OR r.prior_project_id IS NOT NULL
     OR r.prior_visibility <> 'workspace' OR r.prior_owner_subject IS NOT NULL
     OR r.prior_content <> 'mutation smoke one'
     OR NOT (r.prior_metadata @> '{"topics":["one"]}'::jsonb)
     OR r.changed_by_subject <> 'auth0|alice' OR r.changed_by_door <> 'funnel'
     OR r.changed_by_token_label IS NOT NULL THEN
    RAISE EXCEPTION 'revision row does not snapshot the prior state: %', r;
  END IF;
  BEGIN
    UPDATE public.thought_revisions SET prior_content = 'tampered'
    WHERE thought_id = '00000000-0000-0000-0000-000000001001';
    RAISE EXCEPTION 'app role could rewrite revision history';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    DELETE FROM public.thought_revisions
    WHERE thought_id = '00000000-0000-0000-0000-000000001001';
    RAISE EXCEPTION 'app role could erase revision history';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  -- Repeating the same move is a no-op that writes no history.
  SELECT * INTO r
  FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000001001',
    '__mut_smoke_team', NULL, 'personal', 'funnel', NULL
  );
  IF r.outcome <> 'unchanged' OR r.revision <> 1 THEN
    RAISE EXCEPTION 'repeat move was not a no-op: %', r;
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000001001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'no-op move wrote history (% rows)', n;
  END IF;
END;
$$;
ROLLBACK;

-- ---------- Move: target validation (defense in depth) ---------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE r record;
BEGIN
  -- personal-only workspace refuses a broader audience
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001001',
      'sensitive', NULL, 'workspace', 'funnel', NULL
    );
    RAISE EXCEPTION 'personal-only workspace accepted workspace visibility';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- unknown workspace
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001001',
      '__mut_smoke_missing', NULL, 'workspace', 'funnel', NULL
    );
    RAISE EXCEPTION 'unknown workspace accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- unknown project / project shape
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001001',
      '__mut_smoke_team', 'nope', 'project', 'funnel', NULL
    );
    RAISE EXCEPTION 'unknown project accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001001',
      '__mut_smoke_team', NULL, 'project', 'funnel', NULL
    );
    RAISE EXCEPTION 'project visibility without project accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001001',
      '__mut_smoke_team', 'alpha', 'workspace', 'funnel', NULL
    );
    RAISE EXCEPTION 'workspace visibility with a project accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- the head must be untouched by every rejected attempt
  SELECT * INTO r FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001001';
  IF r.workspace_id <> '__mut_smoke_team' OR r.visibility <> 'personal' THEN
    RAISE EXCEPTION 'rejected move mutated the head: %', r;
  END IF;
END;
$$;
ROLLBACK;

-- A personal target with no transaction-local principal is refused even when
-- the source is visible (workspace rows are visible without a principal).
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE r record;
BEGIN
  BEGIN
    SELECT * INTO r FROM memory_scope.move_thought(
      '00000000-0000-0000-0000-000000001003',
      'default', NULL, 'personal', 'tailnet', NULL
    );
    RAISE EXCEPTION 'personal move without a principal accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  SELECT * INTO r FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001003';
  IF r.visibility <> 'workspace' OR r.owner_subject IS NOT NULL THEN
    RAISE EXCEPTION 'rejected personal move mutated the head: %', r;
  END IF;
END;
$$;
ROLLBACK;

-- ---------- Move: audience-aware dedupe conflict ---------------------------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000001003',
    'default', NULL, 'personal', 'funnel', NULL
  );
  IF r.outcome <> 'conflict'
     OR r.conflict_thought_id <> '00000000-0000-0000-0000-000000001004'
     OR r.revision IS NOT NULL
     OR r.visibility <> 'workspace' THEN
    RAISE EXCEPTION 'move onto identical content did not report the conflict: %', r;
  END IF;
  SELECT * INTO r FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001003';
  IF r.visibility <> 'workspace' OR r.owner_subject IS NOT NULL THEN
    RAISE EXCEPTION 'conflicting move mutated the head: %', r;
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000001003';
  IF n <> 0 THEN
    RAISE EXCEPTION 'conflicting move wrote history';
  END IF;
END;
$$;
COMMIT;

-- ---------- Move: personal → project (explicit widening by the owner) ------

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM memory_scope.move_thought(
    '00000000-0000-0000-0000-000000001002',
    '__mut_smoke_team', 'alpha', 'project', 'funnel', NULL
  );
  IF r.outcome <> 'moved' OR r.revision <> 1 OR r.project_id <> 'alpha'
     OR r.visibility <> 'project' THEN
    RAISE EXCEPTION 'personal→project move failed: %', r;
  END IF;
END;
$$;
COMMIT;

-- The project audience (no principal) now sees the head with no owner and its
-- history; alice's personal context no longer does.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
DO $$
DECLARE r record; n integer;
BEGIN
  SELECT * INTO r FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001002';
  IF NOT FOUND OR r.owner_subject IS NOT NULL OR r.project_id <> 'alpha' THEN
    RAISE EXCEPTION 'project audience cannot see the moved head correctly: %', r;
  END IF;
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id = '00000000-0000-0000-0000-000000001002'
    AND prior_visibility = 'personal'
    AND prior_owner_subject = 'auth0|alice';
  IF n <> 1 THEN
    RAISE EXCEPTION 'project audience sees % history rows, expected 1', n;
  END IF;
END;
$$;
ROLLBACK;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000001002';
  IF n <> 0 THEN
    RAISE EXCEPTION 'personal context still sees the thought moved to a project';
  END IF;
END;
$$;
ROLLBACK;

-- ---------- Update path (app role, forced RLS) -----------------------------
-- The exact statement sequence server/queries.ts updateThoughtContent issues:
-- locked head read (RLS), same-audience collision probe, revision snapshot,
-- head rewrite with a recomputed fingerprint. Content changes must land in the
-- generated tsvector too.

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
DO $$
DECLARE head record; rev integer; r record;
BEGIN
  SELECT id, content, metadata, workspace_id, project_id, visibility,
         owner_subject, content_fingerprint,
         encode(sha256(convert_to(lower(trim(regexp_replace(
           'mutation smoke two CORRECTED', '\s+', ' ', 'g'
         ))), 'UTF8')), 'hex') AS new_fingerprint
  INTO head
  FROM public.thoughts WHERE id = '00000000-0000-0000-0000-000000001002'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project audience cannot lock its own thought';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.thoughts
    WHERE content_fingerprint = head.new_fingerprint
      AND workspace_id = head.workspace_id
      AND project_id IS NOT DISTINCT FROM head.project_id
      AND visibility = head.visibility
      AND owner_subject IS NOT DISTINCT FROM head.owner_subject
      AND id <> head.id
  ) THEN
    RAISE EXCEPTION 'unexpected fingerprint collision in fixture';
  END IF;
  INSERT INTO public.thought_revisions (
    thought_id, revision, change_kind,
    prior_content, prior_metadata,
    prior_workspace_id, prior_project_id, prior_visibility, prior_owner_subject,
    changed_by_subject, changed_by_door, changed_by_token_label
  )
  SELECT head.id, COALESCE(max(revision), 0) + 1, 'content',
         head.content, head.metadata,
         head.workspace_id, head.project_id, head.visibility, head.owner_subject,
         NULL, 'tailnet', 'ci-token'
  FROM public.thought_revisions WHERE thought_id = head.id
  RETURNING revision INTO rev;
  IF rev <> 2 THEN
    RAISE EXCEPTION 'content revision numbered %, expected 2 (after the move)', rev;
  END IF;
  UPDATE public.thoughts
  SET content = 'mutation smoke two CORRECTED',
      content_fingerprint = head.new_fingerprint,
      metadata = '{"_mut_smoke_fixture":true,"type":"idea","metadata_extraction":{"schema_version":1,"endpoint":"stub"}}'::jsonb
        || COALESCE((
             SELECT jsonb_object_agg(preserved.key, preserved.value)
             FROM jsonb_each(public.thoughts.metadata) AS preserved
             WHERE preserved.key = ANY (ARRAY['provenance','source','door','sub','token_label'])
           ), '{}'::jsonb)
  WHERE id = head.id;
  SELECT * INTO r FROM public.thoughts WHERE id = head.id;
  IF r.content <> 'mutation smoke two CORRECTED'
     OR r.content_fingerprint <> head.new_fingerprint
     OR NOT (r.content_tsv @@ to_tsquery('simple', 'corrected'))
     OR r.metadata->>'type' <> 'idea'
     OR r.updated_at <= r.created_at THEN
    RAISE EXCEPTION 'update did not land on the head: %', r;
  END IF;
  SELECT * INTO r FROM public.thought_revisions
  WHERE thought_id = head.id AND revision = 2;
  IF r.change_kind <> 'content' OR r.prior_content <> 'mutation smoke two'
     OR r.changed_by_token_label <> 'ci-token' THEN
    RAISE EXCEPTION 'content revision does not snapshot the prior text: %', r;
  END IF;
END;
$$;
COMMIT;

-- A different audience can neither lock nor rewrite that head, and cannot
-- append history for a head it cannot see (WITH CHECK).
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__mut_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|bob', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE n integer;
BEGIN
  UPDATE public.thoughts SET content = 'hijacked'
  WHERE id = '00000000-0000-0000-0000-000000001002';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'foreign audience rewrote a project thought';
  END IF;
  BEGIN
    INSERT INTO public.thought_revisions (
      thought_id, revision, change_kind, prior_content, prior_metadata,
      prior_workspace_id, prior_project_id, prior_visibility,
      prior_owner_subject, changed_by_subject, changed_by_door
    ) VALUES (
      '00000000-0000-0000-0000-000000001002', 99, 'content', 'forged', '{}',
      '__mut_smoke_team', 'alpha', 'project', NULL, 'auth0|bob', 'funnel'
    );
    RAISE EXCEPTION 'foreign audience appended history for an invisible head';
  EXCEPTION WHEN insufficient_privilege THEN
    -- "new row violates row-level security policy" is SQLSTATE 42501.
    NULL;
  END;
END;
$$;
ROLLBACK;

-- ROLLBACK clears every transaction-local GUC: pooled reuse must not leak.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thought_revisions;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rolled-back audience leaked % history rows into pooled reuse', n;
  END IF;
END;
$$;

RESET ROLE;

-- ---------- Owner-side invariants + cleanup ---------------------------------

DO $$
DECLARE n integer;
BEGIN
  -- Two thoughts changed: T1 (1 scope revision), T2 (1 scope + 1 content).
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id IN (
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001002',
    '00000000-0000-0000-0000-000000001003',
    '00000000-0000-0000-0000-000000001004'
  );
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 revision rows across the fixtures, found %', n;
  END IF;
END;
$$;

DELETE FROM public.thoughts
WHERE metadata @> '{"_mut_smoke_fixture":true}'::jsonb;

-- Purging a head purges its history (ON DELETE CASCADE).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thought_revisions
  WHERE thought_id IN (
    '00000000-0000-0000-0000-000000001001',
    '00000000-0000-0000-0000-000000001002'
  );
  IF n <> 0 THEN
    RAISE EXCEPTION 'revision history survived its head (% rows)', n;
  END IF;
END;
$$;

DELETE FROM memory_scope.project WHERE workspace_id = '__mut_smoke_team';
DELETE FROM memory_scope.workspace WHERE id = '__mut_smoke_team';
