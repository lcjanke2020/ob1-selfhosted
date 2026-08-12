#!/usr/bin/env bash
# Daily funnel observability summary wrapper.
#
# Run by a host-side systemd timer or cron entry (see
# deploy/compose-tailnet/README.md, or the shipped app-qube user units). Runs
# db/summarize_funnel.sql through one of two explicit backends:
#   compose  — psql inside the single-host stack's postgres container (default)
#   postgres — host psql over TCP, for the split app qube
#
# Streams the markdown output to:
#   1. stdout (so journald / cron captures it)
#   2. ${SUMMARY_DIR}/funnel-summary-YYYYMMDD.md — point SUMMARY_DIR at a
#      trusted directory you replicate off the box (Syncthing, rsync, …) when
#      you intentionally want an off-host copy of request metadata. Exclude
#      `/.funnel-summary-*` from replication so staging files never leave the
#      host after an uncatchable SIGKILL or qube crash.
#
# Configuration (default in []):
#   FUNNEL_SUMMARY_ENV_FILE [~/.config/funnel-summary.env, loaded when present]
#   SUMMARY_BACKEND  [compose] (`compose` | `postgres`)
#   SUMMARY_DIR       [~/openbrain-funnel-summaries]
#   SUMMARY_SQL_FILE  [repo db/summarize_funnel.sql + db/summarize_auth_events.sql,
#                      or adjacent installed copies] — a whitespace-separated
#                      LIST, concatenated in order into one psql session. A
#                      split deployment sets it to its own half; see below.
#   SUMMARY_ROLE      [openbrain_app] — the role the rollup connects as
#   SUMMARY_ROLE_PASSWORD [$OPENBRAIN_APP_PASSWORD] — that role's password
# Except for selecting FUNNEL_SUMMARY_ENV_FILE itself, values sourced from that
# file take precedence over inherited environment values.
#
# compose backend:
#   COMPOSE_DIR       [deploy/compose-tailnet, resolved relative to this script]
#   COMPOSE_PROJECT_NAME [optional, standard Compose project-name override]
#
# postgres backend:
#   DB_HOST            [required] — a hostname/IP for TCP, or an absolute path
#                      for a unix-socket directory (the ingress qube's local
#                      log sink, which has no TCP listener)
#   DB_PORT            [5432]
#   POSTGRES_DB        [openbrain]
#   SUMMARY_ROLE_PASSWORD [required; defaults to OPENBRAIN_APP_PASSWORD]
#   PGCONNECT_TIMEOUT  [10]
#   PSQL_BIN           [psql; test/package override only]
#
# Three deployments, three configurations:
#   single-host compose — defaults throughout: both SQL files, openbrain_app,
#                         one database holding every observability table.
#   split app qube      — SUMMARY_SQL_FILE=…/summarize_auth_events.sql against
#                         the canonical corpus on the db qube. mcp writes
#                         mcp_auth_events there; the funnel half does not
#                         belong to this qube any more.
#   split ingress qube  — SUMMARY_SQL_FILE=…/summarize_funnel.sql,
#                         SUMMARY_ROLE=openbrain_logs_rollup, and a DB_HOST
#                         that is a socket path into the local log sink.
#
# Idempotent: re-running on the same day atomically replaces that day's .md
# file and re-runs the daily summary INSERT ... ON CONFLICT in postgres. A
# failed run never publishes its partial report over the last successful one.
#
# Exit codes:
#   0 — summary written
#   1 — database unavailable, required client missing, or psql failed
#   2 — invalid configuration, unreadable SQL, or unwritable output

set -euo pipefail
umask 077

