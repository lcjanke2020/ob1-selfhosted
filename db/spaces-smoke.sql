-- CI/local integration smoke for db/06-spaces.sql.
--
-- Runs as the database owner, switches to the real application/read-only
-- roles for assertions, and cleans up every fixture at the end. It proves the
-- database boundary itself enforces audience isolation even when a query omits
-- an application WHERE predicate.

\set ON_ERROR_STOP on

DELETE FROM sessions.session WHERE title LIKE '__spaces_smoke_%';
DELETE FROM public.thoughts
WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
DELETE FROM memory_scope.project WHERE workspace_id = '__spaces_smoke_team';
DELETE FROM memory_scope.workspace WHERE id = '__spaces_smoke_team';

INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES (
  '__spaces_smoke_team',
  'Ephemeral db/spaces-smoke.sql fixture',
  'workspace',
  false
);
INSERT INTO memory_scope.project (workspace_id, id, description) VALUES
  ('__spaces_smoke_team', 'alpha', 'alpha fixture'),
  ('__spaces_smoke_team', 'beta', 'beta fixture');

SET ROLE openbrain_app;

-- Missing audience settings must match nothing, never every row.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts;
  IF n <> 0 THEN
    RAISE EXCEPTION 'missing thought scope exposed % rows', n;
  END IF;
  SELECT count(*) INTO n FROM sessions.session;
  IF n <> 0 THEN
    RAISE EXCEPTION 'missing session scope exposed % rows', n;
  END IF;
END;
$$;

-- One fingerprint may exist in distinct audiences, while a duplicate in the
-- same exact audience follows the production ON CONFLICT target.
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
  '00000000-0000-0000-0000-000000000601',
  'default workspace fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  'default', NULL, 'workspace', NULL
);
INSERT INTO public.thoughts (
  content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  'same audience duplicate refresh',
  '{"_spaces_smoke_fixture":true,"deduped":true}'::jsonb,
  'spaces-smoke-fingerprint',
  'default', NULL, 'workspace', NULL
)
ON CONFLICT (
  workspace_id, project_id, visibility, owner_subject, content_fingerprint
) WHERE content_fingerprint IS NOT NULL
DO UPDATE SET
  content = EXCLUDED.content,
  metadata = public.thoughts.metadata || EXCLUDED.metadata;
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000602',
  'team workspace fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  '__spaces_smoke_team', NULL, 'workspace', NULL
);
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000603',
  'alpha project fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  '__spaces_smoke_team', 'alpha', 'project', NULL
);
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'beta', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000604',
  'beta project fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  '__spaces_smoke_team', 'beta', 'project', NULL
);
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000605',
  'alice personal fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  '__spaces_smoke_team', NULL, 'personal', 'auth0|alice'
);
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|bob', true),
  set_config('openbrain.visibilities', 'personal', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000606',
  'bob personal fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  '__spaces_smoke_team', NULL, 'personal', 'auth0|bob'
);
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'sensitive', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
INSERT INTO public.thoughts (
  id, content, metadata, content_fingerprint,
  workspace_id, project_id, visibility, owner_subject
) VALUES (
  '00000000-0000-0000-0000-000000000607',
  'alice sensitive fixture',
  '{"_spaces_smoke_fixture":true}'::jsonb,
  'spaces-smoke-fingerprint',
  'sensitive', NULL, 'personal', 'auth0|alice'
);
COMMIT;

