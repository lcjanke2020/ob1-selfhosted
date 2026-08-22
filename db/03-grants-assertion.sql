-- Invariant assertions for protected corpus grants and topology: openbrain_app
-- must be a standalone, non-bypass role with its intended memory access, while
-- Funnel relations, sink-only roles, and matching pg_hba rules must be absent.
--
-- Why this is its own file:
--
-- The natural place for this DO-block would have been at the end of
-- 01-schema.sql, right after the REVOKE+GRANT that establishes the
-- intended privilege state. But that placement makes the assertion
-- useless for the case this assertion actually cares about — "an
-- assertion query for deployed DBs so live deployments + restores stay
-- aligned." Re-running 01-schema.sql against a drifted DB starts with
-- `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM openbrain_app`, which
-- wipes any drift (e.g. a stray GRANT DELETE) BEFORE the assertion
-- could observe it. The assertion in that placement only catches
-- in-file drift of the GRANT list itself.
--
-- Putting the assertion in its own file solves both cases:
--   1. Fresh init: the Compose/CI paths mount this source file as
--      99-grants-assertion.sql, after every schema migration. Native
--      provisioning applies 01-, 02-, 04-, 05-, 06-, 07-, 08-, 09-, and 10-, then invokes
--      this stable source path last. In both cases the assertion sees the
--      completed catalog, so an init file that widens a protected role fails
--      loudly.
--   2. Drift check against a deployed DB: a superuser can run this
--      file standalone (`psql -f db/03-grants-assertion.sql`) against
--      a live DB and the assertion exercises the LIVE catalog state
--      without mutating anything — no REVOKE+GRANT to wipe the drift
--      first. Superuser is required only because pg_hba_file_rules restricts
--      its contents; the assertion remains read-only. This is point-in-time
--      detection when invoked outside a deployment workflow.
--
-- The assertion is a trusted deployment gate, not an authorization control
-- over the superuser that invokes it. Runtime containment of application and
-- administrative roles comes from PostgreSQL ACLs, RLS, role attributes, and
-- HBA/SCRAM. A full database superuser can bypass those controls, alter data,
-- or skip/undo this check and is outside this SQL file's threat boundary.
--
-- Invariants checked:
--   (a) `openbrain_app` must have no role memberships and must not be a
--       superuser or hold any cluster-level privilege; `openbrain_readonly`
--       must hold BYPASSRLS for pg_dump and no other unsafe attribute.
--   (b) `openbrain_app` must NOT have DELETE on `public.thoughts`.
--   (c) `openbrain_app` MUST have SELECT and INSERT on `public.thoughts`,
--       plus UPDATE on its content columns only — and no UPDATE (table-wide or
--       per column) on workspace_id/project_id/visibility/owner_subject, so the
--       audience-move helper is the sole application audience-change path.
--   (d) the app may read but not mutate the memory-space registry, and only
--       it may execute the three reviewed memory_scope helpers (never PUBLIC).
--   (e) metadata degradation history is append-only to the app; its pending-
--       delivery outbox is enqueue/consume-only, and only the singleton
--       notification ledger is otherwise mutable.
--   (f) PUBLIC has no standing default table/sequence grant, and Funnel
--       relations, sink-only roles, and matching/unprovable HBA user tokens
--       are absent from the corpus.
--   (g) thought revision history is append-only (SELECT/INSERT) to the app,
--       dumpable by the read-only role, under forced head-gated RLS, and the
--       audience-move helper is a table-owner-owned, fixed-search-path
--       SECURITY DEFINER function executable only by the app.
--
-- The openbrain_app check is deliberately scoped to thoughts:
-- 02-observability.sql and 04-sessions.sql legitimately grant it access to
-- other application tables. The final breakout check is deliberately inverse:
-- it rejects every sink-only role and public.funnel_access_% relation rather
-- than maintaining a corpus-side allowlist for either.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = current_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'grants assertion requires a database superuser to inspect '
      'pg_hba_file_rules; current_user=%',
      current_user;
  END IF;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  app_attributes      text;
  readonly_attributes text;
  memberships         text;
