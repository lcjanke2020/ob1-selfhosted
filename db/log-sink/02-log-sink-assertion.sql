-- Completed-catalog assertions for the ingress qube's local log sink.
--
-- Run as the final catalog check during init (the entrypoint sees it as 99-…;
-- only the zz- completion-marker script follows), and re-run by hand after any
-- change to 01-log-sink.sql or 02-log-sink-status-class.sql. Counterpart to
-- db/03-grants-assertion.sql on the corpus. This is a trusted deployment gate
-- and a point-in-time drift check, not a control over the superuser that runs
-- it: a full database superuser can read or alter the sink, skip this file, or
-- undo its result. This SQL validates database authorization and topology;
-- runtime containment also depends on the separately verified socket/SCRAM
-- boundary.
--
-- The checked contract is intentionally ordinary and enforceable: this
-- cluster contains TWO persistent data tables, TWO required roles, and at most
-- one optional monitor role;
-- every table, sequence, and column privilege those roles hold is exactly
-- enumerated, grant options included (section 3), none of them holds a
-- cluster-level privilege (section 1), none has a CREATE route into schema
-- public or into this database (section 4), and the role set itself is
-- closed — nothing exists beyond the bootstrap superuser, the two required
-- roles, and the optional monitor (section 5). Sections 6-9 close indirect
-- routes the direct-ACL comparison cannot see: effective privileges arriving
-- via role membership, memberships themselves, ownership, default ACLs,
-- grants parked on a grantee outside the enumerated set, stray schemas, and
-- stray non-system routines or tables/views. EXECUTE defaults to PUBLIC and a
-- definer body runs as its owner, so a user-created routine is a data path that
-- needs no table grant at all.
--
-- Deliberately NOT asserted: PostgreSQL's stock PUBLIC defaults — database
-- CONNECT/TEMP, USAGE on schema public, EXECUTE on built-in functions. None
-- of those reaches the two data tables (section 3 pins their ACLs exactly);
-- asserting them away would mean fighting harmless defaults on every major
-- version instead of guarding the promise that matters. Section 4 separately
-- pins a direct TEMPORARY grant for the rollup so hardening PUBLIC cannot break
-- its transaction-local projection.
--
-- Why assert at all on a cluster whose contents are disposable: the sink sits
-- on the internet-facing qube. Its value is not the data — it is the promise
-- that popping the edge yields *only* request metadata. An accidental
-- `GRANT ALL ... TO PUBLIC`, a stray table, or a role that quietly became
-- superuser would each break that promise silently. These checks make it
-- break loudly at a trusted catalog gate instead.
--
-- Every boundary is closed-world: the file enumerates what is required and
-- permitted, then rejects the rest. An application table/view or privilege
-- added later is therefore caught without a growing denylist.

-- The runtime assertion cannot import a host-side JSON file: fresh-init and
-- adoption stream this SQL through psql in several deployment layouts. Keep
-- the unavoidable embedded copy below data-equivalent to role-contract.json,
-- including object key order. The checker in
-- scripts/ci/check_log_sink_roles.ts compares the two before any Docker fixture
-- starts. Every section below reads this one session-local
-- contract instead of repeating role arrays or privilege CASE expressions.
-- ROLE_CONTRACT_JSON_BEGIN
DO $contract_setup$
BEGIN
  PERFORM set_config(
    'openbrain.log_sink_role_contract',
    $role_contract$[
      {
        "key": "ingester",
        "name": "openbrain_ingester",
        "required": true,
        "password_env": "OPENBRAIN_INGESTER_PASSWORD",
        "database_privileges": "",
        "direct_privileges": "funnel_access_log=INSERT|funnel_access_log_id_seq=USAGE"
      },
      {
        "key": "rollup",
        "name": "openbrain_logs_rollup",
        "required": true,
        "password_env": "OPENBRAIN_LOGS_ROLLUP_PASSWORD",
        "database_privileges": "TEMPORARY",
        "direct_privileges": "funnel_access_log=DELETE,SELECT|funnel_access_summary=DELETE,INSERT,SELECT,UPDATE"
      },
      {
        "key": "monitor",
        "name": "openbrain_monitor",
        "required": false,
        "password_env": "OPENBRAIN_MONITOR_PASSWORD",
        "database_privileges": "",
        "direct_privileges": "funnel_access_log=SELECT"
      }
    ]$role_contract$,
    false
  );
