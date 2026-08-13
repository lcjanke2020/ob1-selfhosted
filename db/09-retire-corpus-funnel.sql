-- One-time retirement of the legacy Funnel tables and edge roles from the
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

DO $retirement_guard$
DECLARE
  relation_name REGCLASS;
  has_rows      BOOLEAN;
  bad_hba       TEXT;
  hba_errors    TEXT;
  active_roles  TEXT;
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
    WHERE ltrim(configured.role_name, '+')
          IN ('openbrain_ingester', 'openbrain_monitor')
  );

  IF bad_hba IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing corpus Funnel retirement: pg_hba.conf still names retired '
      'edge role(s): %. Remove those rules, reload Postgres, and rerun.',
      bad_hba;
  END IF;

  SELECT string_agg(
           format('%s (pid %s)', usename, pid),
           ', ' ORDER BY usename, pid
         )
    INTO active_roles
  FROM pg_stat_activity
  WHERE usename IN ('openbrain_ingester', 'openbrain_monitor')
    AND pid <> pg_backend_pid();

  IF active_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'refusing corpus Funnel retirement: retired edge role sessions are still '
      'connected: %. Cut the writers/readers over to the sink and retry.',
      active_roles;
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    to_regclass('public.funnel_access_log'),
    to_regclass('public.funnel_access_summary')
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

COMMIT;
