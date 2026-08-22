#!/bin/bash
# Create the LOG SINK's roles from passwords passed in via env vars.
#
# This is the ingress qube's local Funnel-log store — a separate Postgres
# cluster from the canonical corpus, holding request metadata and nothing
# else. See deploy/qubes/ingress-qube/README.md § Local log sink.
#
# Four roles, all least-privilege; the sink has no application role and no
# `openbrain_readonly`, because there is nothing here worth a read-everything
# credential. Table grants land in 01-log-sink.sql.
#
#   openbrain_ingester      INSERT-only. Historical name, now valid only here;
#                           the corpus assertion rejects it entirely.
#   openbrain_monitor       SELECT-only, one table. Likewise sink-only.
#   openbrain_logs_rollup   DML on both observability tables, for the daily
#                           summary + retention pass. Corpus auth-event
#                           retention runs as openbrain_app; deliberately not reusing
#                           that name here, so no file on the internet-facing
#                           qube ever holds a secret called
#                           OPENBRAIN_APP_PASSWORD.
#   openbrain_logs_backup   SELECT-only on the aggregate table. Optional and
#                           deliberately unable to read raw IP/user-agent rows;
#                           a fixed qrexec service uses it for summary backup.
#
# Passwords are passed to psql via --set and substituted with :'var' (which
# auto-quotes and escapes) rather than interpolated into the SQL text via
# bash, so passwords containing quotes or backslashes work correctly.
#
# Note: docker-entrypoint-initdb.d scripts run only on a freshly-initialized
# data directory, so plain CREATE ROLE is sufficient here. Existing sinks add
# or rotate the optional backup identity with provision-backup-role.sh, then
# replay 01-log-sink.sql and the assertion; never wipe PGDATA just to add it.
set -euo pipefail

: "${OPENBRAIN_INGESTER_PASSWORD:?OPENBRAIN_INGESTER_PASSWORD must be set in the ingress qube .env}"
: "${OPENBRAIN_LOGS_ROLLUP_PASSWORD:?OPENBRAIN_LOGS_ROLLUP_PASSWORD must be set in the ingress qube .env}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ingester_password="$OPENBRAIN_INGESTER_PASSWORD" \
  --set=rollup_password="$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
  <<-'EOSQL'
  CREATE ROLE openbrain_ingester LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'ingester_password';
  CREATE ROLE openbrain_logs_rollup LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'rollup_password';
EOSQL

# The host-side funnel monitor is optional: no monitor password means no
# monitor role, and 01-log-sink.sql skips its grant. A sink with no monitor
# still ingests and still rolls up.
if [ -n "${OPENBRAIN_MONITOR_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=monitor_password="$OPENBRAIN_MONITOR_PASSWORD" \
    <<-'EOSQL'
    CREATE ROLE openbrain_monitor LOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'monitor_password';
EOSQL
else
  echo "[00-log-sink-roles] OPENBRAIN_MONITOR_PASSWORD not set; skipping openbrain_monitor (no host-side funnel monitor)"
fi

# The off-box summary backup is optional. Keeping its role absent when the
# qrexec pull path is not deployed avoids minting an unused edge credential.
if [ -n "${OPENBRAIN_LOGS_BACKUP_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=backup_password="$OPENBRAIN_LOGS_BACKUP_PASSWORD" \
    <<-'EOSQL'
    CREATE ROLE openbrain_logs_backup LOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'backup_password';
EOSQL
else
  echo "[00-log-sink-roles] OPENBRAIN_LOGS_BACKUP_PASSWORD not set; skipping openbrain_logs_backup (no qrexec summary backup)"
fi
