#!/bin/bash
# Daily funnel observability summary wrapper.
#
# Run by a host-side systemd timer or cron entry (see deploy/compose-tailnet/README.md §Observability).
# Invokes db/summarize_funnel.sql against the running postgres container and
# tees the markdown output to:
#   1. stdout (so journald / cron captures it)
#   2. ${SUMMARY_DIR}/funnel-summary-YYYYMMDD.md — point SUMMARY_DIR at a
#      directory you replicate off the box (Syncthing, rsync, …) and the
#      summary trail gets a free off-host backup.
#
# Environment overrides (default in []):
#   SUMMARY_DIR       [~/openbrain-funnel-summaries]
#   COMPOSE_DIR       [deploy/compose-tailnet, resolved relative to this script]
#   COMPOSE_PROJECT   [optional, defaults to compose's auto-naming]
#
# Idempotent: re-running on the same day overwrites that day's .md file
# and re-runs the daily summary INSERT ... ON CONFLICT in postgres.
#
# Exit codes:
#   0 — summary written
#   1 — postgres container not running, or psql failed
#   2 — SUMMARY_DIR not writable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The summary is an observability (Pattern B) concern, so the compose
# project with the .env lives in deploy/compose-tailnet by default.
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/compose-tailnet" && pwd)}"
SUMMARY_DIR="${SUMMARY_DIR:-$HOME/openbrain-funnel-summaries}"

if [[ ! -d "$SUMMARY_DIR" ]]; then
  echo "[funnel_daily_summary] SUMMARY_DIR=$SUMMARY_DIR does not exist; creating" >&2
  mkdir -p "$SUMMARY_DIR" || { echo "[funnel_daily_summary] mkdir failed"; exit 2; }
fi

if [[ ! -w "$SUMMARY_DIR" ]]; then
  echo "[funnel_daily_summary] SUMMARY_DIR=$SUMMARY_DIR is not writable" >&2
  exit 2
fi

# Use yesterday's UTC date so the daily run captures a complete day.
DATESTAMP="$(date -u -d 'yesterday' +%Y%m%d)"
OUT_FILE="$SUMMARY_DIR/funnel-summary-$DATESTAMP.md"

cd "$COMPOSE_DIR"

# Load .env so $POSTGRES_DB is in scope for the `docker compose exec` call
# below. We intentionally do NOT export it globally — `set -a` is scoped to
# this block only. POSTGRES_PASSWORD is still sourced from .env (set -a
# loads every variable .env defines), but this script no longer USES it:
# We replaced the superuser+PGPASSWORD pattern with socket-trust
# auth as openbrain_app (see the exec block below). The unused variable
# sitting in this script's transient process env is harmless — it never
# crosses the docker compose exec boundary.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

# Check the postgres service is up — bail loudly if not.
if ! docker compose ps --status=running postgres | grep -q postgres; then
  echo "[funnel_daily_summary] postgres container not running; aborting" >&2
  exit 1
fi

# We feed the SQL via stdin and capture both stdout and stderr. ON_ERROR_STOP
# is set inside the SQL, so any DB-side failure surfaces as a non-zero exit
# from psql which we propagate. The `tee` retains the output in our journald
# trace too.
#
# Connect as openbrain_app (least privilege; has DML on the
# observability tables) via socket-trust auth: psql inside the postgres
# container reaches the local UNIX socket, and the upstream postgres image's
# default `pg_hba.conf` has `local all all trust` for socket connections.
# So no password is needed and the host shell doesn't have to handle one.
# This matches the pattern other in-repo container-local admin commands
# (pg_dump etc.) follow, and means the summary cron never had a
# superuser-level grant to begin with.
#
# The summary SQL is purely INSERT/DELETE/SELECT, no schema mods, and all
# of those operations are covered by openbrain_app's grants in
# 02-observability.sql.
{
  echo "[funnel_daily_summary] run started: $(date -u -Iseconds)"
  echo "[funnel_daily_summary] summary file: $OUT_FILE"
  echo
} | tee "$OUT_FILE" >/dev/null

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
echo '````text' >> "$OUT_FILE"

# psql exits non-zero on ON_ERROR_STOP triggers, propagating to `set -e`.
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U openbrain_app -d "${POSTGRES_DB:-openbrain}" \
  -f - < "$SCRIPT_DIR/../db/summarize_funnel.sql" \
  | tee -a "$OUT_FILE"

echo '````' >> "$OUT_FILE"

echo
echo "[funnel_daily_summary] complete: $OUT_FILE"
