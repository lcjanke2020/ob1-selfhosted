#!/usr/bin/env bash
# Shared, deliberately small helpers for the corpus DB-init smoke families.
# Source this file through run_db_init_smokes.sh; it is not a standalone test.
set -euo pipefail

: "${CI_REPO_ROOT:?run through scripts/ci/run_db_init_smokes.sh}"
: "${DB_INIT_CONTAINER:?run through scripts/ci/run_db_init_smokes.sh}"
: "${DB_SMOKE_PORT:?run through scripts/ci/run_db_init_smokes.sh}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

cd "$CI_REPO_ROOT"

smoke_step() {
  printf '\n==> %s\n' "$1"
}

super_psql() {
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_INIT_CONTAINER" \
    psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

super_psql_db() {
  local database=$1
  shift
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_INIT_CONTAINER" \
    psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$database" "$@"
}

apply_sql() {
  super_psql -v ON_ERROR_STOP=1 < "$1"
}

run_deno_db_smoke() {
  deno run --config server/deno.json --frozen \
    --allow-env \
    --allow-net="127.0.0.1:$DB_SMOKE_PORT" \
    "$@"
}