# Preserve an inherited value for configuration precedence, but strip its
# export attribute before stat or any other child process can inherit it. The
# check is repeated after sourcing in case a hand-written env file uses export.
export -n OPENBRAIN_APP_PASSWORD SUMMARY_ROLE_PASSWORD 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The split deployment keeps the job's app-role credential in a narrow 0600
# file instead of exporting the app compose .env (which also contains admin,
# OAuth, and notification secrets). Keep the file optional so the established
# single-host compose invocation remains zero-config.
ENV_FILE="${FUNNEL_SUMMARY_ENV_FILE:-$HOME/.config/funnel-summary.env}"
if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
    echo "[funnel_daily_summary] env file must be a regular, non-symlink file: $ENV_FILE" >&2
    exit 2
  fi
  if [[ ! -O "$ENV_FILE" ]]; then
    echo "[funnel_daily_summary] env file must be owned by the current user: $ENV_FILE" >&2
    exit 2
  fi
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "[funnel_daily_summary] env file is unreadable: $ENV_FILE" >&2
    exit 2
  fi
  ENV_MODE="$(stat -c '%a' -- "$ENV_FILE")" || {
    echo "[funnel_daily_summary] could not inspect env file permissions: $ENV_FILE" >&2
    exit 2
  }
  if [[ ! "$ENV_MODE" =~ ^[0-7]{3,4}$ ]] || (( (8#$ENV_MODE & 077) != 0 )); then
    echo "[funnel_daily_summary] env file must have no group/other permissions: $ENV_FILE (mode $ENV_MODE)" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  if ! . "$ENV_FILE"; then
    echo "[funnel_daily_summary] env file could not be loaded: $ENV_FILE" >&2
    exit 2
  fi
elif [[ -n "${FUNNEL_SUMMARY_ENV_FILE:-}" ]]; then
  echo "[funnel_daily_summary] configured env file does not exist: $ENV_FILE" >&2
  exit 2
fi

# The credential remains a shell variable for the direct backend, but must not
# be inherited under its original name by mktemp, tee, docker, or the psql
# client. The psql invocation below exports only command-scoped PGPASSWORD.
export -n OPENBRAIN_APP_PASSWORD SUMMARY_ROLE_PASSWORD 2>/dev/null || true

SUMMARY_BACKEND="${SUMMARY_BACKEND:-compose}"
SUMMARY_DIR="${SUMMARY_DIR:-$HOME/openbrain-funnel-summaries}"

# Which role runs the rollup, and its password. Both default to the historical
# openbrain_app pair, so an existing env file needs no edit.
#
# They are separate knobs because the ingress qube's local log sink is a
# DIFFERENT cluster with a different least-privilege role
# (`openbrain_logs_rollup`, DML on two observability tables and nothing else).
# Naming that role openbrain_app would have avoided this code — and put a
# variable literally called OPENBRAIN_APP_PASSWORD, holding an unrelated
# secret, on the internet-facing qube. Two roles that mean different things
# get two names.
SUMMARY_ROLE="${SUMMARY_ROLE:-openbrain_app}"
SUMMARY_ROLE_PASSWORD="${SUMMARY_ROLE_PASSWORD:-${OPENBRAIN_APP_PASSWORD:-}}"

# The observability rollup is split by owning table — summarize_funnel.sql
# (funnel_access_log + funnel_access_summary) and summarize_auth_events.sql
# (mcp_auth_events) — because the split topology no longer keeps both in one
# database. SUMMARY_SQL_FILE is therefore a LIST: whitespace-separated paths,
# concatenated in order into ONE psql session so the pair still yields a single
# report. A single path is a one-element list, so existing overrides keep
# working unchanged.
#
# Word-splitting the value is deliberate (hence the disabled shellcheck): the
# list separator IS whitespace, and a path containing whitespace is not
# supported — a constraint the missing/unreadable check below reports plainly
# rather than silently mangling.
#
# Defaults resolve BOTH files, which is right for a single-host install where
# one database holds every observability table. A split deployment sets the
# variable to just its own half: the ingress qube's local log sink gets
# summarize_funnel.sql, the app qube's canonical corpus gets
# summarize_auth_events.sql. A repo checkout keeps the SQL one directory above
# scripts/; the per-qube installs copy script and SQL side-by-side in $HOME so
# the timer does not depend on a checkout path.
if [[ -n "${SUMMARY_SQL_FILE:-}" ]]; then
  # shellcheck disable=SC2206
  SQL_FILES=( ${SUMMARY_SQL_FILE} )
elif [[ -r "$SCRIPT_DIR/../db/summarize_funnel.sql" ]]; then
  SQL_FILES=(
    "$SCRIPT_DIR/../db/summarize_funnel.sql"
    "$SCRIPT_DIR/../db/summarize_auth_events.sql"
  )
else
  SQL_FILES=(
    "$SCRIPT_DIR/summarize_funnel.sql"
    "$SCRIPT_DIR/summarize_auth_events.sql"
  )
fi

if (( ${#SQL_FILES[@]} == 0 )); then
  echo "[funnel_daily_summary] SUMMARY_SQL_FILE is set but lists no paths" >&2
  exit 2
fi

for sql in "${SQL_FILES[@]}"; do
  if [[ ! -r "$sql" ]]; then
    echo "[funnel_daily_summary] summary SQL is missing/unreadable: $sql" >&2
    exit 2
  fi
done
unset sql

if [[ ! -d "$SUMMARY_DIR" ]]; then
  echo "[funnel_daily_summary] SUMMARY_DIR=$SUMMARY_DIR does not exist; creating" >&2
  mkdir -p -m 0700 -- "$SUMMARY_DIR" || {
    echo "[funnel_daily_summary] mkdir failed" >&2
    exit 2
  }
fi

if [[ ! -w "$SUMMARY_DIR" ]]; then
  echo "[funnel_daily_summary] SUMMARY_DIR=$SUMMARY_DIR is not writable" >&2
  exit 2
fi

# Use yesterday's UTC date so the daily run captures a complete day.
DATESTAMP="$(date -u -d 'yesterday' +%Y%m%d)"
OUT_FILE="$SUMMARY_DIR/funnel-summary-$DATESTAMP.md"

run_summary() {
  case "$SUMMARY_BACKEND" in
    compose)
      # The summary is a Pattern-B concern, so the single-host compose project
      # and its .env live in deploy/compose-tailnet by default.
      local compose_dir
      compose_dir="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-tailnet" && pwd)}"
      cd "$compose_dir"

      # The explicit file is a security boundary for Pattern B: without it,
      # COMPOSE_FILE can make Compose load deploy/compose-local/.env as a
      # second source and fill a key missing from this deployment's file.
      local -a compose_cmd=(docker compose --env-file .env)

      # Load .env only for POSTGRES_DB. Docker Compose reads the same file for
      # interpolation itself, so none of its secrets need to be allexported by
      # this wrapper. psql connects to the container-local socket under the
      # image's local trust rule.
      if [[ -f .env ]]; then
        # An inherited COMPOSE_PROJECT_NAME (the documented override above)
        # must beat the .env's pinned value — compose's own env-beats-.env
        # precedence — so preserve it across the source.
        local inherited_project_set="${COMPOSE_PROJECT_NAME+x}"
        local inherited_project="${COMPOSE_PROJECT_NAME-}"
        # shellcheck disable=SC1091
        . .env
        if [[ -n "$inherited_project_set" ]]; then
          export COMPOSE_PROJECT_NAME="$inherited_project"
        fi
        export -n OPENBRAIN_APP_PASSWORD POSTGRES_PASSWORD 2>/dev/null || true
      fi

      if ! "${compose_cmd[@]}" ps --status=running postgres | grep -q postgres; then
        echo "[funnel_daily_summary] postgres container not running; aborting" >&2
        return 1
      fi

      cat -- "${SQL_FILES[@]}" | "${compose_cmd[@]}" exec -T postgres \
        psql -X -v ON_ERROR_STOP=1 -U "$SUMMARY_ROLE" \
        -d "${POSTGRES_DB:-openbrain}" -f - || return 1
      ;;

    postgres)
      for required in DB_HOST SUMMARY_ROLE_PASSWORD; do
        if [[ -z "${!required:-}" ]]; then
          echo "[funnel_daily_summary] $required is required for SUMMARY_BACKEND=postgres" >&2
          return 2
        fi
      done

      local psql_bin="${PSQL_BIN:-psql}"
      if ! command -v -- "$psql_bin" >/dev/null 2>&1; then
        echo "[funnel_daily_summary] psql client not found: $psql_bin" >&2
        return 1
      fi

      # -X ignores a user .psqlrc that could change report formatting; -w
      # forbids an unattended password prompt. The source variable remains
      # unexported; only command-scoped PGPASSWORD reaches this client.
      #
      # DB_HOST is passed through verbatim, so an absolute path selects a unix
      # socket DIRECTORY instead of a TCP host — libpq's own convention, no
      # special case needed here. That is how the ingress qube's local log
      # sink is reached: no TCP listener exists to point a hostname at.
      # PGCONNECT_TIMEOUT is harmless on that path (it bounds a handshake
      # that is already local).
      cat -- "${SQL_FILES[@]}" | \
      PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}" \
      PGPASSWORD="$SUMMARY_ROLE_PASSWORD" \
        "$psql_bin" -X -w \
        -h "$DB_HOST" -p "${DB_PORT:-5432}" \
        -U "$SUMMARY_ROLE" -d "${POSTGRES_DB:-openbrain}" \
        -v ON_ERROR_STOP=1 -f - || return 1
      ;;

    *)
      echo "[funnel_daily_summary] invalid SUMMARY_BACKEND=$SUMMARY_BACKEND (expected compose or postgres)" >&2
      return 2
      ;;
  esac
}