END;
$contract_setup$ LANGUAGE plpgsql;
-- ROLE_CONTRACT_JSON_END

-- ---------- 1. No role on this cluster is privileged ----------------------
-- Excludes the bootstrap superuser (the container's POSTGRES_USER), which is
-- necessarily super and reserved for trusted administration, including init,
-- adoption, upgrades, and manual assertion runs.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(
           format('%I=%s', role.rolname, unsafe.attributes),
           ', ' ORDER BY role.rolname
         )
    INTO offender
  FROM pg_roles role
  CROSS JOIN LATERAL (
    SELECT concat_ws(
      '+',
      CASE WHEN role.rolsuper THEN 'SUPERUSER' END,
      CASE WHEN role.rolcreatedb THEN 'CREATEDB' END,
      CASE WHEN role.rolcreaterole THEN 'CREATEROLE' END,
      CASE WHEN role.rolreplication THEN 'REPLICATION' END,
      CASE WHEN role.rolbypassrls THEN 'BYPASSRLS' END
    ) AS attributes
  ) unsafe
  WHERE role.rolname LIKE 'openbrain%'
    AND unsafe.attributes <> '';

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: role attribute drift (%); the sink''s managed roles must be plain LOGIN roles',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. Exactly two persistent data tables, with these columns -----
-- The relation check keeps the corpus schema from ever being applied here by
-- mistake (a `thoughts` table on the edge would be the failure this whole
-- topology exists to prevent). The column check pins the contract consumed by
-- db/summarize_funnel.sql to 01-log-sink.sql plus the status-class migration.
DO $$
DECLARE
  actual          text;
  expected        text;
  invalid_tables  text;
  generation_kind text;
  generated_type  text;
  generated_expr  text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO actual
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%';

  IF actual IS DISTINCT FROM 'funnel_access_log, funnel_access_summary' THEN
    RAISE EXCEPTION
      'log sink: expected exactly (funnel_access_log, funnel_access_summary), found (%)',
      coalesce(actual, '<none>');
  END IF;

  -- This is a trusted-deployment G check, not an authorization boundary: an
  -- owner/superuser can replace either relation, but the final gate catches a
  -- same-name view or unlogged-table mistake before a migration is handed off.
  SELECT string_agg(
           format(
             '%I.%I(kind=%s,persistence=%s)',
             n.nspname,
             c.relname,
             c.relkind,
             c.relpersistence
           ),
           ', ' ORDER BY c.relname
         )
    INTO invalid_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('funnel_access_log', 'funnel_access_summary')
    AND (c.relkind <> 'r' OR c.relpersistence <> 'p');
  IF invalid_tables IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: data relations must be permanent base tables; found %',
      invalid_tables;
  END IF;

  SELECT string_agg(attname, ',' ORDER BY attnum) INTO actual
  FROM pg_attribute
  WHERE attrelid = 'public.funnel_access_log'::regclass AND attnum > 0 AND NOT attisdropped;
  expected := 'id,ts,socket,client_ip,method,path,status,duration_ms,bytes_out,'
           || 'user_agent,host_header,proto,tls_sni,caddy_logger,inserted_at,'
           || 'status_class';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'log sink: funnel_access_log columns drifted from db/log-sink/01-log-sink.sql + db/log-sink/02-log-sink-status-class.sql; expected (%), found (%)',
      expected, actual;
  END IF;

  SELECT
    a.attgenerated::text,
    format_type(a.atttypid, a.atttypmod),
    btrim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '[[:space:]]+', ' ', 'g'))
    INTO generation_kind, generated_type, generated_expr
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d
    ON d.adrelid = a.attrelid
   AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.funnel_access_log'::regclass
    AND a.attname = 'status_class'
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF generation_kind IS DISTINCT FROM 's' OR generated_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION
      'log sink: status_class must be a stored generated text column; found generation (%) type (%)',
      coalesce(generation_kind, '<missing>'),
      coalesce(generated_type, '<missing>');
  END IF;
  -- Pin the deparsed expression by fingerprint so the executable six-branch
  -- CASE remains defined only in 02-log-sink-status-class.sql. The boundary
  -- smoke pins behavior; if a PostgreSQL major changes deparsing, deliberately
  -- regenerate this value with the same pg_get_expr/md5 expression below.
  IF md5(coalesce(generated_expr, '')) <> '6201476046af4e199bf241a5ce4589e5' THEN
    RAISE EXCEPTION
      'log sink: status_class generated expression drifted; found (%)',
      coalesce(generated_expr, '<missing>');
  END IF;

  SELECT string_agg(attname, ',' ORDER BY attnum) INTO actual
  FROM pg_attribute
  WHERE attrelid = 'public.funnel_access_summary'::regclass AND attnum > 0 AND NOT attisdropped;
  expected := 'day,socket,status_class,request_count,unique_ips,duration_ms_p50,'
           || 'duration_ms_p95,top_paths,top_user_agents,computed_at';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'log sink: funnel_access_summary columns drifted from db/log-sink/01-log-sink.sql; expected (%), found (%)',
      expected, actual;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 3. Each role holds exactly its enumerated privileges ----------