BEGIN
  SELECT concat_ws(
           ', ',
           CASE WHEN rolsuper THEN 'SUPERUSER' END,
           CASE WHEN rolcreatedb THEN 'CREATEDB' END,
           CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
           CASE WHEN rolreplication THEN 'REPLICATION' END,
           CASE WHEN rolbypassrls THEN 'BYPASSRLS' END
         )
    INTO app_attributes
  FROM pg_roles
  WHERE rolname = 'openbrain_app';
  IF app_attributes <> '' THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app has unsafe cluster-level role attributes: %.',
      app_attributes;
  END IF;
  SELECT string_agg(
    roleid::regrole::text,
    ', ' ORDER BY roleid::regrole::text
  )
  INTO memberships
  FROM pg_auth_members
  WHERE member = 'openbrain_app'::regrole;
  IF memberships IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app is a member of: %. It must be a standalone role so inherited privileges and SET ROLE cannot bypass row-level security.',
      memberships;
  END IF;
  SELECT concat_ws(
           ', ',
           CASE WHEN rolsuper THEN 'SUPERUSER' END,
           CASE WHEN rolcreatedb THEN 'CREATEDB' END,
           CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
           CASE WHEN rolreplication THEN 'REPLICATION' END
         )
    INTO readonly_attributes
  FROM pg_roles
  WHERE rolname = 'openbrain_readonly';
  IF readonly_attributes <> '' THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_readonly has unsafe cluster-level role attributes beyond required BYPASSRLS: %.',
      readonly_attributes;
  END IF;
  IF NOT COALESCE((
       SELECT rolbypassrls
       FROM pg_roles WHERE rolname = 'openbrain_readonly'
     ), false) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_readonly lacks BYPASSRLS required by full pg_dump under FORCE RLS.';
  END IF;
  IF has_table_privilege('openbrain_app', 'public.thoughts', 'DELETE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app still has DELETE on public.thoughts. '
      'A migration drifted; revoke before deploying.';
  END IF;
  IF NOT (has_table_privilege('openbrain_app', 'public.thoughts', 'SELECT')
      AND has_table_privilege('openbrain_app', 'public.thoughts', 'INSERT')) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app missing required SELECT/INSERT on public.thoughts.';
  END IF;
  -- UPDATE must be column-scoped: table-wide UPDATE would let the app role
  -- rewrite audience columns under the union read scope it installs, bypassing
  -- memory_scope.move_thought and its revision history. has_table_privilege
  -- reports only table-level UPDATE; the per-column negatives cover a
  -- column grant that drifted onto an audience column.
  IF has_table_privilege('openbrain_app', 'public.thoughts', 'UPDATE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app has table-wide UPDATE on public.thoughts; it must be column-scoped (content, embedding, content_fingerprint, metadata, updated_at). Apply db/10-thought-mutations.sql.';
  END IF;
  IF NOT (
       has_column_privilege('openbrain_app', 'public.thoughts', 'content', 'UPDATE')
       AND has_column_privilege('openbrain_app', 'public.thoughts', 'embedding', 'UPDATE')
       AND has_column_privilege('openbrain_app', 'public.thoughts', 'content_fingerprint', 'UPDATE')
       AND has_column_privilege('openbrain_app', 'public.thoughts', 'metadata', 'UPDATE')
       AND has_column_privilege('openbrain_app', 'public.thoughts', 'updated_at', 'UPDATE')
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app is missing column UPDATE on a thoughts content column (content, embedding, content_fingerprint, metadata, updated_at).';
  END IF;
  IF has_column_privilege('openbrain_app', 'public.thoughts', 'workspace_id', 'UPDATE')
     OR has_column_privilege('openbrain_app', 'public.thoughts', 'project_id', 'UPDATE')
     OR has_column_privilege('openbrain_app', 'public.thoughts', 'visibility', 'UPDATE')
     OR has_column_privilege('openbrain_app', 'public.thoughts', 'owner_subject', 'UPDATE')
     OR has_column_privilege('openbrain_app', 'public.thoughts', 'id', 'UPDATE')
     OR has_column_privilege('openbrain_app', 'public.thoughts', 'created_at', 'UPDATE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app can UPDATE a thoughts audience/identity column (workspace_id, project_id, visibility, owner_subject, id, created_at); only memory_scope.move_thought may change audience.';
  END IF;

  IF to_regclass('public.metadata_degradation_events') IS NULL
     OR to_regclass('public.metadata_degradation_outbox') IS NULL
     OR to_regclass('public.metadata_degradation_notification_state') IS NULL
     OR to_regclass('public.metadata_degradation_events_id_seq') IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: metadata degradation schema is missing; apply db/07-metadata-degradation.sql first.';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (VALUES
         ('singleton'),
         ('pending_counts'),
         ('notified_event_types'),
         ('last_notified_at'),
         ('last_delivery_attempt_at'),
         ('last_failed_channels'),
         ('updated_at')
       ) AS required(attname)
       WHERE NOT EXISTS (
         SELECT 1
         FROM pg_attribute
         WHERE attrelid =
                 'public.metadata_degradation_notification_state'::regclass
           AND pg_attribute.attname::text = required.attname
           AND attnum > 0
           AND NOT attisdropped
       )
     ) OR EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid =
               'public.metadata_degradation_notification_state'::regclass
         AND attname = 'last_event_id'
         AND attnum > 0
         AND NOT attisdropped
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_attribute
       WHERE attrelid = 'public.metadata_degradation_outbox'::regclass
         AND attname = 'created_at'
         AND attnum > 0
         AND NOT attisdropped
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid =
               'public.metadata_degradation_notification_state'::regclass
         AND conname = 'metadata_degradation_failed_channels_shape'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: metadata degradation ledger/outbox columns are incomplete; reapply db/07-metadata-degradation.sql.';
  END IF;

  IF COALESCE((
       SELECT attnotnull
       FROM pg_attribute
       WHERE attrelid = 'public.metadata_degradation_events'::regclass
         AND attname = 'thought_id'
         AND attnum > 0
         AND NOT attisdropped
     ), true) OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = 'public.metadata_degradation_events'::regclass
         AND conname = 'metadata_degradation_events_thought_id_fkey'
         AND confdeltype = 'n'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: metadata degradation thought link must be nullable with ON DELETE SET NULL; reapply db/07-metadata-degradation.sql.';
  END IF;

  IF NOT (
       has_table_privilege(
         'openbrain_app', 'public.metadata_degradation_outbox', 'SELECT'
       )
       AND has_table_privilege(
         'openbrain_app', 'public.metadata_degradation_outbox', 'INSERT'
       )
       AND has_table_privilege(
         'openbrain_app', 'public.metadata_degradation_outbox', 'DELETE'
       )
     ) OR has_table_privilege(
       'openbrain_app', 'public.metadata_degradation_outbox',
       'UPDATE, TRUNCATE, REFERENCES, TRIGGER'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app metadata degradation outbox must be SELECT/INSERT/DELETE-only.';
  END IF;

  IF NOT (
       has_table_privilege(
         'openbrain_app', 'public.metadata_degradation_events', 'SELECT'
       )
       AND has_table_privilege(
         'openbrain_app', 'public.metadata_degradation_events', 'INSERT'
       )
       AND has_sequence_privilege(
         'openbrain_app', 'public.metadata_degradation_events_id_seq', 'USAGE'
       )
     ) OR has_table_privilege(
       'openbrain_app', 'public.metadata_degradation_events',
       'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     ) OR has_sequence_privilege(
       'openbrain_app', 'public.metadata_degradation_events_id_seq',
       'SELECT, UPDATE'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app metadata degradation history must be SELECT/INSERT-only with sequence USAGE.';
  END IF;

  IF NOT (
       has_table_privilege(
         'openbrain_app',
         'public.metadata_degradation_notification_state',
         'SELECT'
       )
       AND has_table_privilege(
         'openbrain_app',
         'public.metadata_degradation_notification_state',
         'UPDATE'
       )
     ) OR has_table_privilege(
       'openbrain_app',
       'public.metadata_degradation_notification_state',
       'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app notification ledger must be SELECT/UPDATE-only.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )
    ) acl
    WHERE relation.oid = ANY (ARRAY[
      'public.metadata_degradation_events'::regclass::oid,
      'public.metadata_degradation_outbox'::regclass::oid,
      'public.metadata_degradation_notification_state'::regclass::oid,
      'public.metadata_degradation_events_id_seq'::regclass::oid
    ])
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can access metadata degradation relations or sequence.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- PUBLIC is an effective grant to every present and future role. Keep this
-- current-object census name-free and role-independent: the object ACL itself
-- is the invariant, including privilege types added by newer PostgreSQL
-- releases. Object-specific checks below still pin the narrower positive
-- grants for managed roles and deliberately repeat local PUBLIC negatives so
-- each reviewed object's contract remains self-contained.
DO $$
DECLARE
  bad_public_acls text;
  bad_public_definers text;
BEGIN
  SELECT string_agg(exposure.description, ', ' ORDER BY exposure.description)
    INTO bad_public_acls
  FROM (
    SELECT format(
             '%I.%I=%s',
             namespace.nspname,
             relation.relname,
             acl.privilege_type
           ) AS description
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )
    ) acl
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND acl.grantee = 0

    UNION ALL

    SELECT format(
             '%I.%I.%I=%s',
             namespace.nspname,
             relation.relname,
             attribute.attname,
             acl.privilege_type
           ) AS description
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND acl.grantee = 0
  ) exposure;
  IF bad_public_acls IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can access current non-system relations or columns: %.',
      bad_public_acls;
  END IF;

  -- Reviewed application SECURITY DEFINER routines have PUBLIC explicitly
  -- revoked. An unknown definer that keeps PostgreSQL's default PUBLIC EXECUTE
  -- grant is a real least-privilege bypass, independent of any one role name.
  SELECT string_agg(
           routine.oid::regprocedure::text,
           ', ' ORDER BY routine.oid::regprocedure::text
         )
    INTO bad_public_definers
  FROM pg_proc routine
  JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(routine.proacl, acldefault('f', routine.proowner))
  ) acl
  WHERE namespace.nspname <> 'information_schema'
    AND namespace.nspname !~ '^pg_'
    AND routine.prosecdef
    AND acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE';
  IF bad_public_definers IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can execute non-system SECURITY DEFINER routines: %.',
      bad_public_definers;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Native access-token invariants. The runtime may perform only the bounded
-- hash lookup; the dedicated administrator may list non-secret metadata and
-- execute exactly two fixed-search-path SECURITY DEFINER lifecycle functions.
-- Neither role may inherit privileges, and PUBLIC receives nothing.
DO $$
DECLARE
  token_table oid := to_regclass('native_auth.access_token');
  token_sequence oid := to_regclass('native_auth.access_token_id_seq');
  register_fn oid := to_regprocedure(
    'native_auth.register_access_token(text,bytea,text)'
  );
  revoke_fn oid := to_regprocedure(
    'native_auth.revoke_access_token(text)'
  );
  app_oid oid := to_regrole('openbrain_app');
  admin_oid oid := to_regrole('openbrain_token_admin');
  readonly_oid oid := to_regrole('openbrain_readonly');
  relation_owner oid;
  function_oid oid;
  bad text;
BEGIN
  IF token_table IS NULL OR token_sequence IS NULL
     OR register_fn IS NULL OR revoke_fn IS NULL OR admin_oid IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: native access-token schema, sequence, functions, or administrator role is missing; apply db/08-access-tokens.sql first.';
  END IF;

  SELECT concat_ws(
    ', ',
    CASE WHEN rolsuper THEN 'SUPERUSER' END,
    CASE WHEN rolcreatedb THEN 'CREATEDB' END,
    CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN rolreplication THEN 'REPLICATION' END,
    CASE WHEN rolbypassrls THEN 'BYPASSRLS' END
  )
    INTO bad
  FROM pg_roles
  WHERE oid = admin_oid;
  IF bad <> '' THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_token_admin has unsafe cluster-level role attributes: %.',
      bad;
  END IF;
  SELECT string_agg(roleid::regrole::text, ', ' ORDER BY roleid::regrole::text)
    INTO bad FROM pg_auth_members WHERE member = admin_oid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_token_admin is a member of: %. It must remain standalone.',
      bad;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) acl
    WHERE namespace.oid = 'native_auth'::regnamespace
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can access the native_auth schema.';
  END IF;
  IF NOT has_schema_privilege(app_oid, 'native_auth', 'USAGE')
     OR has_schema_privilege(app_oid, 'native_auth', 'CREATE')
     OR NOT has_schema_privilege(admin_oid, 'native_auth', 'USAGE')
     OR has_schema_privilege(admin_oid, 'native_auth', 'CREATE') THEN
    RAISE EXCEPTION
      'grants assertion failed: native-auth roles have incorrect schema privileges.';
  END IF;

  -- The lifecycle credential must not become a sideways memory credential.
  -- Scan effective privileges (including PUBLIC) across every non-system
  -- relation instead of maintaining a memory-table denylist.
  SELECT string_agg(exposed.object_name, ', ' ORDER BY exposed.object_name)
    INTO bad
  FROM (
    SELECT format(
      '%I.%I%s',
      namespace.nspname,
      relation.relname,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM aclexplode(relation.relacl) public_acl
          WHERE public_acl.grantee = 0
        ) OR EXISTS (
          SELECT 1
          FROM pg_attribute attribute
          CROSS JOIN LATERAL aclexplode(attribute.attacl) public_acl
          WHERE attribute.attrelid = relation.oid
            AND public_acl.grantee = 0
        ) THEN ' (via PUBLIC)'
        ELSE ''
      END
    ) AS object_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND relation.oid <> token_table
      AND (
        relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege(
            admin_oid, relation.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
          )
          OR has_any_column_privilege(
            admin_oid, relation.oid, 'SELECT, INSERT, UPDATE, REFERENCES'
          )
        )
        OR relation.relkind = 'S'
          AND has_sequence_privilege(
            admin_oid, relation.oid, 'USAGE, SELECT, UPDATE'
          )
      )
  ) exposed;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_token_admin can access non-token relations: %.',
      bad;
  END IF;

  SELECT string_agg(routine.oid::regprocedure::text, ', '
                    ORDER BY routine.oid::regprocedure::text)
    INTO bad
  FROM pg_proc routine
  JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
  WHERE namespace.nspname <> 'information_schema'
    AND namespace.nspname !~ '^pg_'
    AND routine.prosecdef
    AND routine.oid <> ALL (ARRAY[register_fn, revoke_fn])
    AND has_function_privilege(admin_oid, routine.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_token_admin can execute unrelated SECURITY DEFINER functions: %.',
      bad;
  END IF;

  IF NOT (
       has_column_privilege(app_oid, token_table, 'prefix', 'SELECT')
       AND has_column_privilege(app_oid, token_table, 'token_hash', 'SELECT')
       AND has_column_privilege(app_oid, token_table, 'label', 'SELECT')
       AND has_column_privilege(app_oid, token_table, 'revoked_at', 'SELECT')
     ) OR has_column_privilege(app_oid, token_table, 'id', 'SELECT')
       OR has_column_privilege(app_oid, token_table, 'created_at', 'SELECT')
       OR has_table_privilege(
         app_oid, token_table,
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
       )
       OR has_any_column_privilege(
         app_oid, token_table, 'INSERT, UPDATE, REFERENCES'
       ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app must have SELECT only on the four native-token verification columns.';
  END IF;

  IF NOT (
       has_column_privilege(admin_oid, token_table, 'id', 'SELECT')
       AND has_column_privilege(admin_oid, token_table, 'prefix', 'SELECT')
       AND has_column_privilege(admin_oid, token_table, 'label', 'SELECT')
       AND has_column_privilege(admin_oid, token_table, 'created_at', 'SELECT')
       AND has_column_privilege(admin_oid, token_table, 'revoked_at', 'SELECT')
     ) OR has_column_privilege(admin_oid, token_table, 'token_hash', 'SELECT')
       OR has_table_privilege(
         admin_oid, token_table,
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
       )
       OR has_any_column_privilege(
         admin_oid, token_table, 'INSERT, UPDATE, REFERENCES'
       )
       OR has_sequence_privilege(
         admin_oid, token_sequence, 'USAGE, SELECT, UPDATE'
       ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_token_admin must list non-secret metadata and mutate only through reviewed functions.';
  END IF;

  SELECT relowner INTO relation_owner FROM pg_class WHERE oid = token_table;
  FOREACH function_oid IN ARRAY ARRAY[register_fn, revoke_fn] LOOP
    IF NOT COALESCE((
         SELECT prosecdef
           AND proowner = relation_owner
           AND COALESCE(proconfig, ARRAY[]::text[])
                 @> ARRAY['search_path=pg_catalog, native_auth']
         FROM pg_proc WHERE oid = function_oid
       ), false) THEN
      RAISE EXCEPTION
        'grants assertion failed: native-auth function % must be SECURITY DEFINER, table-owner-owned, with fixed search_path.',
        function_oid::regprocedure;
    END IF;
    IF EXISTS (
         SELECT 1
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(
           COALESCE(p.proacl, acldefault('f', p.proowner))
         ) acl
         WHERE p.oid = function_oid AND acl.grantee = 0
       ) OR has_function_privilege(app_oid, function_oid, 'EXECUTE')
       OR NOT has_function_privilege(admin_oid, function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'grants assertion failed: native-auth function % execution is not restricted to openbrain_token_admin.',
        function_oid::regprocedure;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl
      WHERE p.oid = function_oid
        AND acl.grantee = admin_oid
        AND acl.is_grantable
    ) THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_token_admin has grant option on %.',
        function_oid::regprocedure;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )
    ) acl
    WHERE relation.oid = ANY (ARRAY[token_table, token_sequence])
      AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE attribute.attrelid = token_table
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can access native token storage.';
  END IF;

  IF NOT has_table_privilege(readonly_oid, token_table, 'SELECT')
     OR has_table_privilege(readonly_oid, token_table,
       'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_sequence_privilege(readonly_oid, token_sequence, 'SELECT')
     OR has_sequence_privilege(readonly_oid, token_sequence, 'USAGE, UPDATE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_readonly cannot safely dump native token storage.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Thought revision history (10-thought-mutations.sql) is the audit trail for
-- content updates and audience moves. The app appends and reads it but can
-- never rewrite or erase it; the read-only role dumps it (table + identity
-- sequence); PUBLIC gets nothing; and forced RLS gates every row on its head
-- thought being visible, so a moved thought's earlier text follows the head.
DO $$
DECLARE
  revisions oid := to_regclass('public.thought_revisions');
  revisions_seq oid := to_regclass('public.thought_revisions_id_seq');
BEGIN
  IF revisions IS NULL OR revisions_seq IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: public.thought_revisions or its identity sequence is missing; apply db/10-thought-mutations.sql first.';
  END IF;

  IF NOT (
       has_table_privilege('openbrain_app', revisions, 'SELECT')
       AND has_table_privilege('openbrain_app', revisions, 'INSERT')
     ) OR has_table_privilege(
       'openbrain_app', revisions,
       'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app thought revision history must be SELECT/INSERT-only.';
  END IF;

  IF NOT has_table_privilege('openbrain_readonly', revisions, 'SELECT')
     OR has_table_privilege(
       'openbrain_readonly', revisions,
       'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     )
     OR NOT has_sequence_privilege('openbrain_readonly', revisions_seq, 'SELECT')
     OR has_sequence_privilege('openbrain_readonly', revisions_seq, 'USAGE, UPDATE')
  THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_readonly cannot safely dump thought revision history.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(
      COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )
    ) acl
    WHERE relation.oid = ANY (ARRAY[revisions, revisions_seq])
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: PUBLIC can access thought revision history.';
  END IF;

  IF NOT COALESCE((
       SELECT relrowsecurity AND relforcerowsecurity
       FROM pg_class WHERE oid = revisions
     ), false)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polrelid = revisions AND polname = 'thought_revisions_app_head'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: public.thought_revisions must be under forced RLS with the thought_revisions_app_head policy.';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Spaces add a registry plus three privileged helper functions. The app may
-- read (not administer) the registry and execute exactly the helpers it needs;
-- no function may retain PostgreSQL's default PUBLIC execute grant. The
-- audience-move helper additionally bridges the single-audience RLS policy as
-- the table owner, so its definer/owner/search_path shape is pinned exactly
-- like the native-auth lifecycle functions.
DO $$
DECLARE
  audience_fn oid := to_regprocedure(
    'memory_scope.audience_matches(text,text,memory_scope.visibility,text)'
  );
  search_fn oid := to_regprocedure(
    'memory_scope.search_thought_candidates(vector,double precision,text,text,boolean,jsonb,jsonb,integer)'
  );
  move_fn oid := to_regprocedure(
    'memory_scope.move_thought(uuid,text,text,memory_scope.visibility,text,text)'
  );
  thoughts_owner oid;
  fn oid;
BEGIN
  IF audience_fn IS NULL OR search_fn IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: memory_scope helper functions are missing; apply db/06-spaces.sql first.';
  END IF;
  IF move_fn IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: memory_scope.move_thought is missing; apply db/10-thought-mutations.sql first.';
  END IF;

  SELECT relowner INTO thoughts_owner
  FROM pg_class WHERE oid = 'public.thoughts'::regclass;
  IF NOT COALESCE((
       SELECT prosecdef
         AND proowner = thoughts_owner
         AND COALESCE(proconfig, ARRAY[]::text[])
               @> ARRAY['search_path=pg_catalog']
       FROM pg_proc WHERE oid = move_fn
     ), false) THEN
    RAISE EXCEPTION
      'grants assertion failed: memory_scope.move_thought must be SECURITY DEFINER, owned by the thoughts table owner, with search_path pinned to pg_catalog.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) acl
    WHERE p.oid = move_fn
      AND acl.grantee <> p.proowner
      AND acl.grantee <> to_regrole('openbrain_app')
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: memory_scope.move_thought is executable by a role other than openbrain_app.';
  END IF;

  IF NOT has_schema_privilege('openbrain_app', 'memory_scope', 'USAGE')
     OR NOT has_table_privilege(
       'openbrain_app', 'memory_scope.workspace', 'SELECT'
     )
     OR NOT has_table_privilege(
       'openbrain_app', 'memory_scope.project', 'SELECT'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app is missing read/usage access to the memory_scope registry.';
  END IF;
  IF has_table_privilege(
       'openbrain_app', 'memory_scope.workspace',
       'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     )
     OR has_table_privilege(
       'openbrain_app', 'memory_scope.project',
       'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app can mutate the memory_scope registry.';
  END IF;

  FOREACH fn IN ARRAY ARRAY[audience_fn, search_fn, move_fn] LOOP
    IF NOT has_function_privilege('openbrain_app', fn, 'EXECUTE') THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_app cannot execute required function %.',
        fn::regprocedure;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) acl
      WHERE p.oid = fn
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'grants assertion failed: PUBLIC can execute privileged function %.',
        fn::regprocedure;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Default ACLs are standing instructions, not observed relation grants. A
-- snapshot-only scan would pass until the next object materialized the
-- privilege, so reject future relation/sequence access granted to PUBLIC in
-- every non-system schema.
DO $$
DECLARE
  bad_default_acls TEXT;
BEGIN
  SELECT string_agg(
           default_grant.description,
           ', ' ORDER BY default_grant.description
         )
    INTO bad_default_acls
  FROM (
    SELECT DISTINCT format(
      '%s on future %s in %s (owner %I)',
      a.privilege_type,
      CASE d.defaclobjtype WHEN 'S' THEN 'sequences' ELSE 'relations' END,
      CASE
        WHEN d.defaclnamespace = 0 THEN 'all schemas'
        ELSE format('schema %I', n.nspname)
      END,
      owner_role.rolname
    ) AS description
    FROM pg_default_acl d
    JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype IN ('r', 'S')
      AND a.grantee = 0
      AND (
        d.defaclnamespace = 0
        OR (n.nspname <> 'information_schema' AND n.nspname !~ '^pg_')
      )
  ) default_grant;

  IF bad_default_acls IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: default privileges would grant future relations '
      'or sequences to PUBLIC: %. Revoke the standing default grant before '
      'deploying.',
      bad_default_acls;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Funnel-log breakout invariants. The sink-only roles and relations belong only to
-- the dedicated log-sink cluster. Keeping this check in the corpus's final
-- assertion turns the old shared-database shape into an init/upgrade failure,
-- including when an operator skipped part of the retirement runbook.
DO $$
DECLARE
  bad_roles     TEXT;
  bad_relations TEXT;
  bad_hba       TEXT;
  hba_errors    TEXT;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname)
    INTO bad_roles
  FROM pg_roles
  WHERE rolname IN (
    'openbrain_ingester',
    'openbrain_monitor',
    'openbrain_logs_rollup'
  );

  IF bad_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: corpus contains sink-only role(s): %. '
      'Cut Pattern B over to its log sink, remove matching pg_hba rules, then '
      'apply db/09-retire-corpus-funnel.sql.',
      bad_roles;
  END IF;

  SELECT string_agg(
           format('%I.%I (%s)', n.nspname, c.relname, c.relkind),
           ', ' ORDER BY c.relname
         )
    INTO bad_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname LIKE 'funnel_access_%';

  IF bad_relations IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: corpus contains retired Funnel relation(s): %. '
      'Export and verify every matching relation; remove any noncanonical '
      'archive-like relation explicitly, truncate the two canonical legacy '
      'tables, then apply db/09-retire-corpus-funnel.sql.',
      bad_relations;
  END IF;

  SELECT string_agg(
           format('line %s: %s', line_number, error),
           '; ' ORDER BY line_number
         )
    INTO hba_errors
  FROM pg_hba_file_rules
  WHERE error IS NOT NULL;

  IF hba_errors IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: pg_hba.conf has parse errors, so retired-role '
      'absence cannot be proven: %.',
      hba_errors;
  END IF;

  SELECT string_agg(
           format(
             'line %s (%s)',
             h.line_number,
             array_to_string(h.user_name, ',')
           ),
           ', ' ORDER BY h.line_number
         )
    INTO bad_hba
  FROM pg_hba_file_rules h
  WHERE EXISTS (
    SELECT 1
    FROM unnest(COALESCE(h.user_name, ARRAY[]::TEXT[])) AS configured(role_name)
    WHERE ltrim(configured.role_name, '+') IN (
            'openbrain_ingester',
            'openbrain_monitor',
            'openbrain_logs_rollup'
          )
       OR left(configured.role_name, 1) IN ('/', '@')
  );

  IF bad_hba IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: corpus pg_hba.conf names a retired sink-only '
      'role or uses an unprovable regex/@file user token: %. Replace those '
      'rules with explicit corpus-role names and rerun this assertion; reload '
      'Postgres separately before restoring service.',
      bad_hba;
  END IF;
END;
$$ LANGUAGE plpgsql;
