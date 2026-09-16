#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" grants
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

smoke_step "Smoke test — protected roles reject grant drift"
run_assertion() {
  apply_sql db/03-grants-assertion.sql
}
expect_rejected() {
  local label=$1
  local expected=$2
  local diagnostic=${3:-}
  local output
  if output=$(run_assertion 2>&1); then
    echo "::error::$label did not fail the protected-role grants assertion"
    return 1
  fi
  if ! grep -Fq "$expected" <<< "$output"; then
    echo "::error::$label failed without identifying $expected"
    echo "$output"
    return 1
  fi
  if [[ -n "$diagnostic" ]] && ! grep -Fq "$diagnostic" <<< "$output"; then
    echo "::error::$label failed without diagnostic marker $diagnostic"
    echo "$output"
    return 1
  fi
}

# The completed clean schema is valid, including relations created
# after 02-observability.sql.
run_assertion >/dev/null

# Table SELECT alone is insufficient for a backup: schema USAGE is also
# required. Prove the actual dump fails on drift and recovers after migration.
dump_oauth_as_backup() {
  docker exec -e PGPASSWORD="$OPENBRAIN_READONLY_PASSWORD" "$DB_INIT_CONTAINER" \
    pg_dump -w -h 127.0.0.1 -U openbrain_readonly -d "$POSTGRES_DB" \
    --schema=oauth_auth -Fc > /dev/null
}
dump_oauth_as_backup
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE USAGE ON SCHEMA oauth_auth FROM openbrain_readonly" >/dev/null
test "$(super_psql -tAc \
  "SELECT has_table_privilege('openbrain_readonly', 'oauth_auth.allowed_subject', 'SELECT')")" = t
if dump_output=$(dump_oauth_as_backup 2>&1); then
  echo "::error::OAuth backup dump unexpectedly succeeded without schema USAGE"
  exit 1
fi
grep -Fq 'permission denied for schema oauth_auth' <<< "$dump_output"
expect_rejected "OAuth backup schema USAGE drift" "backup cannot safely dump OAuth admission"
apply_sql db/13-oauth-subjects.sql >/dev/null
run_assertion >/dev/null
dump_oauth_as_backup

# Backups cannot create objects or own the schema. Ownership retains DROP
# authority even after its owner revokes its own CREATE privilege.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT CREATE ON SCHEMA oauth_auth TO openbrain_readonly" >/dev/null
expect_rejected "OAuth backup schema CREATE drift" "backup cannot safely dump OAuth admission"
apply_sql db/13-oauth-subjects.sql >/dev/null
run_assertion >/dev/null
for role in openbrain_app openbrain_token_admin openbrain_readonly; do
  super_psql -v ON_ERROR_STOP=1 -c \
    "ALTER SCHEMA oauth_auth OWNER TO $role;
     REVOKE CREATE ON SCHEMA oauth_auth FROM $role" >/dev/null
  test "$(super_psql -tAc \
    "SELECT has_schema_privilege('$role', 'oauth_auth', 'CREATE')")" = f
  expect_rejected "OAuth schema ownership by $role without CREATE" \
    "runtime/admin/backup must not own OAuth admission"
  # Demonstrate the owner-only destructive authority in a rolled-back fixture.
  super_psql -v ON_ERROR_STOP=1 -c \
    "BEGIN; SET LOCAL ROLE $role; DROP SCHEMA oauth_auth CASCADE; ROLLBACK" >/dev/null
  super_psql -v ON_ERROR_STOP=1 -c \
    "ALTER SCHEMA oauth_auth OWNER TO postgres" >/dev/null
  apply_sql db/13-oauth-subjects.sql >/dev/null
  run_assertion >/dev/null
done
dump_oauth_as_backup

# Backups must neither resurrect a revoked subject nor wipe admission state.
# Table-level checks alone miss column-only UPDATE/INSERT/REFERENCES grants.
for privilege in INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER \
    'UPDATE(revoked_at)' 'INSERT(subject)' 'REFERENCES(subject)'; do
  super_psql -v ON_ERROR_STOP=1 -c \
    "GRANT $privilege ON oauth_auth.allowed_subject TO openbrain_readonly" >/dev/null
  expect_rejected "OAuth backup $privilege drift" "backup cannot safely dump OAuth admission"
  apply_sql db/13-oauth-subjects.sql >/dev/null
  run_assertion >/dev/null
