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
--       and mcp_auth_events, and nothing else.
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
-- The allowed SELECT on the two observability tables must also be plain —
-- WITH GRANT OPTION is rejected, or the monitor could re-grant its own
-- access (e.g. to PUBLIC) and the widened grant would sit outside this
-- file's per-role reasoning.
DO $$
DECLARE
  tbl  text;
  bad  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor') THEN
    RAISE NOTICE 'openbrain_monitor role missing; skipping monitor grants assertion';
    RETURN;
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

  -- (a) public.thoughts: zero ACL entries of any kind, table or column level,
  --     to the monitor OR to PUBLIC (grantee oid 0 — implicit for every role)…
  IF EXISTS (
       SELECT 1 FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.thoughts'::regclass
         AND (a.grantee = 'openbrain_monitor'::regrole OR a.grantee = 0))
     OR EXISTS (
       SELECT 1 FROM pg_attribute att
       CROSS JOIN LATERAL aclexplode(att.attacl) a
       WHERE att.attrelid = 'public.thoughts'::regclass
         AND (a.grantee = 'openbrain_monitor'::regrole OR a.grantee = 0)) THEN
    RAISE EXCEPTION
      'grants assertion failed: public.thoughts has a direct grant (table- or '
      'column-level) to openbrain_monitor or to PUBLIC. The edge-resident monitor '
      'credential must never reach thought content.';
  END IF;
  -- …and no effective privilege either (catches routes the ACL scan cannot see).
  IF has_table_privilege('openbrain_monitor', 'public.thoughts',
       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('openbrain_monitor', 'public.thoughts',
       'SELECT, INSERT, UPDATE, REFERENCES') THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor has an effective privilege on '
      'public.thoughts. The edge-resident monitor credential must never reach '
      'thought content.';
  END IF;

  -- (b) the two observability tables: SELECT present, and nothing but SELECT.
  FOREACH tbl IN ARRAY ARRAY['public.funnel_access_log', 'public.mcp_auth_events'] LOOP
    IF NOT has_table_privilege('openbrain_monitor', tbl, 'SELECT') THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_monitor missing SELECT on % '
        '(did 02-observability.sql run after the role was created?).', tbl;
    END IF;
    IF has_table_privilege('openbrain_monitor', tbl,
         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_table_privilege('openbrain_monitor', tbl, 'SELECT WITH GRANT OPTION') THEN
      RAISE EXCEPTION
        'grants assertion failed: openbrain_monitor has an effective non-SELECT '
        '(or grantable-SELECT) privilege on %; it must stay plain SELECT-only.', tbl;
    END IF;
    -- Direct entries to the monitor or PUBLIC that are anything other than a
    -- plain, non-grantable SELECT.
    SELECT string_agg(DISTINCT a.privilege_type
             || CASE WHEN a.is_grantable THEN ' (WITH GRANT OPTION)' ELSE '' END,
             ', ') INTO bad
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = tbl::regclass
        AND (a.grantee = 'openbrain_monitor'::regrole OR a.grantee = 0)
        AND (a.privilege_type <> 'SELECT' OR a.is_grantable);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION
        'grants assertion failed: % has direct grants beyond plain SELECT to '
        'openbrain_monitor or PUBLIC (%) — the monitor must stay plain SELECT-only.', tbl, bad;
    END IF;
    IF EXISTS (
         SELECT 1 FROM pg_attribute att
         CROSS JOIN LATERAL aclexplode(att.attacl) a
         WHERE att.attrelid = tbl::regclass
           AND (a.grantee = 'openbrain_monitor'::regrole OR a.grantee = 0)) THEN
      RAISE EXCEPTION
        'grants assertion failed: % has column-level grants to openbrain_monitor '
        'or PUBLIC — only a plain table-level SELECT is expected.', tbl;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
