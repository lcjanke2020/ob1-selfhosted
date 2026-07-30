-- invariant assertions for protected role grants: openbrain_app must be a
-- standalone, non-bypass role with its intended public.thoughts access, and
-- (when the role exists) openbrain_monitor must stay inside its SELECT-only
-- relation allowlist.
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
--      provisioning applies 01-, 02-, 04-, 05-, 06-, and 07-, then invokes
--      this stable source path last. In both cases the assertion sees the
--      completed catalog, so an init file that widens a protected role fails
--      loudly.
--   2. Drift check against a deployed DB: an operator can run this
--      file standalone (`psql -f db/03-grants-assertion.sql`) against
--      a live DB and the assertion exercises the LIVE catalog state
--      without mutating anything — no REVOKE+GRANT to wipe the drift
--      first. This is the intended contract.
--
-- Invariants checked:
--   (a) `openbrain_app` must have no role memberships and must not be a
--       superuser or hold BYPASSRLS directly.
--   (b) `openbrain_app` must NOT have DELETE on `public.thoughts`.
--   (c) `openbrain_app` MUST have SELECT, INSERT, UPDATE on
--       `public.thoughts`.
--   (d) the app may read but not mutate the memory-space registry, and only
--       it may execute the two reviewed memory_scope helpers (never PUBLIC or
--       the edge-resident monitor).
--   (e) metadata degradation history is append-only to the app; its transient
--       outbox is enqueue/consume-only, and only the singleton notification
--       ledger is otherwise mutable.
--
-- The openbrain_app check is deliberately scoped to thoughts:
-- 02-observability.sql and 04-sessions.sql legitimately grant it access to
-- other application tables. The monitor check below is deliberately the
-- inverse: it permits one small relation allowlist and rejects everything
-- else in every non-system schema.

DO $$
DECLARE
  memberships text;
BEGIN
  IF (
    SELECT rolsuper OR rolbypassrls
    FROM pg_roles WHERE rolname = 'openbrain_app'
  ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app can bypass row-level security.';
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
      AND has_table_privilege('openbrain_app', 'public.thoughts', 'INSERT')
      AND has_table_privilege('openbrain_app', 'public.thoughts', 'UPDATE')) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_app missing required SELECT/INSERT/UPDATE on public.thoughts.';
  END IF;

  IF to_regclass('public.metadata_degradation_events') IS NULL
     OR to_regclass('public.metadata_degradation_outbox') IS NULL
     OR to_regclass('public.metadata_degradation_notification_state') IS NULL
     OR to_regclass('public.metadata_degradation_events_id_seq') IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: metadata degradation schema is missing; apply db/07-metadata-degradation.sql first.';
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

-- Spaces add a registry plus two privileged helper functions. The app may
-- read (not administer) the registry and execute exactly the helpers it needs;
-- neither function may retain PostgreSQL's default PUBLIC execute grant.
DO $$
DECLARE
  audience_fn oid := to_regprocedure(
    'memory_scope.audience_matches(text,text,memory_scope.visibility,text)'
  );
  search_fn oid := to_regprocedure(
    'memory_scope.search_thought_candidates(vector,double precision,text,text,boolean,jsonb,jsonb,integer)'
  );
  fn oid;
BEGIN
  IF audience_fn IS NULL OR search_fn IS NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: memory_scope helper functions are missing; apply db/06-spaces.sql first.';
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

  FOREACH fn IN ARRAY ARRAY[audience_fn, search_fn] LOOP
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

