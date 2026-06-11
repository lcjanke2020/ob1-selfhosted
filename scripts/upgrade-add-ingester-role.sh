#!/bin/bash
# Existing-deployment migration for the openbrain_ingester role.
#
# The role is created automatically by db/00-roles.sh on a fresh Postgres
# data directory, but docker-entrypoint-initdb.d scripts only run on init.
# This script creates the role idempotently against an existing DB so a
# Pattern B operator upgrading from a pre-ingester-role checkout can
# switch the log-ingester to the new role without wiping the volume.
#
# Run from your compose directory (deploy/compose-local or deploy/compose-tailnet) with .env present.
# Idempotent and reconciling — safe to re-run, and the "role exists"
# branch runs `ALTER ROLE ... WITH PASSWORD` so the role's password is
# brought into sync with the current OPENBRAIN_INGESTER_PASSWORD value
# in .env on every run. Operators who rotate the credential don't need
# to drop the role first.
#
# Exit codes:
#   0 — role exists with current .env password (created or reconciled)
#   1 — postgres container not running, prerequisite missing, or psql failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The ingester role is a Pattern B concern; the compose project with the
# .env lives in deploy/compose-tailnet by default.
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-tailnet" && pwd)}"

cd "$COMPOSE_DIR"

if [[ ! -f .env ]]; then
  echo "[upgrade-ingester-role] .env not found in $(pwd); run from your compose directory" >&2
  exit 1
fi

# Load .env so OPENBRAIN_INGESTER_PASSWORD + POSTGRES_DB are in scope.
# Scoped via set -a/+a so we don't pollute the caller's environment.
set -a
# shellcheck disable=SC1091
. .env
set +a

: "${OPENBRAIN_INGESTER_PASSWORD:?OPENBRAIN_INGESTER_PASSWORD must be set in .env before running this upgrade}"

if ! docker compose ps --status=running postgres | grep -q postgres; then
  echo "[upgrade-ingester-role] postgres container not running; aborting" >&2
  exit 1
fi

# Existence check first so we can pick CREATE vs ALTER and give a clear
# message about which branch ran.
existing="$(docker compose exec -T postgres \
  psql -tA -U postgres -d "${POSTGRES_DB:-openbrain}" \
  -c "SELECT 1 FROM pg_roles WHERE rolname='openbrain_ingester'" \
  | tr -d '[:space:]')"

# Both branches use the same --set + :'var' substitution pattern as
# db/00-roles.sh so SQL-special characters in the password (single
# quotes, backslashes) are handled correctly without shell-level
# string escaping. The SQL is fed via stdin (heredoc) rather than -c:
# psql 16's documented contract for -c is "a command string completely
# parsable by the server", which excludes the client-side `:'var'`
# substitution (verified empirically — psql 16.14 returns
# `ERROR: syntax error at or near ":"` for `-c "SELECT :'foo'"`).
# Heredoc form is also consistent with the existing 00-roles.sh pattern
# so a future maintainer reading both files sees the same shape.
if [[ -n "$existing" ]]; then
  # Reconcile password — operator may have rotated OPENBRAIN_INGESTER_PASSWORD
  # in .env. ALTER ROLE is idempotent at the catalog level (a no-op
  # when password hash matches), so re-running this script when the
  # password hasn't changed is also fine.
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
    --set=ingester_password="$OPENBRAIN_INGESTER_PASSWORD" \
    <<-'EOSQL'
    ALTER ROLE openbrain_ingester WITH LOGIN PASSWORD :'ingester_password';
EOSQL
  echo "[upgrade-ingester-role] openbrain_ingester role exists; password reconciled with .env"
  exit 0
fi

docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
  --set=ingester_password="$OPENBRAIN_INGESTER_PASSWORD" \
  <<-'EOSQL'
  CREATE ROLE openbrain_ingester LOGIN PASSWORD :'ingester_password';
EOSQL

echo "[upgrade-ingester-role] created openbrain_ingester role"
echo "[upgrade-ingester-role] next: re-run db/02-observability.sql to apply ingester grants"
