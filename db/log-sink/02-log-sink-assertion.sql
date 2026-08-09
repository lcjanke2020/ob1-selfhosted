-- Invariant assertions for the ingress qube's local log sink.
--
-- Run last during init (the entrypoint sees it as 99-…), and re-run by hand
-- after any change to 01-log-sink.sql. Counterpart to
-- db/03-grants-assertion.sql on the corpus, but the claim here is stronger
-- and simpler to state: this cluster contains TWO relations and THREE roles,
-- and every one of those roles holds an exactly-enumerated privilege set.
--
-- Why assert at all on a cluster whose contents are disposable: the sink sits
-- on the internet-facing qube. Its value is not the data — it is the promise
-- that popping the edge yields *only* request metadata. An accidental
-- `GRANT ALL ... TO PUBLIC`, a stray table, or a role that quietly became
-- superuser would each break that promise silently. These checks make it
-- break loudly, at init, instead.
--
-- Every check is a NEGATIVE one: it enumerates what is permitted and rejects
-- the rest, so a relation or privilege added later is caught without this
-- file having to learn about it first.

-- ---------- 1. No role on this cluster is privileged ----------------------
-- Excludes the bootstrap superuser (the container's POSTGRES_USER), which is
-- necessarily super and only ever used by init.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname LIKE 'openbrain%'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication);

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: role(s) % hold cluster-level privileges; the sink''s roles must be plain LOGIN roles',
      offender;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------- 2. Exactly two relations, with exactly these columns ----------
-- The relation check keeps the corpus schema from ever being applied here by
-- mistake (a `thoughts` table on the edge would be the failure this whole
-- topology exists to prevent). The column check is the drift guard against
-- db/02-observability.sql: db/summarize_funnel.sql runs against both
-- clusters, so the two definitions have to stay identical.
DO $$
DECLARE
  actual   text;
  expected text;
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

  SELECT string_agg(attname, ',' ORDER BY attnum) INTO actual
  FROM pg_attribute
  WHERE attrelid = 'public.funnel_access_log'::regclass AND attnum > 0 AND NOT attisdropped;
  expected := 'id,ts,socket,client_ip,method,path,status,duration_ms,bytes_out,'
           || 'user_agent,host_header,proto,tls_sni,caddy_logger,inserted_at';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'log sink: funnel_access_log columns drifted from db/02-observability.sql; expected (%), found (%)',
      expected, actual;
  END IF;

  SELECT string_agg(attname, ',' ORDER BY attnum) INTO actual
  FROM pg_attribute
  WHERE attrelid = 'public.funnel_access_summary'::regclass AND attnum > 0 AND NOT attisdropped;
  expected := 'day,socket,status_class,request_count,unique_ips,duration_ms_p50,'
           || 'duration_ms_p95,top_paths,top_user_agents,computed_at';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'log sink: funnel_access_summary columns drifted from db/02-observability.sql; expected (%), found (%)',
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
    SELECT rolname,
           CASE rolname
             WHEN 'openbrain_ingester' THEN
               'funnel_access_log=INSERT|funnel_access_log_id_seq=USAGE'
             WHEN 'openbrain_logs_rollup' THEN
               'funnel_access_log=DELETE,SELECT|funnel_access_summary=DELETE,INSERT,SELECT,UPDATE'
             WHEN 'openbrain_monitor' THEN
               'funnel_access_log=SELECT'
           END AS want
    FROM pg_roles
    WHERE rolname IN ('openbrain_ingester', 'openbrain_logs_rollup', 'openbrain_monitor')
    ORDER BY rolname
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
      SELECT DISTINCT relname, privilege_type
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

-- ---------- 4. No sink role can add objects to the public schema ----------
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
  offender text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offender
  FROM pg_roles
  WHERE rolname IN ('openbrain_ingester', 'openbrain_logs_rollup', 'openbrain_monitor')
    AND has_schema_privilege(rolname, 'public', 'CREATE');

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'log sink: role(s) % may CREATE in schema public; the sink must hold two relations and no more',
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
END;
$$ LANGUAGE plpgsql;

\echo 'log sink: invariants OK (2 relations, roles hold exactly their enumerated grants)'