done

# OAuth admission: reject widened reads, direct mutation, delegable grants and
# PUBLIC definer access, then prove the migration reconciles direct ACL drift.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE(kind) ON oauth_auth.allowed_subject TO openbrain_app" >/dev/null
expect_rejected "OAuth runtime mutation" "OAuth runtime/admin must be read-only"
apply_sql db/13-oauth-subjects.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT(created_at) ON oauth_auth.allowed_subject TO openbrain_app" >/dev/null
expect_rejected "OAuth runtime inventory widening" "unexpected OAuth admission SELECT"
apply_sql db/13-oauth-subjects.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT(label) ON oauth_auth.allowed_subject TO openbrain_app" >/dev/null
expect_rejected "OAuth runtime label widening" "unexpected OAuth admission SELECT"
apply_sql db/13-oauth-subjects.sql >/dev/null
test "$(super_psql -tAc \
  "SELECT has_column_privilege('openbrain_app', 'oauth_auth.allowed_subject', 'label', 'SELECT')")" = f
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT EXECUTE ON FUNCTION oauth_auth.allow_subject(text,text,text) TO PUBLIC" >/dev/null
expect_rejected "OAuth PUBLIC enrollment" "grants assertion failed"
apply_sql db/13-oauth-subjects.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT(subject) ON oauth_auth.allowed_subject TO openbrain_token_admin WITH GRANT OPTION" >/dev/null
expect_rejected "OAuth delegable admission" "OAuth admission privileges are delegable"
apply_sql db/13-oauth-subjects.sql >/dev/null
run_assertion >/dev/null

# Auth-event writes and retention use separate credentials. Match the ticket's
# SET ROLE acceptance probe directly, then prove the rollup can delete a row
# without gaining INSERT/UPDATE or sideways corpus access.
expect_set_role_denied() {
  local label=$1
  local sql=$2
  local output
  if output=$(super_psql -v ON_ERROR_STOP=1 -c \
    "BEGIN; SET LOCAL ROLE openbrain_app; $sql; ROLLBACK" 2>&1); then
    echo "::error::$label unexpectedly succeeded as openbrain_app"
    return 1
  fi
  grep -Fq "permission denied for table mcp_auth_events" <<< "$output" || {
    echo "::error::$label failed without the expected table-permission denial"
    echo "$output"
    return 1
  }
}

expect_set_role_denied "auth audit UPDATE" \
  "UPDATE public.mcp_auth_events SET path = '/tampered' WHERE false"
expect_set_role_denied "auth audit DELETE" \
  "DELETE FROM public.mcp_auth_events WHERE false"

audit_marker=ci-auth-rollup-retention-fixture
super_psql -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.mcp_auth_events
     (ts, outcome, reason, middleware, path)
   VALUES (
     now() - interval '31 days', 'denied', 'missing_credentials',
     'require_auth', '$audit_marker'
   )"
docker exec -i -e PGPASSWORD="$OPENBRAIN_AUTH_ROLLUP_PASSWORD" \
  "$DB_INIT_CONTAINER" psql -X -w -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U openbrain_auth_rollup -d "$POSTGRES_DB" \
  -c "DELETE FROM public.mcp_auth_events WHERE path = '$audit_marker'"
test "$(super_psql -tAc \
  "SELECT count(*) FROM public.mcp_auth_events WHERE path = '$audit_marker'")" = 0