# We feed the SQL via stdin. ON_ERROR_STOP is set inside the SQL, so any
# DB-side failure surfaces on stderr and as a non-zero psql exit; stdout is
# both written to the report and retained in the journald/cron trace by tee.
#
# Both backends connect as $SUMMARY_ROLE — openbrain_app by default (least
# privilege; DML on the observability tables, no thought deletion), or
# openbrain_logs_rollup on the ingress qube's local log sink. The compose
# backend uses container-local socket trust and passes no password across
# `docker exec`; the postgres backend sends the role's password from the
# narrow job env to host psql, over TCP (in the Qubes split, the app qube's
# own-IP ConnectTCP forwarder) or a local unix socket depending on DB_HOST.
# Neither path needs the database superuser.
#
# The summary SQL is purely INSERT/DELETE/SELECT, no schema mods, and all of
# those operations are covered by openbrain_app's grants in
# 02-observability.sql (and, on the sink, by openbrain_logs_rollup's in
# db/log-sink/01-log-sink.sql).
TMP_FILE="$(mktemp "$SUMMARY_DIR/.funnel-summary-$DATESTAMP.XXXXXX")"
trap 'rm -f -- "$TMP_FILE"' EXIT

{
  echo "[funnel_daily_summary] run started: $(date -u -Iseconds)"
  echo "[funnel_daily_summary] summary file: $OUT_FILE"
  echo
} | tee "$TMP_FILE"

