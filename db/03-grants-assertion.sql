-- invariant assertions for role grants: openbrain_app on public.thoughts,
-- and (when the role exists) the SELECT-only openbrain_monitor.
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
--   1. Fresh init: docker-entrypoint-initdb.d runs files in lexical
--      order. 01- establishes grants, 02- adds observability grants,
--      03- asserts. If a future change to 02-observability.sql (or
--      any later file) accidentally widens openbrain_app's grants on
--      `public.thoughts`, init fails loudly.
--   2. Drift check against a deployed DB: an operator can run this
--      file standalone (`psql -f db/03-grants-assertion.sql`) against
--      a live DB and the assertion exercises the LIVE catalog state
--      without mutating anything — no REVOKE+GRANT to wipe the drift
--      first. This is the intended contract.
--
-- Invariants checked:
--   (a) `openbrain_app` must NOT have DELETE on `public.thoughts`.
--   (b) `openbrain_app` MUST have SELECT, INSERT, UPDATE on
--       `public.thoughts`.
--
-- We don't try to enforce a schema-wide invariant — 02-observability.sql
-- legitimately grants additional tables to openbrain_app and we don't
-- want to couple this file to that one's grant list.

DO $$
BEGIN
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
END;
$$ LANGUAGE plpgsql;

-- openbrain_monitor invariants (checked only when the role exists — it is
-- optional, created by 00-roles.sh when OPENBRAIN_MONITOR_PASSWORD is set).
-- This credential lives on the internet-adjacent ingress qube, so the
-- invariant that matters is a NEGATIVE one:
--   (a) NO privilege of any kind on `public.thoughts` — a popped edge must
--       not be able to read (or touch) memories with the monitor credential;
--   (b) read-only on its two metadata tables: SELECT on funnel_access_log
--       and mcp_auth_events, and no INSERT/UPDATE/DELETE on either.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor') THEN
    RAISE NOTICE 'openbrain_monitor role missing; skipping monitor grants assertion';
    RETURN;
  END IF;
  IF has_table_privilege('openbrain_monitor', 'public.thoughts', 'SELECT')
      OR has_table_privilege('openbrain_monitor', 'public.thoughts', 'INSERT')
      OR has_table_privilege('openbrain_monitor', 'public.thoughts', 'UPDATE')
      OR has_table_privilege('openbrain_monitor', 'public.thoughts', 'DELETE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor has privileges on public.thoughts. '
      'The edge-resident monitor credential must never reach thought content.';
  END IF;
  IF NOT (has_table_privilege('openbrain_monitor', 'public.funnel_access_log', 'SELECT')
      AND has_table_privilege('openbrain_monitor', 'public.mcp_auth_events', 'SELECT')) THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor missing SELECT on funnel_access_log/mcp_auth_events '
      '(did 02-observability.sql run after the role was created?).';
  END IF;
  IF has_table_privilege('openbrain_monitor', 'public.funnel_access_log', 'INSERT')
      OR has_table_privilege('openbrain_monitor', 'public.funnel_access_log', 'UPDATE')
      OR has_table_privilege('openbrain_monitor', 'public.funnel_access_log', 'DELETE')
      OR has_table_privilege('openbrain_monitor', 'public.mcp_auth_events', 'INSERT')
      OR has_table_privilege('openbrain_monitor', 'public.mcp_auth_events', 'UPDATE')
      OR has_table_privilege('openbrain_monitor', 'public.mcp_auth_events', 'DELETE') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor has write privileges on an observability table; '
      'it must stay SELECT-only.';
  END IF;
END;
$$ LANGUAGE plpgsql;
