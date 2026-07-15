#!/usr/bin/env bash
# Funnel monitor — v3 (2026-06-22, post three-qube-split).
# Alert-only; runs every 5 min via funnel-monitor.timer on the ingress qube.
# Install: copy to ~/funnel_monitor.sh — see deploy/qubes/ingress-qube/README.md.
#
# WHY v3: v2.x probed via `docker exec <local-postgres-container>` — a
# container that ceased to exist when Postgres moved to the db qube. Every run
# failed silently (vol=? auth_failures=?) so the numeric alert test never
# matched and the monitor could not fire, while LOOKING healthy (timer active).
# v3 queries the db qube over the tailnet with a SELECT-only metadata role, and
# FAILS LOUD: a non-numeric/empty result is itself an ALERT.
set -uo pipefail

LOG="$HOME/funnel_monitor.log"
ERRLOG="$HOME/funnel_monitor.err"
ENV_FILE="$HOME/.config/funnel-monitor.env"   # 0600
VOLUME_THRESHOLD="${VOLUME_THRESHOLD:-200}"   # env-file override wins (loaded below)

ts=$(date -Iseconds)

if [ ! -r "$ENV_FILE" ]; then
  echo "[$ts] !!! ALERT: monitor env $ENV_FILE missing/unreadable" >> "$LOG"; exit 0
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# Fail loud on a broken env file, with the actual problem named (a missing
# var would otherwise surface as the generic probe-failure alert).
for req in DB_HOST OPENBRAIN_MONITOR_PASSWORD; do
  if [ -z "${!req:-}" ]; then
    echo "[$ts] !!! ALERT: $req missing/empty in $ENV_FILE" >> "$LOG"; exit 0
  fi
done
# A malformed threshold must not silently disable the volume alarm: the
# bash integer comparison below would error to stderr (the journal, not our
# log) and leave alert=0. Alert and fall back to the default instead.
if ! [[ "$VOLUME_THRESHOLD" =~ ^[0-9]+$ ]]; then
  echo "[$ts] !!! ALERT: invalid VOLUME_THRESHOLD='$VOLUME_THRESHOLD' in $ENV_FILE — using 200" >> "$LOG"
  VOLUME_THRESHOLD=200
fi

q() {  # scalar query -> stdout; empty on failure (stderr -> ERRLOG)
  # PGCONNECT_TIMEOUT bounds the handshake; statement_timeout bounds a hung
  # backend after connect — without it a stuck query outlives the 5-min timer.
  PGCONNECT_TIMEOUT=5 PGOPTIONS='-c statement_timeout=15s' \
  PGPASSWORD="$OPENBRAIN_MONITOR_PASSWORD" \
  psql -w -h "$DB_HOST" -p "${DB_PORT:-5432}" -U openbrain_monitor \
       -d "${POSTGRES_DB:-openbrain}" -tA -c "$1" 2>>"$ERRLOG"
}

volume=$(q "SELECT COUNT(*) FROM funnel_access_log WHERE socket='funnel' AND ts > now() - interval '5 minutes';" | tr -d '[:space:]')
auth_failures=$(q "SELECT COUNT(*) FROM mcp_auth_events WHERE ts > now() - interval '5 minutes' AND reason <> 'missing_credentials';" | tr -d '[:space:]')

echo "[$ts] vol=${volume:-?} auth_failures=${auth_failures:-?}" >> "$LOG"

re='^[0-9]+$'
alert=0; reason=""
if ! [[ "$volume" =~ $re ]]; then
  alert=1; reason="monitor probe FAILED (volume='${volume:-empty}') — db qube unreachable or role/creds broken; see $ERRLOG"
elif [ "$volume" -gt "$VOLUME_THRESHOLD" ]; then
  alert=1; reason="funnel volume>$VOLUME_THRESHOLD in 5min ($volume)"
fi
if ! [[ "$auth_failures" =~ $re ]]; then
  alert=1; reason="${reason:+$reason; }monitor probe FAILED (auth_failures='${auth_failures:-empty}')"
elif [ "$auth_failures" -gt 0 ]; then
  alert=1; reason="${reason:+$reason; }auth_failures=$auth_failures in 5min"
fi

if [ "$alert" -eq 1 ]; then
  echo "[$ts] !!! ALERT: $reason" >> "$LOG"
  echo "[$ts] !!! Manual remediation (if needed): sudo tailscale funnel --https=443 off" >> "$LOG"
fi
