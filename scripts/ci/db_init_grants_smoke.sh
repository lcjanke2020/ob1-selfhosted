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
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT rolcanlogin AND NOT (
     rolsuper OR rolcreatedb OR rolcreaterole OR
     rolreplication OR rolbypassrls
   )
   FROM pg_roles WHERE rolname = 'openbrain_token_admin'" | grep -q t
run_assertion >/dev/null

# Direct flags are not the only way to reach BYPASSRLS: membership
# would also confer inherited privileges and allow SET ROLE.
super_psql -v ON_ERROR_STOP=1 -c \
  "GRANT openbrain_readonly TO openbrain_app"
expect_rejected "app role membership" \
  "openbrain_app is a member of" "openbrain_readonly"
super_psql -v ON_ERROR_STOP=1 -c \
  "REVOKE openbrain_readonly FROM openbrain_app"

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

run_assertion >/dev/null
echo "protected-role assertions accepted the clean catalog and rejected role, relation, HBA, default-ACL, token-admin, and app-membership drift"
