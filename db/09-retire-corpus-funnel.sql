-- One-time retirement of the legacy Funnel tables and sink-only roles from the
-- corpus cluster. Run as a database superuser only after Pattern B writes,
-- monitoring, and retention have moved to the dedicated log sink.
--
-- This migration intentionally does NOT archive or truncate data. If either
-- legacy table contains a row, it aborts the whole transaction. The operator
-- must first export both tables to trusted encrypted storage, verify that
-- archive, and explicitly TRUNCATE the archived tables before rerunning this
-- file. That makes a skipped archive a hard stop instead of an implicit DROP.
--
-- The migration is idempotent on a fresh or already-retired corpus. Every
-- destructive statement uses the default RESTRICT behavior, and the role
-- drops are in the same transaction: an unexpected dependency rolls the table
-- drops back instead of cascading through an unreviewed object.

\set ON_ERROR_STOP on

BEGIN;

-- Pin the visibility rule before any catalog read. In particular, the
-- emptiness guard below must see rows committed by a writer that the exclusive
-- lock had to wait for.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

DO $superuser_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = current_user
      AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'db/09-retire-corpus-funnel.sql must run as a database superuser; current_user=%',
      current_user;
  END IF;
END;
$superuser_guard$ LANGUAGE plpgsql;

-- Acquire the strongest lock on every canonical legacy table, in a stable
-- order, before deciding that it is empty. A writer that began first is allowed
-- to finish and is then visible to the next statement's READ COMMITTED snapshot;
-- later writers wait behind this transaction and cannot land between the check
-- and DROP TABLE.
DO $lock_legacy_tables$
DECLARE
  relation_name REGCLASS;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    to_regclass('public.funnel_access_log'),
    to_regclass('public.funnel_access_summary')
  ]
  LOOP
    CONTINUE WHEN relation_name IS NULL;
    EXECUTE format(
      'LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',
      relation_name
    );
  END LOOP;
END;
$lock_legacy_tables$ LANGUAGE plpgsql;

DO $retirement_guard$
DECLARE
  raw_relation         REGCLASS := to_regclass('public.funnel_access_log');
  summary_relation     REGCLASS := to_regclass('public.funnel_access_summary');
  relation_name        REGCLASS;
  has_rows             BOOLEAN;
  bad_hba              TEXT;
  hba_errors           TEXT;
  active_roles         TEXT;
  unexpected_relations TEXT;
BEGIN
  SELECT string_agg(
           format('line %s: %s', line_number, error),
           '; ' ORDER BY line_number
         )
    INTO hba_errors
  FROM pg_hba_file_rules
  WHERE error IS NOT NULL;

  IF hba_errors IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing corpus Funnel retirement: pg_hba.conf has parse errors, so '
      'edge-role absence cannot be proven: %',
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
      'refusing corpus Funnel retirement: pg_hba.conf still names retired '
      'sink-only role(s), or uses an unprovable regex/@file user token: %. '
      'Replace those rules with explicit corpus-role names and rerun; reload '
      'Postgres separately before restoring service.',
      bad_hba;
  END IF;

  SELECT string_agg(
           format('%s (pid %s)', usename, pid),
           ', ' ORDER BY usename, pid
         )
    INTO active_roles
  FROM pg_stat_activity
  WHERE usename IN (
          'openbrain_ingester',
          'openbrain_monitor',
          'openbrain_logs_rollup'
        )
    AND pid <> pg_backend_pid();

  IF active_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing corpus Funnel retirement: sink-only role sessions are still '
      'connected: %. Cut the writers/readers over to the sink and retry.',
      active_roles;
  END IF;

  -- The final corpus assertion rejects every public.funnel_access_% relation,
  -- not only the two historical tables. Refuse an archive-like table/view here
  -- before committing the canonical drops. Owned sequences and indexes are
  -- expected dependencies of those tables and disappear with their owner.
  SELECT string_agg(
           format('%I.%I (%s)', n.nspname, c.relname, c.relkind),
           ', ' ORDER BY c.relname
         )
    INTO unexpected_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname LIKE 'funnel_access_%'
    AND NOT (
      c.oid = ANY(array_remove(
        ARRAY[raw_relation::OID, summary_relation::OID],
        NULL::OID
      ))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indexrelid = c.oid
        AND i.indrelid = ANY(array_remove(
          ARRAY[raw_relation::OID, summary_relation::OID],
          NULL::OID
        ))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend d
      WHERE d.classid = 'pg_class'::REGCLASS
        AND d.objid = c.oid
        AND d.refclassid = 'pg_class'::REGCLASS
        AND d.refobjid = ANY(array_remove(
          ARRAY[raw_relation::OID, summary_relation::OID],
          NULL::OID
        ))
        AND d.deptype IN ('a', 'i')
    );

  IF unexpected_relations IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing corpus Funnel retirement: unexpected matching relation(s): %. '
      'Export and verify their contents, then remove them explicitly before '
      'rerunning; this migration retires only the two canonical legacy tables '
      'and their owned indexes/sequences.',
      unexpected_relations;
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    raw_relation,
    summary_relation
  ]
  LOOP
    CONTINUE WHEN relation_name IS NULL;
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s LIMIT 1)',
      relation_name
    ) INTO has_rows;

    IF has_rows THEN
      RAISE EXCEPTION
        'refusing corpus Funnel retirement: % is nonempty. Export it to trusted '
        'encrypted storage, verify the archive, TRUNCATE the table explicitly, '
        'then rerun this migration.',
        relation_name;
    END IF;
  END LOOP;
END;
$retirement_guard$ LANGUAGE plpgsql;

-- No CASCADE: a dependent view or other unexpected object aborts and rolls the
-- transaction back for inspection.
DROP TABLE IF EXISTS public.funnel_access_summary;
DROP TABLE IF EXISTS public.funnel_access_log;

-- v3 briefly granted the monitor direct SELECT on mcp_auth_events. Revoke that
-- known historical dependency without DROP OWNED (which can delete objects a
-- role owns). Any other dependency makes DROP ROLE fail and rolls back.
DO $revoke_historical_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor')
     AND to_regclass('public.mcp_auth_events') IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON TABLE public.mcp_auth_events FROM openbrain_monitor';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_ingester')
     AND to_regclass('public.mcp_auth_events') IS NOT NULL THEN
    EXECUTE
      'REVOKE ALL PRIVILEGES ON TABLE public.mcp_auth_events FROM openbrain_ingester';
  END IF;
END;
$revoke_historical_grants$ LANGUAGE plpgsql;

DROP ROLE IF EXISTS openbrain_monitor;
DROP ROLE IF EXISTS openbrain_ingester;
DROP ROLE IF EXISTS openbrain_logs_rollup;

COMMIT;