set +e
rollup_insert_output=$(docker exec -i \
  -e PGPASSWORD="$OPENBRAIN_AUTH_ROLLUP_PASSWORD" "$DB_INIT_CONTAINER" \
  psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 \
  -U openbrain_auth_rollup -d "$POSTGRES_DB" -c \
  "INSERT INTO public.mcp_auth_events
     (outcome, reason, middleware)
   VALUES ('denied', 'missing_credentials', 'require_auth')" 2>&1)
rollup_insert_rc=$?
set -e
test "$rollup_insert_rc" -ne 0
grep -Fq "permission denied for table mcp_auth_events" \
  <<< "$rollup_insert_output"

# The completed-catalog assertion detects privilege drift, and migration 12
# converges both historical table DML and a hand-added column UPDATE.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE, DELETE ON public.mcp_auth_events TO openbrain_app"
expect_rejected "app auth-audit mutation" \
  "openbrain_app auth audit access must be SELECT/INSERT-only" \
  "db/12-auth-audit-grants.sql"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE (subject) ON public.mcp_auth_events TO openbrain_app"
expect_rejected "app auth-audit column mutation" \
  "openbrain_app auth audit access must be SELECT/INSERT-only"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT INSERT ON public.mcp_auth_events TO openbrain_auth_rollup"
expect_rejected "auth rollup INSERT" \
  "openbrain_auth_rollup must have SELECT/DELETE only"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

# PostgreSQL's table-level REVOKE ALL also removes direct column ACLs for the
# named role. Pin that behavior against the exact INSERT/REFERENCES drift raised
# in review for both supported convergence paths.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT INSERT (subject), REFERENCES (subject)
   ON public.mcp_auth_events TO openbrain_auth_rollup"
expect_rejected "auth rollup column INSERT/REFERENCES" \
  "openbrain_auth_rollup must have SELECT/DELETE only"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT INSERT (subject), REFERENCES (subject)
   ON public.mcp_auth_events TO openbrain_auth_rollup"
expect_rejected "auth rollup column drift before observability replay" \
  "openbrain_auth_rollup must have SELECT/DELETE only"
apply_sql db/02-observability.sql >/dev/null
run_assertion >/dev/null

# Allowed effective privileges must still be non-delegable. Exercise relation,
# column, and sequence ACLs, including the concrete DELETE delegation route;
# migration 12 must remove both grant options and dependent grants.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT DELETE ON public.mcp_auth_events
     TO openbrain_auth_rollup WITH GRANT OPTION"
expect_rejected "auth rollup DELETE grant option" \
  "auth-audit privileges must not carry WITH GRANT OPTION" \
  "openbrain_auth_rollup"
super_psql -v ON_ERROR_STOP=1 -c \
  "SET ROLE openbrain_auth_rollup;
   GRANT DELETE ON public.mcp_auth_events TO openbrain_readonly;
   RESET ROLE"
apply_sql db/12-auth-audit-grants.sql >/dev/null
super_psql -tAc \
  "SELECT NOT has_table_privilege(
     'openbrain_readonly', 'public.mcp_auth_events', 'DELETE'
   )" | grep -q t
run_assertion >/dev/null

# The readonly role is part of the same audit boundary: both supported grant
# files must remove direct mutation/sequence drift, not merely rely on a
# rollup-grant cascade to happen to clean it up.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT DELETE ON public.mcp_auth_events TO openbrain_readonly;
   GRANT USAGE ON SEQUENCE public.mcp_auth_events_id_seq
     TO openbrain_readonly"
expect_rejected "readonly auth-audit mutation" \
  "openbrain_readonly cannot safely dump auth audit history"
apply_sql db/12-auth-audit-grants.sql >/dev/null
super_psql -tAc \
  "SELECT has_table_privilege(
            'openbrain_readonly', 'public.mcp_auth_events', 'SELECT'
          )
      AND NOT has_table_privilege(
            'openbrain_readonly', 'public.mcp_auth_events',
            'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
          )
      AND has_sequence_privilege(
            'openbrain_readonly', 'public.mcp_auth_events_id_seq', 'SELECT'
          )
      AND NOT has_sequence_privilege(
            'openbrain_readonly', 'public.mcp_auth_events_id_seq',
            'USAGE, UPDATE'
          )" | grep -q t
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT DELETE ON public.mcp_auth_events TO openbrain_readonly;
   GRANT USAGE ON SEQUENCE public.mcp_auth_events_id_seq
     TO openbrain_readonly"
apply_sql db/02-observability.sql >/dev/null
super_psql -tAc \
  "SELECT NOT has_table_privilege(
            'openbrain_readonly', 'public.mcp_auth_events', 'DELETE'
          )
      AND NOT has_sequence_privilege(
            'openbrain_readonly', 'public.mcp_auth_events_id_seq', 'USAGE'
          )" | grep -q t
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT (subject) ON public.mcp_auth_events
     TO openbrain_app WITH GRANT OPTION"
