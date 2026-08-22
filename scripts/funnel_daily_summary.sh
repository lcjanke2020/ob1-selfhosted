#!/usr/bin/env bash
# Daily split-observability summary wrapper.
#
# Run by a host-side systemd timer or cron entry (see
# deploy/compose-tailnet/README.md, or the shipped app-qube user units). Runs
# exactly one target through one of two explicit backends:
#   compose  — psql inside that target's compose database container (default)
#   postgres — host psql, for the split Qubes deployment
#
# Streams the markdown output to:
#   1. stdout (so journald / cron captures it)
#   2. ${SUMMARY_DIR}/{funnel,auth-events}-summary-YYYYMMDD.md — point
#      SUMMARY_DIR at a
#      trusted directory you replicate off the box (Syncthing, rsync, …) when
#      you intentionally want an off-host copy of request metadata. Exclude
#      `/.funnel-summary-*` and `/.auth-events-summary-*` from replication so
#      staging files never leave the
#      host after an uncatchable SIGKILL or qube crash.
#
# Configuration (default in []):
#   FUNNEL_SUMMARY_ENV_FILE [~/.config/funnel-summary.env, loaded when present]
#   SUMMARY_TARGET   REQUIRED (`sink` | `corpus`). This pins the database,
#                    role, SQL file, compose service, and allowed transport as
#                    one reviewed tuple; none can be overridden independently.
#   SUMMARY_BACKEND [compose] (`compose` | `postgres`)
#   SUMMARY_DIR     [~/openbrain-funnel-summaries]
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
#   POSTGRES_DB        [openbrain; target=corpus]
#   LOG_SINK_DB        [openbrain_logs; target=sink]
#   OPENBRAIN_APP_PASSWORD          [required for target=corpus]
#   OPENBRAIN_LOGS_ROLLUP_PASSWORD  [required for target=sink]
#   PGCONNECT_TIMEOUT  [10]
#   PSQL_BIN           [psql; test/package override only]
#
# `sink` always means summarize_funnel.sql as openbrain_logs_rollup against
# openbrain_logs (or LOG_SINK_DB), using the log-sink compose service or an
# absolute unix-socket DB_HOST. `corpus` always means summarize_auth_events.sql
# as openbrain_app against openbrain (or POSTGRES_DB), using the postgres
# compose service or a non-socket DB_HOST. Run two jobs to retain both halves.
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
export -n OPENBRAIN_APP_PASSWORD OPENBRAIN_LOGS_ROLLUP_PASSWORD \
  SUMMARY_ROLE_PASSWORD 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The split deployment keeps the job's app-role credential in a narrow 0600
# file instead of exporting the app compose .env (which also contains admin,
# OAuth, and notification secrets). The file is optional for Compose, but the
# target choice is mandatory in every invocation.
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
export -n OPENBRAIN_APP_PASSWORD OPENBRAIN_LOGS_ROLLUP_PASSWORD \
  SUMMARY_ROLE_PASSWORD 2>/dev/null || true

SUMMARY_BACKEND="${SUMMARY_BACKEND:-compose}"
SUMMARY_DIR="${SUMMARY_DIR:-$HOME/openbrain-funnel-summaries}"

# The old free-form knobs could recombine a corpus role, sink SQL, and the
# wrong transport. Refuse them rather than silently ignoring a stale unit.
for retired_knob in SUMMARY_ROLE SUMMARY_ROLE_PASSWORD SUMMARY_SQL_FILE; do
  if [[ -n "${!retired_knob:-}" ]]; then
    echo "[funnel_daily_summary] $retired_knob is retired; set SUMMARY_TARGET=sink or corpus" >&2
    exit 2
  fi
done
unset retired_knob

