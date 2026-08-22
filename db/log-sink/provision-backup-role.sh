#!/bin/sh
# Create or rotate the optional summary-backup identity on an existing sink.
# Fresh clusters get the same role from 00-log-sink-roles.sh; existing PGDATA
# never reruns initdb.d, so the upgrade runbook streams this script explicitly.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${OPENBRAIN_LOGS_BACKUP_PASSWORD:?OPENBRAIN_LOGS_BACKUP_PASSWORD is required}"

PGPASSWORD="$POSTGRES_PASSWORD" psql -X -w -v ON_ERROR_STOP=1 \
  -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --set=backup_password="$OPENBRAIN_LOGS_BACKUP_PASSWORD" <<-'EOSQL'
  BEGIN;
  SELECT 'CREATE ROLE openbrain_logs_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE to_regrole('openbrain_logs_backup') IS NULL
  \gexec
  ALTER ROLE openbrain_logs_backup LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'backup_password';
  COMMIT;
EOSQL
