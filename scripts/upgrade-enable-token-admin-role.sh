#!/bin/bash
# Provision or rotate the dedicated native-token administrator on an existing
# compose database. Fresh databases do this in db/00-roles.sh; init scripts do
# not rerun on an existing volume.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-local" && pwd)}"

cd "$COMPOSE_DIR"

if [[ ! -f .env ]]; then
  echo "[upgrade-token-admin] .env not found in $(pwd)" >&2
  exit 1
fi

# Explicitly naming the file is harmless for compose-local and prevents an
# override project from loading a second project-directory .env.
compose_cmd=(docker compose --env-file .env)

set -a
# shellcheck disable=SC1091
. .env
set +a

: "${OPENBRAIN_TOKEN_ADMIN_PASSWORD:?set OPENBRAIN_TOKEN_ADMIN_PASSWORD in .env before running this upgrade}"

if ! "${compose_cmd[@]}" ps --status=running postgres | grep -q postgres; then
  echo "[upgrade-token-admin] postgres container not running; aborting" >&2
  exit 1
fi

existing="$("${compose_cmd[@]}" exec -T postgres \
  psql -tA -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-openbrain}" \
  -c "SELECT 1 FROM pg_roles WHERE rolname='openbrain_token_admin'" \
  | tr -d '[:space:]')"

if [[ -n "$existing" ]]; then
  action="enabled LOGIN and reconciled its password and privilege flags"
  sql="ALTER ROLE openbrain_token_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'token_admin_password';"
else
  action="created the LOGIN role"
  sql="CREATE ROLE openbrain_token_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'token_admin_password';"
fi

"${compose_cmd[@]}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-openbrain}" \
  --set=token_admin_password="$OPENBRAIN_TOKEN_ADMIN_PASSWORD" \
  <<EOSQL
$sql
EOSQL

echo "[upgrade-token-admin] $action"
echo "[upgrade-token-admin] next: apply db/08-access-tokens.sql, then db/03-grants-assertion.sql"