case "${SUMMARY_TARGET:-}" in
  sink)
    TARGET_ROLE=openbrain_logs_rollup
    TARGET_DB_ENV=LOG_SINK_DB
    TARGET_DB_DEFAULT=openbrain_logs
    TARGET_DB="${LOG_SINK_DB:-$TARGET_DB_DEFAULT}"
    TARGET_SERVICE=log-sink
    TARGET_SQL_BASENAME=summarize_funnel.sql
    TARGET_PASSWORD="${OPENBRAIN_LOGS_ROLLUP_PASSWORD:-}"
    TARGET_PASSWORD_NAME=OPENBRAIN_LOGS_ROLLUP_PASSWORD
    REPORT_STEM=funnel-summary
    ;;
  corpus)
    TARGET_ROLE=openbrain_app
    TARGET_DB_ENV=POSTGRES_DB
    TARGET_DB_DEFAULT=openbrain
    TARGET_DB="${POSTGRES_DB:-$TARGET_DB_DEFAULT}"
    TARGET_SERVICE=postgres
    TARGET_SQL_BASENAME=summarize_auth_events.sql
    TARGET_PASSWORD="${OPENBRAIN_APP_PASSWORD:-}"
    TARGET_PASSWORD_NAME=OPENBRAIN_APP_PASSWORD
    REPORT_STEM=auth-events-summary
    ;;
  *)
    echo "[funnel_daily_summary] SUMMARY_TARGET is required (sink or corpus)" >&2
    exit 2
    ;;
esac

# These are the reviewed target tuple. A Compose project's .env is sourced
# later only for its project identity and selected database-name variable; it
# must not be able to recombine the service, role, SQL, credential, or report.
readonly TARGET_ROLE TARGET_DB_ENV TARGET_DB_DEFAULT TARGET_SERVICE \
  TARGET_SQL_BASENAME TARGET_PASSWORD TARGET_PASSWORD_NAME REPORT_STEM

# A checkout keeps SQL under ../db; per-qube installs put the one selected file
# beside this wrapper. There is deliberately no arbitrary SQL path override.
if [[ -r "$SCRIPT_DIR/../db/$TARGET_SQL_BASENAME" ]]; then
  SQL_FILE="$SCRIPT_DIR/../db/$TARGET_SQL_BASENAME"
else
  SQL_FILE="$SCRIPT_DIR/$TARGET_SQL_BASENAME"
fi
if [[ ! -r "$SQL_FILE" ]]; then
  echo "[funnel_daily_summary] summary SQL is missing/unreadable: $SQL_FILE" >&2
  exit 2
fi
readonly SQL_FILE

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
OUT_FILE="$SUMMARY_DIR/$REPORT_STEM-$DATESTAMP.md"