expect_rejected "application audit column grant option" \
  "auth-audit privileges must not carry WITH GRANT OPTION" \
  "public.mcp_auth_events.subject"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT USAGE ON SEQUENCE public.mcp_auth_events_id_seq
     TO openbrain_app WITH GRANT OPTION"
expect_rejected "application audit sequence grant option" \
  "auth-audit privileges must not carry WITH GRANT OPTION" \
  "mcp_auth_events_id_seq"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

# Effective CREATE on either an application schema or the current database can
# persist objects beyond the rollup's one-table ACL. Both gates reject these
# routes, and the advertised migration converges direct grant drift.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT CREATE ON SCHEMA public TO openbrain_auth_rollup"
expect_rejected "auth rollup schema CREATE" \
  "openbrain_auth_rollup can create persistent corpus objects" \
  "schema public"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT CREATE ON DATABASE $POSTGRES_DB TO openbrain_auth_rollup"
expect_rejected "auth rollup database CREATE" \
  "openbrain_auth_rollup can create persistent corpus objects" \
  "database $POSTGRES_DB"
apply_sql db/12-auth-audit-grants.sql >/dev/null
run_assertion >/dev/null

# A hardened cluster may revoke the default PUBLIC schema USAGE. The rollup
# must retain a direct, non-delegable prerequisite grant, and both the focused
# migration and the idempotent observability schema must restore it.
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE USAGE ON SCHEMA public FROM PUBLIC;
   REVOKE USAGE ON SCHEMA public FROM openbrain_auth_rollup CASCADE"
expect_rejected "missing direct auth-rollup schema USAGE" \
  "openbrain_auth_rollup must have direct, non-delegable USAGE on schema public" \
  "db/12-auth-audit-grants.sql"
apply_sql db/12-auth-audit-grants.sql >/dev/null
super_psql -tAc \
  "SELECT has_schema_privilege(
            'openbrain_auth_rollup', 'public', 'USAGE'
          )
      AND EXISTS (
            SELECT 1
            FROM pg_namespace AS namespace
            CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
            WHERE namespace.nspname = 'public'
              AND acl.grantee = 'openbrain_auth_rollup'::regrole::oid
              AND acl.privilege_type = 'USAGE'
              AND NOT acl.is_grantable
          )" | grep -q t
docker exec -i -e PGPASSWORD="$OPENBRAIN_AUTH_ROLLUP_PASSWORD" \
  "$DB_INIT_CONTAINER" psql -X -w -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U openbrain_auth_rollup -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM public.mcp_auth_events" >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE USAGE ON SCHEMA public FROM openbrain_auth_rollup CASCADE"
expect_rejected "missing auth-rollup schema USAGE before observability replay" \
  "openbrain_auth_rollup must have direct, non-delegable USAGE on schema public"
apply_sql db/02-observability.sql >/dev/null
run_assertion >/dev/null
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT USAGE ON SCHEMA public TO PUBLIC"

# PostgreSQL 16 can make a membership non-inheriting but SET-capable. Effective
# privilege helpers then report no DELETE while the readonly login can SET ROLE
# into the carrier and mutate audit history. Neither grant migration should
# guess at cluster-wide membership removal; the assertion diagnoses it until an
# operator explicitly revokes the membership.
readonly_set_role_marker=ci-readonly-set-role-delete
super_psql -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE ci_auth_audit_readonly_carrier NOLOGIN;
   GRANT USAGE ON SCHEMA public TO ci_auth_audit_readonly_carrier;
   GRANT SELECT, DELETE ON public.mcp_auth_events
     TO ci_auth_audit_readonly_carrier;
   GRANT ci_auth_audit_readonly_carrier TO openbrain_readonly
     WITH INHERIT FALSE, SET TRUE;
   INSERT INTO public.mcp_auth_events
     (outcome, reason, middleware, path)
   VALUES (
     'denied', 'missing_credentials', 'require_auth',
     '$readonly_set_role_marker'
   )"
super_psql -tAc \
  "SELECT NOT has_table_privilege(
     'openbrain_readonly', 'public.mcp_auth_events', 'DELETE'
   )" | grep -q t
