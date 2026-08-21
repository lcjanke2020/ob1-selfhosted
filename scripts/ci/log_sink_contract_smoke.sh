#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${LOG_SINK_RUNNER_ACTIVE:-}" != 1 ]]; then
  exec "$SCRIPT_DIR/run_log_sink_smokes.sh" contract
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/log_sink_common.sh"

phase="${1:-all}"
case "$phase" in
  all|baseline|roles|auth|assertion) ;;
  *)
    echo "usage: ${0##*/} [all|baseline|roles|auth|assertion]" >&2
    exit 2
    ;;
esac

if [[ "$phase" == all || "$phase" == baseline ]]; then
log_sink_step "Init assertion and durable completion marker both ran"
# Absence is as meaningful as failure: a silently skipped assertion would let
# every later check pass against an unverified schema.
docker logs "$LOG_SINK_CONTAINER" 2>&1 | grep -F 'log sink: invariants OK'
docker logs "$LOG_SINK_CONTAINER" 2>&1 | \
  grep -F 'log sink: init completion marker written'

log_sink_step "Sink is socket-only with no TCP listener"
# PGPASSWORD is required here: otherwise a failed query could produce an empty
# value for the wrong reason and make an empty-listen-address check look green.
listen_addresses=$(sink_super_query \
  "select 'la=[' || current_setting('listen_addresses') || ']'")
echo "$listen_addresses"
test "$listen_addresses" = 'la=[]' || {
  echo "listen_addresses is not empty: $listen_addresses" >&2
  exit 1
}
# 5432 == 0x1538. Branch explicitly so grep's expected miss is not inverted
# by set -e.
if docker exec "$LOG_SINK_CONTAINER" sh -c \
  'grep -q ":1538" /proc/net/tcp'; then
  echo "a TCP listener on 5432 exists" >&2
  exit 1
fi
echo "no TCP listener; socket only"
fi

if [[ "$phase" == all || "$phase" == roles ]]; then
log_sink_step "Roles hold exactly their production grants and no more"
# The ingester's real statement shape: bare INSERT, no RETURNING (RETURNING
# would need SELECT on id, which it deliberately lacks).
sink_sql openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
  "insert into funnel_access_log
     (ts,socket,client_ip,method,path,status,duration_ms,bytes_out,user_agent)
   values
     (now() - interval '2 hours','funnel','192.0.2.9','GET','/mcp',401,12,0,'ci'),
     (now() - interval '40 days','funnel','192.0.2.9','GET','/old',404,3,0,'ci');" \
  >/dev/null
! sink_query openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
  "select count(*) from funnel_access_log;" 2>/dev/null || {
  echo "ingester can SELECT; it must be INSERT-only" >&2
  exit 1
}
! sink_query openbrain_monitor "$OPENBRAIN_MONITOR_PASSWORD" \
  "select count(*) from funnel_access_summary;" 2>/dev/null || {
  echo "monitor can read the summary table" >&2
  exit 1
}
test "$(sink_query openbrain_monitor "$OPENBRAIN_MONITOR_PASSWORD" \
  'select count(*) from funnel_access_log;')" = 2
sink_query openbrain_monitor "$OPENBRAIN_MONITOR_PASSWORD" \
  "WITH bounds AS MATERIALIZED (
     SELECT COALESCE(MAX(id), 0)::bigint AS max_id,
            FLOOR(EXTRACT(EPOCH FROM now()))::bigint AS cutoff_epoch
     FROM funnel_access_log
   )
   SELECT max_id || '|' || cutoff_epoch || '|' ||
          (SELECT COUNT(*) FROM funnel_access_log AS event
           WHERE event.id <= bounds.max_id
             AND event.socket = 'funnel'
             AND event.status = 401
             AND event.ts > now() - interval '5 minutes')
   FROM bounds;" | grep -Eq '^[0-9]+\|[0-9]+\|[0-9]+$'
! sink_sql openbrain_logs_rollup "$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
  "create table nope(x int);" 2>/dev/null || {
  echo "a sink role can CREATE in public" >&2
  exit 1
}
echo "ingester INSERT-only, monitor one-table real probes, no role may CREATE"
fi

if [[ "$phase" == all || "$phase" == auth ]]; then
log_sink_step "Socket connections require SCRAM authentication"
# The image ships `local all all trust`. If --auth-local did not take, every
# least-privilege grant would be decorative because a socket caller could
# connect as the superuser.
! docker exec -i -e PGPASSWORD=wrong "$LOG_SINK_CONTAINER" \
  psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" -Atc 'select 1' 2>/dev/null || {
  echo "superuser accepted a wrong password on the socket" >&2
  exit 1
}
echo "socket auth is scram, not trust"
fi

if [[ "$phase" == all || "$phase" == assertion ]]; then
log_sink_step "Completed-catalog assertion passes before mutation probes"
run_sink_assertion | grep -F 'invariants OK'