-- openbrain_monitor invariants (checked only when the role exists — it is
-- optional, created by 00-roles.sh when OPENBRAIN_MONITOR_PASSWORD is set).
-- This credential lives on the internet-adjacent ingress qube, so the
-- invariant that matters is a NEGATIVE one: the monitor has plain SELECT on
-- its two metadata relations and no privilege on any other application
-- relation, including relations outside `public` and ones added later.
--
-- Enforcement is deliberately belt-and-braces, because each mechanism has a
-- blind spot the other covers:
--   * direct-ACL scans (aclexplode over pg_class.relacl + pg_attribute.attacl)
--     see EVERY privilege type the server knows — including TRUNCATE,
--     REFERENCES, TRIGGER, PG17's MAINTAIN, and whatever a future major adds —
--     and column-level grants, without this file naming (and lagging) the
--     privilege list. The scans match grants to the role AND to PUBLIC:
--     PUBLIC is implicit for every role, never appears in pg_auth_members,
--     and an unlistable privilege granted to PUBLIC (e.g. MAINTAIN on PG17)
--     would otherwise reach the monitor invisibly. Blind spot: privileges
--     inherited via role membership.
--   * has_table_privilege()/has_any_column_privilege() check EFFECTIVE
--     privileges (inheritance and PUBLIC included). Blind spot: only the
--     privilege types named in the call.
--   * a membership check closes the inheritance route generically: the
--     monitor is designed as a standalone LOGIN role, so ANY membership is
--     drift (e.g. GRANT openbrain_readonly TO openbrain_monitor would hand it
--     thoughts without touching an ACL this file scans).
-- System catalogs are excluded: PostgreSQL intentionally exposes many of
-- those through PUBLIC. User/application schemas (including `sessions`) are
-- all in scope. Table-like relations and sequences are checked; ownership is
-- also access and therefore rejected outside the allowlist.
--
-- The two reviewed memory_scope functions receive explicit checks above. This
-- still is not generic proof that every future callable object is safe:
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, so every
-- future SECURITY DEFINER routine must revoke that default, extend the
-- assertion, and receive a separate security review before deployment.
--
-- The allowed SELECT on the two observability tables must also be plain —
-- WITH GRANT OPTION is rejected, or the monitor could re-grant its own
-- access (e.g. to PUBLIC) and the widened grant would sit outside this
-- file's per-role reasoning.
DO $$
DECLARE
  allowed_relations oid[];
  monitor_oid   oid;
  rel_oid       oid;
  relation_name text;
  bad           text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor') THEN
    RAISE NOTICE 'openbrain_monitor role missing; skipping monitor grants assertion';
    RETURN;
  END IF;

  -- The monitor relation allowlist. State it once; both the global negative
  -- scan and the required-grant checks below consume these same OIDs. Resolve
  -- it only after the optional-role guard so monitor-free installs still skip.
  allowed_relations := ARRAY[
    'public.funnel_access_log'::regclass::oid,
    'public.mcp_auth_events'::regclass::oid
  ];

  SELECT oid INTO monitor_oid
    FROM pg_roles WHERE rolname = 'openbrain_monitor';

  IF has_schema_privilege(monitor_oid, 'memory_scope', 'USAGE')
     OR has_function_privilege(
       monitor_oid,
       'memory_scope.audience_matches(text,text,memory_scope.visibility,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       monitor_oid,
       'memory_scope.search_thought_candidates(vector,double precision,text,text,boolean,jsonb,jsonb,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor can use the memory_scope schema or its privileged functions.';
  END IF;

  -- No role memberships: everything below reasons about direct grants, and
  -- membership would smuggle in another role's privileges wholesale.
  SELECT string_agg(roleid::regrole::text, ', ') INTO bad
    FROM pg_auth_members WHERE member = 'openbrain_monitor'::regrole;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor is a member of: % — it must be a '
      'standalone role (membership would bypass the per-table checks).', bad;
  END IF;

  -- Default ACLs are standing instructions, not observed relation grants. A
  -- snapshot-only scan would pass until the next object materialized the
  -- privilege, so reject relation/sequence defaults aimed at the monitor or
  -- PUBLIC before they can create that delayed drift.
  SELECT string_agg(default_grant.description, ', ' ORDER BY default_grant.description)
    INTO bad
    FROM (
      SELECT DISTINCT format(
        '%s on future %s in %s (owner %I, granted to %s)',
        a.privilege_type,
        CASE d.defaclobjtype WHEN 'S' THEN 'sequences' ELSE 'relations' END,
        CASE
          WHEN d.defaclnamespace = 0 THEN 'all schemas'
          ELSE format('schema %I', n.nspname)
        END,
        owner_role.rolname,
        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE 'openbrain_monitor' END
      ) AS description
      FROM pg_default_acl d
      JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclobjtype IN ('r', 'S')
        AND (a.grantee = monitor_oid OR a.grantee = 0)
        AND (
          d.defaclnamespace = 0
          OR (n.nspname <> 'information_schema' AND n.nspname !~ '^pg_')
        )
    ) default_grant;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: default privileges would grant future relations '
      'or sequences to openbrain_monitor or PUBLIC: %. Revoke the standing '
      'default grant before deploying.', bad;
  END IF;

  -- Enumerate every non-system relation the monitor can touch, then subtract
  -- the allowlist. Direct ACL checks are future-proof for new privilege types;
  -- the effective checks independently cross-check today's named privilege
  -- types. Membership is forbidden above, so no transitive role can hide an
  -- unknown effective privilege from the direct scans.
  SELECT string_agg(unexpected.qualified_name, ', ' ORDER BY unexpected.qualified_name)
    INTO bad
    FROM (
      SELECT format(
        '%I.%I%s',
        n.nspname,
        c.relname,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM aclexplode(c.relacl) public_acl
            WHERE public_acl.grantee = 0
          ) OR EXISTS (
            SELECT 1
            FROM pg_attribute att
            CROSS JOIN LATERAL aclexplode(att.attacl) public_acl
            WHERE att.attrelid = c.oid
              AND public_acl.grantee = 0
          ) THEN ' (via PUBLIC)'
          ELSE ''
        END
      ) AS qualified_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
        AND NOT (c.oid = ANY (allowed_relations))
        AND (
          c.relowner = monitor_oid
          OR EXISTS (
            SELECT 1
            FROM aclexplode(c.relacl) a
            WHERE a.grantee = monitor_oid OR a.grantee = 0
          )
          OR EXISTS (
            SELECT 1
            FROM pg_attribute att
            CROSS JOIN LATERAL aclexplode(att.attacl) a
            WHERE att.attrelid = c.oid
              AND (a.grantee = monitor_oid OR a.grantee = 0)
          )
          OR CASE
            WHEN c.relkind = 'S' THEN
              has_sequence_privilege(monitor_oid, c.oid, 'USAGE, SELECT, UPDATE')
            ELSE
              has_table_privilege(
                monitor_oid,
                c.oid,
                'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
              )
          END
          OR (
            c.relkind <> 'S'
            AND has_any_column_privilege(
              monitor_oid,
              c.oid,
              'SELECT, INSERT, UPDATE, REFERENCES'
            )
          )
        )
    ) unexpected;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor has a direct or effective '
      'privilege on relation(s) outside its allowlist: %. The edge-resident '
      'monitor credential must reach only its two observability relations.', bad;
  END IF;

  -- The two allowlisted observability relations: SELECT present, and nothing
  -- but SELECT. The same array powered the negative scan above.
  FOREACH rel_oid IN ARRAY allowed_relations LOOP
    SELECT format('%I.%I', n.nspname, c.relname) INTO relation_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = rel_oid;

    IF NOT has_table_privilege(monitor_oid, rel_oid, 'SELECT') THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_monitor missing SELECT on % '
        '(did 02-observability.sql run after the role was created?).', relation_name;
    END IF;
    IF has_table_privilege(monitor_oid, rel_oid,
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_table_privilege(monitor_oid, rel_oid, 'SELECT WITH GRANT OPTION') THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_monitor has an effective non-SELECT '
        '(or grantable-SELECT) privilege on %; it must stay plain SELECT-only.', relation_name;
    END IF;
    -- Direct entries to the monitor or PUBLIC that are anything other than a
    -- plain, non-grantable SELECT.
    SELECT string_agg(DISTINCT a.privilege_type
             || CASE WHEN a.is_grantable THEN ' (WITH GRANT OPTION)' ELSE '' END,
             ', ') INTO bad
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = rel_oid
        AND (a.grantee = monitor_oid OR a.grantee = 0)
        AND (a.privilege_type <> 'SELECT' OR a.is_grantable);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION
        'grants assertion failed: % has direct grants beyond plain SELECT to '
        'openbrain_monitor or PUBLIC (%) — the monitor must stay plain SELECT-only.', relation_name, bad;
    END IF;
    IF EXISTS (
         SELECT 1 FROM pg_attribute att
         CROSS JOIN LATERAL aclexplode(att.attacl) a
         WHERE att.attrelid = rel_oid
           AND (a.grantee = monitor_oid OR a.grantee = 0)) THEN
      RAISE EXCEPTION
        'grants assertion failed: % has column-level grants to openbrain_monitor '
        'or PUBLIC — only a plain table-level SELECT is expected.', relation_name;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
