#!/bin/bash
# Existing-deployment migration for the openbrain_monitor role.
#
# The role is created automatically by db/00-roles.sh on a fresh Postgres
# data directory (when OPENBRAIN_MONITOR_PASSWORD is set), but
# docker-entrypoint-initdb.d scripts only run on init. This script creates
# the role idempotently against an existing DB so an operator adding the
# host-side funnel monitor (scripts/funnel_monitor.sh) to a pre-monitor-role
# checkout can do so without wiping the volume. It is the exact counterpart
# of upgrade-add-ingester-role.sh — see that script for the psql heredoc
# rationale (`:'var'` substitution is client-side and not `-c`-compatible).
#
# Compose deployments only (docker exec). On the qubes-split native db qube,
# run the equivalent CREATE/ALTER ROLE by hand over the loopback socket or
# from the app qube as superuser — see deploy/qubes/db-qube/README.md.
#
# Run from your compose directory (deploy/compose-local or deploy/compose-tailnet) with .env present.
# Idempotent and reconciling — safe to re-run, and the "role exists"
# branch runs `ALTER ROLE ... WITH PASSWORD` so the role's password is
# brought into sync with the current OPENBRAIN_MONITOR_PASSWORD value
# in .env on every run. Operators who rotate the credential don't need
# to drop the role first.
#
# Exit codes:
#   0 — role exists with current .env password (created or reconciled)
#   1 — postgres container not running, prerequisite missing, or psql failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The funnel monitor watches the public Funnel door; the compose project
# with the .env lives in deploy/compose-tailnet by default.
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-tailnet" && pwd)}"

cd "$COMPOSE_DIR"

if [[ ! -f .env ]]; then
  echo "[upgrade-monitor-role] .env not found in $(pwd); run from your compose directory" >&2
  exit 1
fi

# Load .env so OPENBRAIN_MONITOR_PASSWORD + POSTGRES_DB are in scope.
# Scoped via set -a/+a so we don't pollute the caller's environment.
set -a
# shellcheck disable=SC1091
. .env
set +a

: "${OPENBRAIN_MONITOR_PASSWORD:?OPENBRAIN_MONITOR_PASSWORD must be set in .env before running this upgrade}"

if ! docker compose ps --status=running postgres | grep -q postgres; then
  echo "[upgrade-monitor-role] postgres container not running; aborting" >&2
  exit 1
fi

# Existence check first so we can pick CREATE vs ALTER and give a clear
# message about which branch ran.
existing="$(docker compose exec -T postgres \
  psql -tA -U postgres -d "${POSTGRES_DB:-openbrain}" \
  -c "SELECT 1 FROM pg_roles WHERE rolname='openbrain_monitor'" \
  | tr -d '[:space:]')"

if [[ -n "$existing" ]]; then
  # Reconcile password — operator may have rotated OPENBRAIN_MONITOR_PASSWORD
  # in .env. ALTER ROLE is idempotent at the catalog level (a no-op
  # when password hash matches), so re-running this script when the
  # password hasn't changed is also fine.
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
    --set=monitor_password="$OPENBRAIN_MONITOR_PASSWORD" \
    <<-'EOSQL'
    ALTER ROLE openbrain_monitor WITH LOGIN PASSWORD :'monitor_password';
EOSQL
  echo "[upgrade-monitor-role] openbrain_monitor role exists; password reconciled with .env"
  exit 0
fi

docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
  --set=monitor_password="$OPENBRAIN_MONITOR_PASSWORD" \
  <<-'EOSQL'
  CREATE ROLE openbrain_monitor LOGIN PASSWORD :'monitor_password';
EOSQL

echo "[upgrade-monitor-role] created openbrain_monitor role"
echo "[upgrade-monitor-role] next: re-run db/02-observability.sql to apply monitor grants"