-- A personal-only workspace rejects broad visibility at the DB boundary even
-- if application code were to construct such an INSERT.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'sensitive', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.thoughts (
      content, metadata, workspace_id, project_id, visibility, owner_subject
    ) VALUES (
      'must be rejected',
      '{"_spaces_smoke_fixture":true}'::jsonb,
      'sensitive', NULL, 'workspace', NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  RAISE EXCEPTION 'sensitive workspace accepted workspace visibility';
END;
$$;
ROLLBACK;

-- A caller cannot author a different personal owner than the verified
-- principal installed in the transaction.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.thoughts (
      content, metadata, workspace_id, project_id, visibility, owner_subject
    ) VALUES (
      'must be rejected',
      '{"_spaces_smoke_fixture":true}'::jsonb,
      '__spaces_smoke_team', NULL, 'personal', 'auth0|bob'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  RAISE EXCEPTION 'personal insert accepted a mismatched owner';
END;
$$;
ROLLBACK;

-- Omitted visibility means a server-computed union inside one workspace. In
-- alpha context Alice sees her personal row, alpha's row, and the workspace
-- row—but neither Bob, beta, default, nor sensitive.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal,project,workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
  IF n <> 3 THEN
    RAISE EXCEPTION 'alice/alpha audience returned %, expected 3', n;
  END IF;
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE id = '00000000-0000-0000-0000-000000000607';
  IF n <> 0 THEN
    RAISE EXCEPTION 'point fetch crossed into sensitive workspace';
  END IF;
END;
$$;
ROLLBACK;

-- A visibility narrowing does exactly that; an unknown workspace matches no
-- rows at the database layer (the service layer turns it into a validation
-- error before embedding).
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'personal narrowing returned %, expected 1', n;
  END IF;
END;
$$;
ROLLBACK;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__unknown_workspace', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal,workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts;
  IF n <> 0 THEN
    RAISE EXCEPTION 'unknown workspace exposed % rows', n;
  END IF;
END;
$$;
ROLLBACK;

-- Session artifacts inherit their parent session audience. The alpha context
-- must not list, fetch, or update beta's parent or child.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
DO $$
DECLARE parent_id bigint;
BEGIN
  INSERT INTO sessions.session (
    title, workspace_id, project_id, visibility, owner_subject
  ) VALUES (
    '__spaces_smoke_alpha',
    '__spaces_smoke_team', 'alpha', 'project', NULL
  ) RETURNING id INTO parent_id;
  INSERT INTO sessions.artifact (session_pk, kind, title)
  VALUES (parent_id, 'note', '__spaces_smoke_alpha_artifact');
END;
$$;
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'beta', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
DO $$
DECLARE parent_id bigint;
BEGIN
  INSERT INTO sessions.session (
    title, workspace_id, project_id, visibility, owner_subject
  ) VALUES (
    '__spaces_smoke_beta',
    '__spaces_smoke_team', 'beta', 'project', NULL
  ) RETURNING id INTO parent_id;
  INSERT INTO sessions.artifact (session_pk, kind, title)
  VALUES (parent_id, 'note', '__spaces_smoke_beta_artifact');
END;
$$;
COMMIT;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', '__spaces_smoke_team', true),
  set_config('openbrain.project_id', 'alpha', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'project', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM sessions.session WHERE title LIKE '__spaces_smoke_%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'alpha context returned % sessions, expected 1', n;
  END IF;
  SELECT count(*) INTO n
  FROM sessions.artifact WHERE title LIKE '__spaces_smoke_%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'alpha context returned % artifacts, expected 1', n;
  END IF;
  UPDATE sessions.session SET status = 'done'
  WHERE title = '__spaces_smoke_beta';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'alpha context updated beta session';
  END IF;
END;
$$;
ROLLBACK;

-- ROLLBACK clears every transaction-local GUC. The same physical connection
-- is reused below with a different audience and must not retain sensitive or
-- principal state from the prior transaction.
BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'sensitive', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', 'auth0|alice', true),
  set_config('openbrain.visibilities', 'personal', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'sensitive transaction returned %, expected 1', n;
  END IF;
END;
$$;
ROLLBACK;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.thoughts;
  IF n <> 0 THEN
    RAISE EXCEPTION 'rolled-back audience leaked % rows into pooled reuse', n;
  END IF;
END;
$$;

BEGIN;
SELECT
  set_config('openbrain.workspace_id', 'default', true),
  set_config('openbrain.project_id', '', true),
  set_config('openbrain.principal', '', true),
  set_config('openbrain.visibilities', 'workspace', true);
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'reused default context returned %, expected 1', n;
  END IF;
END;
$$;
ROLLBACK;

RESET ROLE;

-- Backup/exploration is deliberately all-row and does not depend on request
-- GUCs. The role has an all-row policy for ordinary SELECT plus BYPASSRLS for
-- pg_dump's deliberate `SET row_security = off` behavior.
SET ROLE openbrain_readonly;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.thoughts
  WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
  IF n <> 7 THEN
    RAISE EXCEPTION 'readonly saw % thought audiences, expected 7', n;
  END IF;
  SELECT count(*) INTO n
  FROM sessions.session WHERE title LIKE '__spaces_smoke_%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'readonly saw % sessions, expected 2', n;
  END IF;
  SELECT count(*) INTO n
  FROM sessions.artifact WHERE title LIKE '__spaces_smoke_%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'readonly saw % artifacts, expected 2', n;
  END IF;
END;
$$;
RESET ROLE;

DELETE FROM sessions.session WHERE title LIKE '__spaces_smoke_%';
DELETE FROM public.thoughts
WHERE metadata @> '{"_spaces_smoke_fixture":true}'::jsonb;
DELETE FROM memory_scope.project WHERE workspace_id = '__spaces_smoke_team';
DELETE FROM memory_scope.workspace WHERE id = '__spaces_smoke_team';
