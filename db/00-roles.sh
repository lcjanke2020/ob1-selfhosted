#!/bin/bash
# Create the application roles using passwords passed in via env vars.
# Runs first (alphabetical order) so 01-schema.sql can grant to existing roles.
#
# Passwords are passed to psql via --set and substituted with :'var' (which
# auto-quotes and escapes) rather than interpolated into the SQL text via
# bash. This means passwords containing single quotes, backslashes, or other
# SQL-special characters work correctly.
#
# Note: docker-entrypoint-initdb.d scripts run only on a freshly-initialized
# data directory, so plain CREATE ROLE is sufficient — there's no prior
# state to reconcile. To re-create roles, run `docker compose down -v` to
# wipe the volume and let init re-run.
set -euo pipefail

: "${OPENBRAIN_APP_PASSWORD:?OPENBRAIN_APP_PASSWORD must be set in compose env}"
: "${OPENBRAIN_READONLY_PASSWORD:?OPENBRAIN_READONLY_PASSWORD must be set in compose env}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$OPENBRAIN_APP_PASSWORD" \
  --set=readonly_password="$OPENBRAIN_READONLY_PASSWORD" \
  <<-'EOSQL'
  CREATE ROLE openbrain_app LOGIN PASSWORD :'app_password';
  -- pg_dump deliberately executes SET row_security = off and refuses to copy
  -- from an RLS table as a non-bypass role, even when a SELECT policy allows
  -- every row. This role is already the trusted all-row backup/exploration
  -- identity and receives no DML, so BYPASSRLS preserves the existing full
  -- dump contract without weakening the application role's forced RLS.
  CREATE ROLE openbrain_readonly LOGIN BYPASSRLS PASSWORD :'readonly_password';
EOSQL

# Dedicated native-token lifecycle role. It can list non-secret token metadata
# and execute the reviewed register/revoke functions from db/08-access-tokens.sql,
# but it cannot read token hashes or any memory relation. Public/OAuth-only
# deployments may leave the password empty; the NOLOGIN role still exists so
# the schema and grant assertions converge without creating a usable credential.
if [ -n "${OPENBRAIN_TOKEN_ADMIN_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=token_admin_password="$OPENBRAIN_TOKEN_ADMIN_PASSWORD" \
    <<-'EOSQL'
    CREATE ROLE openbrain_token_admin LOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD :'token_admin_password';
EOSQL
else
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    <<-'EOSQL'
    CREATE ROLE openbrain_token_admin NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EOSQL
  echo "[00-roles] OPENBRAIN_TOKEN_ADMIN_PASSWORD not set; openbrain_token_admin is NOLOGIN"
fi