# Wrap the SQL output in a fenced code block so any attacker-controlled
# strings in the body (User-Agent values, IPs, paths from public scanner
# traffic) render as literal text — not as markdown or HTML — when the
# .md file is opened in a browser/viewer/LLM. The body still includes the
# data we want, just neutralised against `![](http://attacker/beacon)`
# style smuggling.
#
# Using 4 backticks (not 3) as defense-in-depth: under strict CommonMark
# a closing fence must be at line-start, so an embedded 3-backtick run
# inside a `path` column couldn't terminate the block. But not every
# downstream renderer (older parsers, LLM ingestion paths, the markdown
# preview on another box) is CommonMark-strict. A longer opening fence (4
# backticks) makes a body-embedded 3-backtick row harmless even under
# lenient parsers. Cost is zero; one less invariant for the safety story.
echo '````text' | tee -a "$TMP_FILE"

# psql exits non-zero on ON_ERROR_STOP triggers. `pipefail` propagates that
# through tee, and the EXIT trap removes the unpublished staging file.
run_summary | tee -a "$TMP_FILE"

echo '````' | tee -a "$TMP_FILE"

# Publish only a complete report. TMP_FILE is inside SUMMARY_DIR, so rename is
# same-filesystem and atomic to readers/replicators. Replicated directories
# should ignore `/.funnel-summary-*`; a hard kill cannot run the EXIT trap.
mv -f -- "$TMP_FILE" "$OUT_FILE"
TMP_FILE=""
trap - EXIT

echo
echo "[funnel_daily_summary] complete: $OUT_FILE"