docker exec -i -e PGPASSWORD="$OPENBRAIN_READONLY_PASSWORD" \
  "$DB_INIT_CONTAINER" psql -X -w -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U openbrain_readonly -d "$POSTGRES_DB" \
  -c "BEGIN;
      SET LOCAL ROLE ci_auth_audit_readonly_carrier;
      DELETE FROM public.mcp_auth_events
        WHERE path = '$readonly_set_role_marker';
      COMMIT"
test "$(super_psql -tAc \
  "SELECT count(*) FROM public.mcp_auth_events
   WHERE path = '$readonly_set_role_marker'")" = 0
expect_rejected "readonly SET ROLE carrier" \
  "openbrain_readonly is a member of" \
  "SET ROLE can bypass effective read-only privilege checks"
apply_sql db/12-auth-audit-grants.sql >/dev/null
expect_rejected "readonly membership survives grant migration" \
  "openbrain_readonly is a member of" \
  "ci_auth_audit_readonly_carrier"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE ci_auth_audit_readonly_carrier FROM openbrain_readonly;
   DROP OWNED BY ci_auth_audit_readonly_carrier CASCADE;
   DROP ROLE ci_auth_audit_readonly_carrier"
run_assertion >/dev/null

# Schema ACL entries retain their issuing grantor. An owner-issued ordinary row
# can therefore coexist with an alternate grantor's WITH GRANT OPTION row; replay
# of migration 12 must not falsely claim to have converged the latter.
super_psql -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE ci_auth_audit_schema_grantor NOLOGIN;
   GRANT USAGE ON SCHEMA public TO ci_auth_audit_schema_grantor
     WITH GRANT OPTION;
   SET ROLE ci_auth_audit_schema_grantor;
   GRANT USAGE ON SCHEMA public TO openbrain_auth_rollup
     WITH GRANT OPTION;
   RESET ROLE"
expect_rejected "alternate-grantor rollup schema grant option" \
  "openbrain_auth_rollup has grantable USAGE on schema public" \
  "ci_auth_audit_schema_grantor"
apply_sql db/12-auth-audit-grants.sql >/dev/null
expect_rejected "alternate-grantor schema grant survives grant migration" \
  "openbrain_auth_rollup has grantable USAGE on schema public" \
  "REVOKE GRANT OPTION FOR USAGE"
super_psql -v ON_ERROR_STOP=1 -c \
  "SET ROLE ci_auth_audit_schema_grantor;
   REVOKE ALL PRIVILEGES ON SCHEMA public
     FROM openbrain_auth_rollup CASCADE;
   RESET ROLE;
   DROP OWNED BY ci_auth_audit_schema_grantor CASCADE;
   DROP ROLE ci_auth_audit_schema_grantor"
run_assertion >/dev/null

# Default ACLs are future grants and survive the direct-object convergence in
# migration 12. The assertion names the owning role and exact ALTER DEFAULT
# PRIVILEGES repair instead of silently mutating another role's standing policy.
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER DEFAULT PRIVILEGES
     GRANT SELECT ON TABLES TO openbrain_auth_rollup"
expect_rejected "rollup future-relation default ACL" \
  "default privileges would grant future relations or sequences to openbrain_auth_rollup" \
  "ALTER DEFAULT PRIVILEGES FOR ROLE postgres"
apply_sql db/12-auth-audit-grants.sql >/dev/null
expect_rejected "rollup default ACL survives grant migration" \
  "default privileges would grant future relations or sequences to openbrain_auth_rollup" \
  "REVOKE SELECT ON TABLES FROM openbrain_auth_rollup"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER DEFAULT PRIVILEGES
     REVOKE SELECT ON TABLES FROM openbrain_auth_rollup"
run_assertion >/dev/null

smoke_step "Smoke test — boot probe rejects auth-audit grant drift"
run_deno_db_smoke server/auth_audit_grants_db_smoke.ts

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT ON public.thoughts TO openbrain_auth_rollup"
expect_rejected "auth rollup sideways corpus access" \
  "openbrain_auth_rollup can access non-audit relations" "public.thoughts"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE SELECT ON public.thoughts FROM openbrain_auth_rollup"
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_auth_rollup CREATEDB CREATEROLE REPLICATION BYPASSRLS"
expect_rejected "auth rollup privilege flags" \
  "openbrain_auth_rollup has unsafe role attributes" \
  "CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_auth_rollup NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
