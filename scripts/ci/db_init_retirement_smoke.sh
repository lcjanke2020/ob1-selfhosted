#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" retirement
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

smoke_step "Smoke test — corpus retirement archives before restrictive drop"
run_retirement() {
  apply_sql db/09-retire-corpus-funnel.sql
}
super_sql() {
  super_psql -v ON_ERROR_STOP=1 "$@"
}

super_sql -c \
  "CREATE ROLE openbrain_ingester LOGIN;
   CREATE ROLE openbrain_monitor LOGIN;
   CREATE ROLE openbrain_logs_rollup LOGIN;
   CREATE ROLE openbrain_logs_backup LOGIN;
   CREATE TABLE funnel_access_log (id BIGSERIAL PRIMARY KEY, marker text);
   CREATE TABLE funnel_access_summary (day date PRIMARY KEY);
   GRANT INSERT ON funnel_access_log TO openbrain_ingester;
   GRANT INSERT ON funnel_access_log TO openbrain_app;
   GRANT USAGE ON SEQUENCE funnel_access_log_id_seq TO openbrain_app;
   GRANT SELECT ON mcp_auth_events TO openbrain_monitor;
   GRANT SELECT ON funnel_access_summary TO openbrain_logs_backup;
   INSERT INTO funnel_access_log (marker) VALUES ('must-archive');
   INSERT INTO funnel_access_summary (day) VALUES (current_date)" >/dev/null

# Migration 09 carries the same conservative HBA proof as the final
# assertion; pin its regex/@file arm independently before row checks.
hba_file=$(super_sql -tAc "SHOW hba_file")
docker exec "$DB_INIT_CONTAINER" sh -c \
  'printf "%s\\n" "host all \"/^openbrain_.*\" 127.0.0.1/32 scram-sha-256" >> "$1"' \
  hba-append "$hba_file"
super_sql -tAc "SELECT pg_reload_conf()" | grep -q t
set +e
retirement_output=$(run_retirement 2>&1)
retirement_rc=$?
set -e
test "$retirement_rc" -ne 0
grep -Fq 'unprovable regex/@file user token' <<< "$retirement_output"
docker exec "$DB_INIT_CONTAINER" sed -i '$d' "$hba_file"
super_sql -tAc "SELECT pg_reload_conf()" | grep -q t

set +e
retirement_output=$(run_retirement 2>&1)
retirement_rc=$?
set -e
test "$retirement_rc" -ne 0
grep -Fq 'is nonempty' <<< "$retirement_output"
grep -Fq 'funnel_access_log' <<< "$retirement_output"
# The failed transaction must leave every legacy object intact.
test "$(super_sql -tAc \
  "SELECT to_regclass('public.funnel_access_log') IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='openbrain_monitor')")" = t

# CI's throwaway fixture stands in for the operator's verified
# encrypted archive. Emptying only the raw table must not bypass the
# independently nonempty frozen-summary guard (the live-fleet shape
# Arc B is designed to retire).
super_sql -c "TRUNCATE funnel_access_log" >/dev/null
set +e
retirement_output=$(run_retirement 2>&1)
retirement_rc=$?
set -e
test "$retirement_rc" -ne 0
grep -Fq 'funnel_access_summary' <<< "$retirement_output"

# Only explicit emptying of both archived tables can open the row
# guard. An archive-like third relation must still stop retirement
# before either canonical table is dropped.
super_sql -c "TRUNCATE funnel_access_summary" >/dev/null
super_sql -c \
  "CREATE TABLE funnel_access_log_archive (marker text);
   INSERT INTO funnel_access_log_archive VALUES ('still-in-corpus')" >/dev/null
set +e
retirement_output=$(run_retirement 2>&1)
retirement_rc=$?
set -e
test "$retirement_rc" -ne 0
grep -Fq 'unexpected matching relation(s)' <<< "$retirement_output"
grep -Fq 'funnel_access_log_archive' <<< "$retirement_output"
test "$(super_sql -tAc \
  "SELECT to_regclass('public.funnel_access_log') IS NOT NULL
          AND to_regclass('public.funnel_access_summary') IS NOT NULL")" = t
super_sql -c "DROP TABLE funnel_access_log_archive" >/dev/null

# An application writer that began before migration is deliberately
# outside the edge-session census. Migration must wait for its row,
# acquire ACCESS EXCLUSIVE, then observe and reject the committed row.
writer_log="$RUNNER_TEMP/corpus-retirement-writer.log"
(
  docker exec -e PGPASSWORD="$OPENBRAIN_APP_PASSWORD" "$DB_INIT_CONTAINER" \
    psql -h 127.0.0.1 -U openbrain_app -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -c \
    "BEGIN;
     INSERT INTO funnel_access_log (marker) VALUES ('concurrent-writer');
     SELECT pg_sleep(5) /* ci-retirement-writer */;
     COMMIT;"
) >"$writer_log" 2>&1 &
writer_pid=$!
writer_ready=
for _ in $(seq 1 25); do
  if [[ "$(super_sql -tAc \
    "SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
       WHERE usename = 'openbrain_app'
         AND query LIKE '%ci-retirement-writer%'
         AND state = 'active'
     )")" = t ]]; then
    writer_ready=1
    break
  fi
  sleep 0.2
done
test "$writer_ready" = 1 || {
  echo "::error::concurrent retirement writer did not reach its hold point"
  cat "$writer_log"
  exit 1
}

set +e
retirement_output=$(run_retirement 2>&1)
retirement_rc=$?
wait "$writer_pid"
writer_rc=$?
set -e
test "$writer_rc" -eq 0 || { cat "$writer_log"; exit 1; }
test "$retirement_rc" -ne 0
grep -Fq 'funnel_access_log is nonempty' <<< "$retirement_output"
test "$(super_sql -tAc \
  "SELECT count(*) FROM funnel_access_log WHERE marker='concurrent-writer'")" = 1

super_sql -c "TRUNCATE funnel_access_log" >/dev/null
run_retirement >/dev/null
test "$(super_sql -tAc \
  "SELECT to_regclass('public.funnel_access_log') IS NULL
          AND to_regclass('public.funnel_access_summary') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_roles
            WHERE rolname IN (
              'openbrain_ingester',
              'openbrain_monitor',
              'openbrain_logs_rollup',
              'openbrain_logs_backup'
            )
          )")" = t
# Already-retired reapplication is a no-op, and the final invariant
# recognizes the converged state.
run_retirement >/dev/null
apply_sql db/03-grants-assertion.sql >/dev/null
echo "each nonempty table, an archive-like relation, and an in-flight writer blocked retirement; explicit emptying enabled an idempotent restrictive drop"
