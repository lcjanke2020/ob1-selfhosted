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
  CREATE ROLE openbrain_readonly LOGIN PASSWORD :'readonly_password';
EOSQL

# Pattern B observability-only role for the log-ingester sidecar.
# Created conditionally so Pattern A operators (no ingester running) can
# leave OPENBRAIN_INGESTER_PASSWORD unset; Pattern B operators set it in
# .env and the role is created with INSERT-only privileges on
# funnel_access_log (granted in 02-observability.sql). The split keeps
# the ingester from sharing openbrain_app's DML on `thoughts` — the
# ingester parses attacker-controlled Caddy JSON, so its blast radius
# on compromise is bounded to one observability table.
if [ -n "${OPENBRAIN_INGESTER_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=ingester_password="$OPENBRAIN_INGESTER_PASSWORD" \
    <<-'EOSQL'
    CREATE ROLE openbrain_ingester LOGIN PASSWORD :'ingester_password';
EOSQL
else
  echo "[00-roles] OPENBRAIN_INGESTER_PASSWORD not set; skipping openbrain_ingester (Pattern A)"
fi

# SELECT-only metadata role for the host-side funnel monitor
# (scripts/funnel_monitor.sh, run from the ingress qube in the three-qube
# split). Created conditionally like the ingester: set
# OPENBRAIN_MONITOR_PASSWORD to create it; its grants (SELECT on
# funnel_access_log + mcp_auth_events ONLY) land in 02-observability.sql.
# Deliberately not openbrain_readonly (SELECT on everything): this
# credential sits on the internet-adjacent edge, so it may read request
# metadata but must never be able to read a thought.
if [ -n "${OPENBRAIN_MONITOR_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=monitor_password="$OPENBRAIN_MONITOR_PASSWORD" \
    <<-'EOSQL'
    CREATE ROLE openbrain_monitor LOGIN PASSWORD :'monitor_password';
EOSQL
else
  echo "[00-roles] OPENBRAIN_MONITOR_PASSWORD not set; skipping openbrain_monitor (no host-side funnel monitor)"
fi