run_assertion >/dev/null

# Session UPDATE is intentionally narrower than the other session DML: parent
# refresh/status columns only, and no artifact UPDATE at all. Prove the
# completed-catalog assertion rejects both historical table-wide grants and a
# hand-added audience/link column grant; migration 11 must converge each drift.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE ON sessions.session TO openbrain_app"
expect_rejected "session table-wide UPDATE" \
  "table-wide UPDATE on sessions.session" "db/11-session-update-grants.sql"
apply_sql db/11-session-update-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE (workspace_id) ON sessions.session TO openbrain_app"
expect_rejected "session audience-column UPDATE" \
  "sessions.session audience/identity column workspace_id"
apply_sql db/11-session-update-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE ON sessions.artifact TO openbrain_app"
expect_rejected "artifact table-wide UPDATE" \
  "openbrain_app can UPDATE sessions.artifact" \
  "session_pk cannot be rewritten"
apply_sql db/11-session-update-grants.sql >/dev/null
run_assertion >/dev/null

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE (session_pk) ON sessions.artifact TO openbrain_app"
expect_rejected "artifact parent-link UPDATE" \
  "openbrain_app can UPDATE sessions.artifact" \
  "session_pk cannot be rewritten"
apply_sql db/11-session-update-grants.sql >/dev/null
run_assertion >/dev/null

# A future session column must be deliberately classified before deployment;
# otherwise the catalog gate should fail instead of leaving the first new write
# to discover a missing or over-broad grant at runtime.
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER TABLE sessions.session ADD COLUMN ci_unclassified text"
expect_rejected "unclassified session column" \
  "sessions.session has unclassified column(s)" "ci_unclassified"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER TABLE sessions.session DROP COLUMN ci_unclassified"
run_assertion >/dev/null

# HBA introspection is superuser-restricted. A lower-privilege caller
# gets the documented diagnostic before any partial catalog check.
set +e
readonly_output=$(docker exec -i \
  -e PGPASSWORD="$OPENBRAIN_READONLY_PASSWORD" "$DB_INIT_CONTAINER" \
  psql -h 127.0.0.1 -U openbrain_readonly -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -f - < db/03-grants-assertion.sql 2>&1)
readonly_rc=$?
set -e
test "$readonly_rc" -ne 0
grep -Fq 'grants assertion requires a database superuser' \
  <<< "$readonly_output"

# An existing deployment may contain a pre-created or drifted role.
# The migration must preserve LOGIN while removing every unsafe
# cluster-level privilege flag, and the assertion must reject drift
# before that reconciliation happens.
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_token_admin CREATEDB CREATEROLE REPLICATION"
expect_rejected "token-admin privilege flags" \
  "openbrain_token_admin has unsafe cluster-level role attributes" \
  "CREATEDB, CREATEROLE, REPLICATION"
apply_sql db/08-access-tokens.sql >/dev/null
apply_sql db/14-native-token-principals.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT rolcanlogin AND NOT (
     rolsuper OR rolcreatedb OR rolcreaterole OR
     rolreplication OR rolbypassrls
   )
   FROM pg_roles WHERE rolname = 'openbrain_token_admin'" | grep -q t
run_assertion >/dev/null

# The two long-lived corpus roles have actor-specific attribute contracts: the
# app is a plain role, while readonly has only the BYPASSRLS needed by pg_dump.
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_app SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS"
expect_rejected "app privilege flags" \
  "openbrain_app has unsafe cluster-level role attributes" \
  "SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"

super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_readonly SUPERUSER CREATEDB CREATEROLE REPLICATION"
expect_rejected "readonly privilege flags" \
  "openbrain_readonly has unsafe cluster-level role attributes beyond required BYPASSRLS" \
  "SUPERUSER, CREATEDB, CREATEROLE, REPLICATION"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER ROLE openbrain_readonly NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS"

# Direct flags are not the only way to reach BYPASSRLS: membership
# would also confer inherited privileges and allow SET ROLE.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT openbrain_readonly TO openbrain_app"
expect_rejected "app role membership" \
  "openbrain_app is a member of" "openbrain_readonly"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE openbrain_readonly FROM openbrain_app"