-- Built from aclexplode over BOTH pg_class.relacl (table/sequence grants) and
-- pg_attribute.attacl (column grants), so every privilege type the server
-- knows is covered — including TRUNCATE, REFERENCES, TRIGGER, PG17's MAINTAIN
-- and whatever a future major adds — without this file naming them.
--
-- A grant held WITH GRANT OPTION renders as `PRIV*`: the expected sets below
-- contain no `*`, so a grantable privilege fails the comparison even when the
-- privilege itself is enumerated — the sink's roles must not be able to
-- forward their access.
--
-- Grants to PUBLIC (grantee OID 0) are folded into every role's actual set:
-- PUBLIC never appears in pg_auth_members but reaches all three roles, so a
-- `GRANT ... TO PUBLIC` would otherwise slip past a per-role comparison.
--
-- The bootstrap superuser owns both relations and therefore appears in relacl
-- with the full set; it is excluded because owner privileges are not a grant
-- this file governs.
DO $$
DECLARE
  r          record;
  actual     text;
  expected   text;
BEGIN
  FOR r IN
    SELECT role.rolname, contract.direct_privileges AS want
    FROM jsonb_to_recordset(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS contract(name text, direct_privileges text)
    JOIN pg_roles role ON role.rolname = contract.name
    ORDER BY role.rolname
  LOOP
    WITH acl AS (
      SELECT c.relname, (aclexplode(c.relacl)).*
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relacl IS NOT NULL
      UNION ALL
      SELECT c.relname, (aclexplode(a.attacl)).*
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND a.attacl IS NOT NULL
    ),
    mine AS (
      SELECT DISTINCT relname,
             privilege_type
               || CASE WHEN is_grantable THEN '*' ELSE '' END AS privilege_type
      FROM acl
      WHERE grantee = 0                                  -- PUBLIC reaches everyone
         OR grantee = (SELECT oid FROM pg_roles WHERE rolname = r.rolname)
    )
    SELECT string_agg(relname || '=' || privs, '|' ORDER BY relname) INTO actual
    FROM (
      SELECT relname, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM mine GROUP BY relname
    ) g;

    expected := r.want;
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION
        'log sink: role % privileges drifted; expected (%), found (%)',
        r.rolname, coalesce(expected, '<none>'), coalesce(actual, '<none>');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ---------- 4. Schema/database creation closed; rollup TEMPORARY pinned ----
-- The claim is about the three LOGIN roles, not about the schema's ACL in the
-- abstract: PostgreSQL 15+ ships `public` owned by `pg_database_owner` with
-- CREATE granted to it, which is the database owner (the bootstrap superuser
-- that ran init) and nobody else. Asserting "no CREATE grant exists at all"
-- fails on that stock default, so assert reachability per role instead.
--
-- has_schema_privilege resolves role membership and PUBLIC for us, so it sees
-- a privilege arriving by any route. The separate PUBLIC probe exists because
-- has_schema_privilege takes a role, and PUBLIC is not one.
DO $$
DECLARE
  offender  text;
  r         record;
  actual    text;
  expected  text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname IN (
    SELECT contract->>'name'
    FROM jsonb_array_elements(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS roles(contract)
  )
    AND has_schema_privilege(rolname, 'public', 'CREATE');

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: role(s) % may CREATE in schema public; the sink must hold two persistent data tables and no more',
      offender;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (SELECT (aclexplode(nspacl)).* FROM pg_namespace WHERE nspname = 'public') a
    WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION
      'log sink: PUBLIC may CREATE in schema public; every role on this cluster inherits that';
  END IF;

  -- Same question one level up: CREATE on the DATABASE would let a role mint
  -- a fresh schema and put relations outside the public-schema checks above.
  -- The stock database default gives PUBLIC CONNECT and TEMPORARY but never
  -- CREATE, so both probes pass an untouched init.
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname IN (
    SELECT contract->>'name'
    FROM jsonb_array_elements(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS roles(contract)
  )
    AND has_database_privilege(rolname, current_database(), 'CREATE');

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: role(s) % may CREATE schemas in this database', offender;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (SELECT (aclexplode(coalesce(datacl, acldefault('d', datdba)))).*
          FROM pg_database WHERE datname = current_database()) a
    WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION
      'log sink: PUBLIC may CREATE schemas in this database';
  END IF;

  -- TEMPORARY is the one managed database capability. Compare only explicit
  -- role grants here (including grant option) because PostgreSQL's stock
  -- PUBLIC TEMPORARY default remains deliberately unpinned. The rollup's
  -- direct grant is still load-bearing: it must survive a hardened deployment
  -- revoking that PUBLIC default.
  FOR r IN
    SELECT role.oid AS role_oid,
           role.rolname,
           contract.database_privileges AS want
    FROM jsonb_to_recordset(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS contract(name text, database_privileges text)
    JOIN pg_roles role ON role.rolname = contract.name
    ORDER BY role.rolname
  LOOP
    WITH database_acl AS (
      SELECT (aclexplode(coalesce(datacl, '{}'::aclitem[]))).*
      FROM pg_database
      WHERE datname = current_database()
    ), mine AS (
      SELECT DISTINCT
        privilege_type || CASE WHEN is_grantable THEN '*' ELSE '' END AS privilege
      FROM database_acl
      WHERE privilege_type = 'TEMPORARY'
        AND grantee = r.role_oid
    )
    SELECT string_agg(privilege, ',' ORDER BY privilege) INTO actual
    FROM mine;

    expected := nullif(r.want, '');
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION
        'log sink: role % database TEMPORARY privilege drifted; expected (%), found (%)',
        r.rolname, coalesce(expected, '<none>'), coalesce(actual, '<none>');
    END IF;

  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ---------- 5. The role set itself is closed ------------------------------
-- Sections 1 and 3 reason about roles they can NAME: 1 scans 'openbrain%',
-- 3 compares the three enumerated. A role outside both patterns — created by
-- the administrative superuser, or by drift nobody noticed — would pass every
-- check above while falsifying the header's closed role set. Three closures
-- fix that: exactly one superuser (the bootstrap role init connects as), both
-- required sink roles present and login-capable, and no role at all beyond the
-- superuser, the enumerated sink roles, and PostgreSQL's
-- predefined pg_* roles (the pg_ prefix is reserved by the server — even a
-- superuser cannot CREATE ROLE under it, so the exclusion is not a loophole).
--
-- The monitor role is OPTIONAL (00-log-sink-roles.sh creates it only when
-- OPENBRAIN_MONITOR_PASSWORD is set): this check permits its absence and
-- forbids additions, matching that contract.
DO $$
DECLARE
  supers   int;
  offender text;
  missing  text;
BEGIN
  SELECT count(*) INTO supers FROM pg_roles WHERE rolsuper;
  IF supers <> 1 THEN
    RAISE EXCEPTION
      'log sink: expected exactly one superuser (the bootstrap role), found %',
      supers;
  END IF;

  SELECT string_agg(required_role, ', ' ORDER BY required_role) INTO missing
  FROM (
    SELECT contract.name AS required_role
    FROM jsonb_to_recordset(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS contract(name text, required boolean)
    WHERE contract.required
  ) AS wanted
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = wanted.required_role
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: required role(s) % are missing', missing;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname IN (
    SELECT contract->>'name'
    FROM jsonb_array_elements(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS roles(contract)
  )
    AND NOT rolcanlogin;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: sink role(s) % cannot LOGIN', offender;
  END IF;

  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname NOT LIKE 'pg\_%'
    AND NOT rolsuper
    AND rolname NOT IN (
      SELECT contract->>'name'
      FROM jsonb_array_elements(
        current_setting('openbrain.log_sink_role_contract')::jsonb
      ) AS roles(contract)
    );

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: unexpected role(s) %; this cluster holds the bootstrap superuser and the enumerated sink roles only',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 6. Effective privileges, not just direct grants ---------------
-- Section 3 compares what is WRITTEN in the ACLs; this section compares what
-- each role can actually DO. has_table_privilege resolves every route the
-- server knows — direct grants, role membership (a `GRANT pg_read_all_data TO
-- openbrain_ingester` shows up here while leaving relacl untouched), and
-- PUBLIC — so a privilege arriving by any path breaks the comparison.
--
-- Unlike section 3 this names today's privilege types; that is acceptable for
-- a second net (section 3 stays name-free and catches new types), and the
-- expected sets are deliberately the same enumeration as section 3: with no
-- memberships (section 7) and no PUBLIC grants (section 3), effective must
-- equal direct.
DO $$
DECLARE
  r        record;
  actual   text;
BEGIN
  FOR r IN
    SELECT role.rolname, contract.direct_privileges AS want
    FROM jsonb_to_recordset(
      current_setting('openbrain.log_sink_role_contract')::jsonb
    ) AS contract(name text, direct_privileges text)
    JOIN pg_roles role ON role.rolname = contract.name
    ORDER BY role.rolname
  LOOP
    WITH effective AS (
      SELECT t.relname, p.priv
      FROM (VALUES ('funnel_access_log'), ('funnel_access_summary')) t(relname)
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                              'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(priv)
      WHERE has_table_privilege(r.rolname, 'public.' || t.relname, p.priv)
      UNION ALL
      SELECT 'funnel_access_log_id_seq', p.priv
      FROM unnest(ARRAY['USAGE','SELECT','UPDATE']) p(priv)
      WHERE has_sequence_privilege(r.rolname, 'public.funnel_access_log_id_seq', p.priv)
    )
    SELECT string_agg(relname || '=' || privs, '|' ORDER BY relname) INTO actual
    FROM (
      SELECT relname, string_agg(priv, ',' ORDER BY priv) AS privs
      FROM effective GROUP BY relname
    ) g;

    IF actual IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION
        'log sink: role % EFFECTIVE privileges drifted (membership or PUBLIC route?); expected (%), found (%)',
        r.rolname, coalesce(r.want, '<none>'), coalesce(actual, '<none>');
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ---------- 7. No role memberships at all ---------------------------------
-- Membership is how a "least-privilege" role quietly inherits someone else's
-- reach (and how section 3's per-role ACL comparison gets bypassed). The
-- predefined pg_* roles ship with memberships among THEMSELVES (pg_monitor
-- contains pg_read_all_stats, etc.) — those are the server's own and
-- permitted; any membership row touching a non-pg_* role on either side is
-- not.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(m.roleid::regrole::text || ' -> ' || m.member::regrole::text,
                    ', ') INTO offender
  FROM pg_auth_members m
  WHERE m.roleid::regrole::text NOT LIKE 'pg\_%'
     OR m.member::regrole::text NOT LIKE 'pg\_%';

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: unexpected role membership(s) [%]; sink roles must not inherit or confer anything',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 8. Nothing else holds or forwards access -----------------------
-- Three small closures behind sections 3 and 5:
--   ownership   — only the bootstrap superuser may own relations (an owner
--                 bypasses grants entirely);
--   default ACLs — ALTER DEFAULT PRIVILEGES would grant on FUTURE objects,
--                 invisible to every present-tense check above;
--   foreign grantees — a grant parked on a grantee outside the enumerated
--                 set (with section 5, that can only be a predefined pg_*
--                 role) is unreachable by section 3's per-role comparison.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(DISTINCT c.relname, ', ') INTO offender
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles o ON o.oid = c.relowner
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND NOT o.rolsuper;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: relation(s) % owned by a non-superuser; only the bootstrap role may own objects',
      offender;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION
      'log sink: pg_default_acl is not empty; a default privilege would grant on future objects';
  END IF;

  SELECT string_agg(DISTINCT a.grantee::regrole::text, ', ') INTO offender
  FROM (
    SELECT (aclexplode(c.relacl)).grantee
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND c.relacl IS NOT NULL
    UNION ALL
    SELECT (aclexplode(a.attacl)).grantee
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND a.attacl IS NOT NULL
  ) a
  WHERE a.grantee <> 0                                   -- PUBLIC: section 3 folds it
    AND a.grantee NOT IN (
      SELECT oid FROM pg_roles
      WHERE rolsuper                                     -- the owner's own entry
         OR rolname IN (
           SELECT contract->>'name'
           FROM jsonb_array_elements(
             current_setting('openbrain.log_sink_role_contract')::jsonb
           ) AS roles(contract)
         ));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: grant(s) held by unexpected grantee(s) %; only the enumerated roles may appear in an ACL',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 9. The non-system schema and routine sets are closed -----------
-- Section 2's census walks RELATIONS in non-system schemas; these close what
-- it cannot see. A stray SCHEMA — above all one AUTHORIZED to a sink role —
-- is a workshop where that role may CREATE at will, outside section 4's
-- public/database CREATE probes, so no schema beyond `public` may exist and
-- `public` must keep its stock PG15+ owner (pg_database_owner). A stray
-- ROUTINE is worse: PostgreSQL grants EXECUTE to PUBLIC on new functions by
-- default, and a SECURITY DEFINER body runs with its OWNER's authority — a
-- superuser-owned helper selecting funnel_access_log hands every role that
-- can call it a read path despite holding no table grant. This sink defines
-- ZERO non-system routines, so the closure is total for objects a migration or
-- least-privilege role can legitimately introduce. (DO blocks are anonymous —
-- running this file stores nothing in pg_proc.) System-catalog/OID fingerprint
-- probes are deliberately absent: they would be detection-only heuristics run
-- by the same superuser they purport to constrain, not an authorization
-- boundary.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO offender
  FROM pg_namespace
  WHERE nspname NOT LIKE 'pg\_%'
    AND nspname NOT IN ('information_schema', 'public');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: unexpected schema(s) %; this cluster holds schema public and nothing else',
      offender;
  END IF;

  SELECT r.rolname INTO offender
  FROM pg_namespace n
  JOIN pg_roles r ON r.oid = n.nspowner
  WHERE n.nspname = 'public' AND r.rolname <> 'pg_database_owner';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: schema public is owned by % instead of pg_database_owner',
      offender;
  END IF;

  -- A routine in an application schema is an unreviewed path around the exact
  -- relation ACLs, especially when the default PUBLIC EXECUTE grant and
  -- SECURITY DEFINER are combined.
  SELECT string_agg(n.nspname || '.' || p.proname, ', '
                    ORDER BY n.nspname, p.proname) INTO offender
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname !~ '^pg_';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: unexpected non-system routine(s) %; this sink defines no application functions or procedures',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

\echo 'log sink: authorization/topology invariants OK (2 persistent data tables, 1 application schema, 0 non-system routines, closed role set, exactly-enumerated direct and effective grants)'
