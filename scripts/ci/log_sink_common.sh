#!/usr/bin/env bash
# Shared, deliberately small helpers for the log-sink smoke families.
# Source this file through run_log_sink_smokes.sh; it is not a standalone test.
set -Eeuo pipefail

: "${CI_REPO_ROOT:?run through scripts/ci/run_log_sink_smokes.sh}"
: "${LOG_SINK_CONTAINER:?run through scripts/ci/run_log_sink_smokes.sh}"
: "${LOG_SINK_RUNNER_ACTIVE:?run through scripts/ci/run_log_sink_smokes.sh}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${OPENBRAIN_INGESTER_PASSWORD:?OPENBRAIN_INGESTER_PASSWORD is required}"
: "${OPENBRAIN_LOGS_ROLLUP_PASSWORD:?OPENBRAIN_LOGS_ROLLUP_PASSWORD is required}"

cd "$CI_REPO_ROOT"

LOG_SINK_INVARIANT="log-sink family bootstrap"

log_sink_step() {
  LOG_SINK_INVARIANT=$1
  printf '\n==> %s\n' "$LOG_SINK_INVARIANT"
}

log_sink_error() {
  local rc=$?
  printf '::error title=Log-sink invariant failed::%s (exit %s)\n' \
    "$LOG_SINK_INVARIANT" "$rc" >&2
  return "$rc"
}
trap log_sink_error ERR

sink_psql() {
  local role=$1
  local password=$2
  shift 2
  docker exec -i -e PGPASSWORD="$password" "$LOG_SINK_CONTAINER" \
    psql -X -w -h /var/run/postgresql -U "$role" -d "$POSTGRES_DB" \
      -v ON_ERROR_STOP=1 "$@"
}

sink_sql() {
  local role=$1
  local password=$2
  local sql=$3
  sink_psql "$role" "$password" -c "$sql"
}

sink_query() {
  local role=$1
  local password=$2
  local sql=$3
  sink_psql "$role" "$password" -Atc "$sql"
}

sink_super_sql() {
  sink_sql "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$1"
}

sink_super_query() {
  sink_query "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$1"
}

run_sink_rollup() {
  sink_psql openbrain_logs_rollup "$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
    < db/summarize_funnel.sql
}

run_sink_assertion() {
  sink_psql "$POSTGRES_USER" "$POSTGRES_PASSWORD" -f - \
    < db/log-sink/02-log-sink-assertion.sql
}