# Current PUBLIC ACLs are a role-independent exposure, not a special case of
# whichever managed role happens to inherit them. The assertion names the
# object and privilege directly.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT ON public.mcp_auth_events TO PUBLIC"
expect_rejected "current PUBLIC relation privilege" \
  "PUBLIC can access current non-system relations or columns" \
  "public.mcp_auth_events=SELECT"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE SELECT ON public.mcp_auth_events FROM PUBLIC"

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT (subject) ON public.mcp_auth_events TO PUBLIC"
expect_rejected "current PUBLIC column privilege" \
  "PUBLIC can access current non-system relations or columns" \
  "public.mcp_auth_events.subject=SELECT"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE SELECT (subject) ON public.mcp_auth_events FROM PUBLIC"

# PUBLIC grants on a relation with a narrower app-role contract must still be
# diagnosed as PUBLIC exposure, not as app-role drift that migration 11 cannot
# repair. Prove both table- and audience-column-level overlap.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE ON sessions.session TO PUBLIC"
expect_rejected "PUBLIC session table UPDATE" \
  "PUBLIC can access current non-system relations or columns" \
  "sessions.session=UPDATE"
apply_sql db/11-session-update-grants.sql >/dev/null
expect_rejected "PUBLIC session table UPDATE survives migration 11" \
  "PUBLIC can access current non-system relations or columns" \
  "sessions.session=UPDATE"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE UPDATE ON sessions.session FROM PUBLIC"

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT UPDATE (owner_subject) ON sessions.session TO PUBLIC"
expect_rejected "PUBLIC session audience-column UPDATE" \
  "PUBLIC can access current non-system relations or columns" \
  "sessions.session.owner_subject=UPDATE"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE UPDATE (owner_subject) ON sessions.session FROM PUBLIC"

super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT USAGE ON SEQUENCE public.thought_revisions_id_seq TO PUBLIC"
expect_rejected "current PUBLIC sequence privilege" \
  "PUBLIC can access current non-system relations or columns" \
  "public.thought_revisions_id_seq=USAGE"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE USAGE ON SEQUENCE public.thought_revisions_id_seq FROM PUBLIC"

# An application-owned SECURITY DEFINER routine must not keep PostgreSQL's
# default PUBLIC EXECUTE grant. Revoking that route restores the valid catalog.
super_psql -v ON_ERROR_STOP=1 -c \
  "CREATE FUNCTION public.ci_public_definer() RETURNS integer
     LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
     AS 'SELECT 1';
   ALTER FUNCTION public.ci_public_definer() OWNER TO openbrain_app"
expect_rejected "PUBLIC SECURITY DEFINER execution" \
  "PUBLIC can execute non-system SECURITY DEFINER routines" \
  "public.ci_public_definer()"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE ALL ON FUNCTION public.ci_public_definer() FROM PUBLIC"
run_assertion >/dev/null
super_psql -v ON_ERROR_STOP=1 -c \
  "DROP FUNCTION public.ci_public_definer()"

# PUBLIC default ACLs are delayed grants: no current table need expose
# them, but the next migration would materialize the privilege.
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC"
expect_rejected "PUBLIC default table privileges" \
  "default privileges would grant future relations or sequences to PUBLIC" \
  "SELECT on future relations"
super_psql -v ON_ERROR_STOP=1 -c \
  "ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC"

# The corpus must reject the retired role names even before a grant
# is attached. The sink job separately proves these roles are valid
# only inside the log-only cluster.
super_psql -v ON_ERROR_STOP=1 -c "CREATE ROLE openbrain_monitor LOGIN"
expect_rejected "retired monitor role" \
  "corpus contains sink-only role(s)" "openbrain_monitor"
super_psql -v ON_ERROR_STOP=1 -c "DROP ROLE openbrain_monitor"

super_psql -v ON_ERROR_STOP=1 -c "CREATE ROLE openbrain_ingester LOGIN"
expect_rejected "retired ingester role" \
  "corpus contains sink-only role(s)" "openbrain_ingester"
super_psql -v ON_ERROR_STOP=1 -c "DROP ROLE openbrain_ingester"

super_psql -v ON_ERROR_STOP=1 -c "CREATE ROLE openbrain_logs_rollup LOGIN"
expect_rejected "sink-only rollup role" \
  "corpus contains sink-only role(s)" "openbrain_logs_rollup"
