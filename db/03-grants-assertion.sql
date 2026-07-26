-- invariant assertions for role grants: openbrain_app on public.thoughts,
-- and (when the role exists) the relation allowlist for the SELECT-only
-- openbrain_monitor.
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
--   1. Fresh init: the supported Compose/CI paths mount this source file as
--      99-grants-assertion.sql, after every schema migration. 01- establishes
--      grants, 02- adds observability grants, later files add their schemas,
--      and 99- asserts the completed catalog. If any init file accidentally
--      widens a protected role, init fails loudly.
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
-- The openbrain_app check is deliberately scoped to thoughts:
-- 02-observability.sql and 04-sessions.sql legitimately grant it access to
-- other application tables. The monitor check below is deliberately the
-- inverse: it permits one small relation allowlist and rejects everything
-- else in every non-system schema.

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

  -- No role memberships: everything below reasons about direct grants, and
  -- membership would smuggle in another role's privileges wholesale.
  SELECT string_agg(roleid::regrole::text, ', ') INTO bad
    FROM pg_auth_members WHERE member = 'openbrain_monitor'::regrole;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'grants assertion failed: openbrain_monitor is a member of: % — it must be a '
      'standalone role (membership would bypass the per-table checks).', bad;
  END IF;

  -- Enumerate every non-system relation the monitor can touch, then subtract
  -- the allowlist. Direct ACL checks are future-proof for new privilege types;
  -- the effective checks cover PUBLIC/inherited semantics for today's types.
  -- Membership is forbidden above, so no transitive role can hide an unknown
  -- effective privilege from the direct scans.
  SELECT string_agg(unexpected.qualified_name, ', ' ORDER BY unexpected.qualified_name)
    INTO bad
    FROM (
      SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
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