log_sink_step "Assertion rejects widened grants and foreign grantees"
sink_super_query \
  "grant select on funnel_access_summary to openbrain_monitor;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a widened grant" >&2
  exit 1
}
sink_super_query \
  "revoke select on funnel_access_summary from openbrain_monitor;" >/dev/null
sink_super_query "grant select on funnel_access_log to public;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a GRANT to PUBLIC" >&2
  exit 1
}
sink_super_query "revoke select on funnel_access_log from public;" >/dev/null
sink_super_query \
  "grant insert on funnel_access_log to openbrain_ingester with grant option;" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed WITH GRANT OPTION" >&2
  exit 1
}
sink_super_query \
  "revoke grant option for insert on funnel_access_log from openbrain_ingester;" \
  >/dev/null
sink_super_query "grant select on funnel_access_log to pg_monitor;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a grant to a foreign grantee" >&2
  exit 1
}
sink_super_query "revoke select on funnel_access_log from pg_monitor;" >/dev/null

log_sink_step "Assertion rejects missing, disabled, stray, or inherited roles"
sink_super_query "create role intruder login;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a stray role" >&2
  exit 1
}
sink_super_query "drop role intruder;" >/dev/null
sink_super_query "alter role openbrain_ingester nologin;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a disabled required role" >&2
  exit 1
}
sink_super_query "alter role openbrain_ingester login;" >/dev/null
sink_super_query \
  "alter role openbrain_ingester rename to ci_missing_ingester;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a missing required role" >&2
  exit 1
}
sink_super_query \
  "alter role ci_missing_ingester rename to openbrain_ingester;" >/dev/null
sink_super_query "grant pg_read_all_data to openbrain_ingester;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed an inherited (membership) privilege" >&2
  exit 1
}
sink_super_query "revoke pg_read_all_data from openbrain_ingester;" >/dev/null

log_sink_step "Assertion rejects stray relations, schemas, and database CREATE"
sink_super_query "create table thoughts(id int);" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a stray relation" >&2
  exit 1
}
sink_super_query "drop table thoughts;" >/dev/null
sink_super_query \
  "grant create on database $POSTGRES_DB to openbrain_monitor;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed database CREATE" >&2
  exit 1
}
sink_super_query \
  "revoke create on database $POSTGRES_DB from openbrain_monitor;" >/dev/null
sink_super_query "create schema ci_extra authorization openbrain_ingester;" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a stray schema" >&2
  exit 1
}
sink_super_query "drop schema ci_extra;" >/dev/null

log_sink_step "Assertion rejects stray and repointed routines or views"
sink_super_query \
  "create function public.ci_probe() returns bigint language sql security definer as 'select count(*) from funnel_access_log';" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a SECURITY DEFINER routine" >&2
  exit 1
}
sink_super_query "drop function public.ci_probe();" >/dev/null
sink_super_query \
  "create function pg_catalog.ci_leak() returns bigint language sql security definer as 'select count(*) from funnel_access_log';" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a pg_catalog definer function" >&2
  exit 1
}
sink_super_query "drop function pg_catalog.ci_leak();" >/dev/null
sink_super_query \
  "create function information_schema.ci_leak() returns int language sql as 'select 1';" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed an information_schema routine" >&2
  exit 1
}
sink_super_query "drop function information_schema.ci_leak();" >/dev/null
sink_super_query \
  "create view information_schema.ci_leak_view as select 1 as x;" >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed an information_schema view" >&2
  exit 1
}
sink_super_query "drop view information_schema.ci_leak_view;" >/dev/null

# In-place catalog changes that keep the object's low OID (CREATE OR REPLACE /
# ALTER), which the assertion's age test cannot see on its own.
sink_super_query \
  "alter function information_schema._pg_expandarray(anyarray) security definer;" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed an existing routine flipped to SECURITY DEFINER" >&2
  exit 1
}
sink_super_query \
  "alter function information_schema._pg_expandarray(anyarray) security invoker;" \
  >/dev/null
sink_super_query \
  "create or replace view information_schema.information_schema_catalog_name as select (select count(*) from funnel_access_log)::text::information_schema.sql_identifier as catalog_name;" \
  >/dev/null
! run_sink_assertion 2>/dev/null || {
  echo "assertion missed a catalog view repointed at the sink tables" >&2
  exit 1
}
sink_super_query \
  "create or replace view information_schema.information_schema_catalog_name as select current_database()::information_schema.sql_identifier as catalog_name;" \
  >/dev/null
run_sink_assertion | grep -F 'invariants OK'
echo "assertion catches widened grants, grant options, memberships, missing/disabled/foreign roles, database CREATE, stray relations, stray schemas, stray routines (including system-schema definer functions and views), in-place SECURITY DEFINER flips, catalog views repointed at sink tables, and PUBLIC"
fi