super_psql -v ON_ERROR_STOP=1 -c "DROP ROLE openbrain_logs_rollup"

super_psql -v ON_ERROR_STOP=1 -c "CREATE ROLE openbrain_logs_backup LOGIN"
expect_rejected "sink-only backup role" \
  "corpus contains sink-only role(s)" "openbrain_logs_backup"
super_psql -v ON_ERROR_STOP=1 -c "DROP ROLE openbrain_logs_backup"

# A relation name is rejected independently of its shape, including
# the BIGSERIAL sequence and indexes created by the historical DDL.
super_psql -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE funnel_access_log (id BIGSERIAL PRIMARY KEY);
   CREATE TABLE funnel_access_summary (day date PRIMARY KEY)"
expect_rejected "retired Funnel relations" \
  "corpus contains retired Funnel relation(s)" "funnel_access_log"
super_psql -v ON_ERROR_STOP=1 -c \
  "DROP TABLE funnel_access_summary; DROP TABLE funnel_access_log"

# A named HBA rule is drift even when its role does not exist. Use the
# new rollup name to prove the complete sink-only census.
hba_file=$(super_psql -tAc "SHOW hba_file")
docker exec "$DB_INIT_CONTAINER" sh -c \
  'printf "%s\\n" "host all openbrain_logs_rollup 127.0.0.1/32 scram-sha-256" >> "$1"' \
  hba-append "$hba_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t
expect_rejected "retired-role HBA rule" \
  "corpus pg_hba.conf names a retired sink-only role" "openbrain_logs_rollup"
docker exec "$DB_INIT_CONTAINER" sed -i '$d' "$hba_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t

# Regex and @file tokens are interpreted by HBA at authentication
# time but remain opaque to this catalog check. Reject rather than
# pretending they exclude the retired identities.
docker exec "$DB_INIT_CONTAINER" sh -c \
  'printf "%s\\n" "host all \"/^openbrain_.*\" 127.0.0.1/32 scram-sha-256" >> "$1"' \
  hba-append "$hba_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t
expect_rejected "regex HBA user token" \
  "unprovable regex/@file user token" "/^openbrain_"
docker exec "$DB_INIT_CONTAINER" sed -i '$d' "$hba_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t

hba_role_file="${hba_file}.ci-sink-users"
docker exec "$DB_INIT_CONTAINER" sh -c \
  'printf "%s\\n" openbrain_logs_rollup > "$1"' \
  hba-users "$hba_role_file"
docker exec "$DB_INIT_CONTAINER" sh -c \
  'printf "host all @%s 127.0.0.1/32 scram-sha-256\\n" "$2" >> "$1"' \
  hba-append "$hba_file" "$hba_role_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t
expect_rejected "@file HBA user token" \
  "corpus pg_hba.conf names a retired sink-only role"
docker exec "$DB_INIT_CONTAINER" sed -i '$d' "$hba_file"
docker exec "$DB_INIT_CONTAINER" rm -f "$hba_role_file"
super_psql -tAc "SELECT pg_reload_conf()" | grep -q t

super_psql -v ON_ERROR_STOP=1 -c "GRANT UPDATE ON memory_scope.embedding_generation TO openbrain_app"
expect_rejected "embedding generation write" "embedding generation is read-only"
apply_sql db/15-embedding-index.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -c "ALTER TABLE sessions.embedding_index DISABLE ROW LEVEL SECURITY"
expect_rejected "embedding audience bypass" "embedding index must be parent-gated"
apply_sql db/15-embedding-index.sql >/dev/null
super_psql -v ON_ERROR_STOP=1 -c "GRANT DELETE ON public.thought_embedding_index TO openbrain_app"
expect_rejected "embedding index DELETE" "embedding index must be parent-gated"
apply_sql db/15-embedding-index.sql >/dev/null
run_assertion >/dev/null
echo "protected-role assertions accepted the clean catalog and rejected auth-audit mutation/delegation/object-creation/default-ACL drift, readonly SET ROLE mutation, session UPDATE widening, role attributes/membership, current and default PUBLIC access, PUBLIC SECURITY DEFINER execution, retired topology, and HBA drift"