run_summary() {
  case "$SUMMARY_BACKEND" in
    compose)
      # The summary is a Pattern-B concern, so the single-host compose project
      # and its .env live in deploy/compose-tailnet by default.
      local compose_dir
      compose_dir="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-tailnet" && pwd)}"
      cd "$compose_dir"

      # `ps` and `exec` select a running project without interpolating its
      # service variables, so compose-local can still work here without a
      # .env. When one exists, name and source the same file so Pattern B's
      # COMPOSE_FILE + COMPOSE_PROJECT_NAME select the intended stack.
      local -a compose_cmd=(docker compose)

      # Load .env for the selected database name and Compose project identity.
      # Docker Compose reads the same file for interpolation; no secret needs
      # to remain exported by this wrapper. SUMMARY_TARGET is already resolved
      # into the readonly tuple above, so a same-named project variable cannot
      # switch halves after validation.
      if [[ -f .env ]]; then
        compose_cmd+=(--env-file .env)
        # An inherited COMPOSE_PROJECT_NAME (the documented override above)
        # must beat the .env's pinned value — compose's own env-beats-.env
        # precedence — so preserve it across the source.
        local inherited_project_set="${COMPOSE_PROJECT_NAME+x}"
        local inherited_project="${COMPOSE_PROJECT_NAME-}"
        local pinned_summary_target="$SUMMARY_TARGET"
        # shellcheck disable=SC1091
        . .env
        SUMMARY_TARGET="$pinned_summary_target"
        if [[ -n "$inherited_project_set" ]]; then
          export COMPOSE_PROJECT_NAME="$inherited_project"
        fi
        export -n OPENBRAIN_APP_PASSWORD OPENBRAIN_LOGS_ROLLUP_PASSWORD \
          LOG_SINK_SUPERUSER_PASSWORD OPENBRAIN_INGESTER_PASSWORD \
          OPENBRAIN_MONITOR_PASSWORD POSTGRES_PASSWORD SUMMARY_TARGET \
          2>/dev/null || true
      fi

      # Reconcile a custom database name loaded from the Compose .env while the
      # target keeps the service, role, and SQL identity fixed.
      TARGET_DB="${!TARGET_DB_ENV:-$TARGET_DB_DEFAULT}"

      if ! "${compose_cmd[@]}" ps --status=running "$TARGET_SERVICE" |
           grep -q "$TARGET_SERVICE"; then
        echo "[funnel_daily_summary] $TARGET_SERVICE container not running; aborting" >&2
        return 1
      fi

      # Read the already-scoped service credential inside the selected database
      # container so no password appears in host argv. The sink requires SCRAM
      # on its socket; the corpus call still uses the app identity even where a
      # stock local HBA happens to trust container-local connections.
      if [[ "$TARGET_SERVICE" == "log-sink" ]]; then
        # The inner shell expands these values after Compose enters the container.
        # shellcheck disable=SC2016
        cat -- "$SQL_FILE" | "${compose_cmd[@]}" exec -T log-sink \
          sh -eu -c \
          'PGPASSWORD="$OPENBRAIN_LOGS_ROLLUP_PASSWORD" exec psql -X -w -v ON_ERROR_STOP=1 -h /var/run/postgresql -U "$1" -d "$2" -f -' \
          funnel-summary "$TARGET_ROLE" "$TARGET_DB" || return 1
      else
        # The inner shell expands these values after Compose enters the container.
        # shellcheck disable=SC2016
        cat -- "$SQL_FILE" | "${compose_cmd[@]}" exec -T postgres \
          sh -eu -c \
          'PGPASSWORD="$OPENBRAIN_APP_PASSWORD" exec psql -X -w -v ON_ERROR_STOP=1 -h /var/run/postgresql -U "$1" -d "$2" -f -' \
          auth-events-summary "$TARGET_ROLE" "$TARGET_DB" || return 1
      fi
      ;;

    postgres)
      if [[ -z "${DB_HOST:-}" ]]; then
        echo "[funnel_daily_summary] DB_HOST is required for SUMMARY_BACKEND=postgres" >&2
        return 2
      fi
      if [[ -z "$TARGET_PASSWORD" ]]; then
        echo "[funnel_daily_summary] $TARGET_PASSWORD_NAME is required for target=$SUMMARY_TARGET with SUMMARY_BACKEND=postgres" >&2
        return 2
      fi

      if [[ "$SUMMARY_TARGET" == "sink" && "$DB_HOST" != /* ]]; then
        echo "[funnel_daily_summary] target=sink requires an absolute unix-socket DB_HOST" >&2
        return 2
      fi
      if [[ "$SUMMARY_TARGET" == "corpus" && "$DB_HOST" == /* ]]; then
        echo "[funnel_daily_summary] target=corpus requires a non-socket DB_HOST" >&2
        return 2
      fi

      local psql_bin="${PSQL_BIN:-psql}"
      if ! command -v -- "$psql_bin" >/dev/null 2>&1; then
        echo "[funnel_daily_summary] psql client not found: $psql_bin" >&2
        return 1
      fi

      # -X ignores a user .psqlrc that could change report formatting; -w
      # forbids an unattended password prompt. The source variable remains
      # unexported; only command-scoped PGPASSWORD reaches this client.
      #
      # libpq treats an absolute DB_HOST as a unix-socket directory. The target
      # checks above require that transport for the sink and reject it for the
      # corpus, preventing a stale env from crossing the two halves.
      cat -- "$SQL_FILE" | \
      PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}" \
      PGPASSWORD="$TARGET_PASSWORD" \
        "$psql_bin" -X -w \
        -h "$DB_HOST" -p "${DB_PORT:-5432}" \
        -U "$TARGET_ROLE" -d "$TARGET_DB" \
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
# The selected target fixes the least-privilege role and SQL together. Compose
# retrieves that role's password from the selected database container without
# placing it in host argv; the postgres backend sends the dedicated shell-local
# password to host psql. Neither path uses a database superuser.
#
# The summary SQL is purely INSERT/DELETE/SELECT, no schema mods, and all of
# those operations are covered by openbrain_app's grants in
# 02-observability.sql (and, on the sink, by openbrain_logs_rollup's in
# db/log-sink/01-log-sink.sql).
TMP_FILE="$(mktemp "$SUMMARY_DIR/.$REPORT_STEM-$DATESTAMP.XXXXXX")"
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
# should ignore both target-specific hidden staging prefixes; a hard kill
# cannot run the EXIT trap.
mv -f -- "$TMP_FILE" "$OUT_FILE"
TMP_FILE=""
trap - EXIT

echo
echo "[funnel_daily_summary] complete: $OUT_FILE"
