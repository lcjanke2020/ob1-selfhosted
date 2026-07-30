#!/usr/bin/env bash
# Funnel monitor — v4 (auth-failure burst notifications).
# Alert-only; runs every 5 min via funnel-monitor.timer on the ingress qube.
# Install: copy to ~/funnel_monitor.sh — see deploy/qubes/ingress-qube/README.md.
#
# v4 keeps v3's fail-loud SELECT-only database probes, and adds an opt-in,
# privacy-safe Pushover leg for bursts of HTTP 401 responses at the public
# Funnel door. It advances a monotonic row-id cursor with the pending count
# before attempting delivery: a crash or failed send can repeat a rollup, but
# cannot silently discard already-observed failures. Alert bodies contain only
# a generic operator label and an aggregate count.
set -uo pipefail
umask 077

# A caller may have exported the database credential. Keep it available as a
# shell variable, but strip the export before stat/date/curl or any other child
# process can inherit it. The same guard runs after the env file is sourced.
export -n OPENBRAIN_MONITOR_PASSWORD 2>/dev/null || true

LOG="$HOME/funnel_monitor.log"
ERRLOG="$HOME/funnel_monitor.err"
ENV_FILE="${FUNNEL_MONITOR_ENV_FILE:-$HOME/.config/funnel-monitor.env}"
STATE_DIR="$HOME/.local/state/funnel-monitor"
STATE_FILE="$STATE_DIR/state" # "<last-funnel-row-id> <last-push-epoch> <pending-auth-failures>"
PUSHOVER_CONF_DIR="$HOME/.config/funnel-monitor"
PUSHOVER_TOKEN_FILE="$PUSHOVER_CONF_DIR/pushover-token"
PUSHOVER_USER_FILE="$PUSHOVER_CONF_DIR/pushover-user"
PUSHOVER_API_URL="https://api.pushover.net/1/messages.json"

ts=$(date -Iseconds)

local_alert() {
  echo "[$ts] !!! ALERT: $*" >> "$LOG"
}

private_file_ok() {
  # $1=file, $2=human label. Exact 0600 is deliberate for provider tokens;
  # the env/state callers perform their slightly broader checks separately.
  local file="$1" label="$2" mode
  if [[ ! -f "$file" || -L "$file" || ! -O "$file" || ! -r "$file" || ! -s "$file" ]]; then
    local_alert "$label must be a non-empty, readable, current-user-owned regular file (not a symlink): $file"
    return 1
  fi
  mode=$(stat -c '%a' -- "$file") || {
    local_alert "could not inspect $label permissions: $file"
    return 1
  }
  if [[ "$mode" != "600" ]]; then
    local_alert "$label must be mode 0600: $file (mode $mode)"
    return 1
  fi
}

if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" || ! -O "$ENV_FILE" || ! -r "$ENV_FILE" ]]; then
  local_alert "monitor env must be a readable, current-user-owned regular file (not a symlink): $ENV_FILE"
  exit 1
fi
env_mode=$(stat -c '%a' -- "$ENV_FILE") || {
  local_alert "could not inspect monitor env permissions: $ENV_FILE"
  exit 1
}
if [[ ! "$env_mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$env_mode & 077) != 0 )); then
  local_alert "monitor env must have no group/other permissions: $ENV_FILE (mode $env_mode)"
  exit 1
fi

# shellcheck disable=SC1090
if ! . "$ENV_FILE"; then
  local_alert "monitor env could not be loaded: $ENV_FILE"
  exit 1
fi
export -n OPENBRAIN_MONITOR_PASSWORD 2>/dev/null || true

# Fail loud on a broken env file, with the actual problem named (a missing
# var would otherwise surface as the generic probe-failure alert).
for req in DB_HOST OPENBRAIN_MONITOR_PASSWORD; do
  if [[ -z "${!req:-}" ]]; then
    local_alert "$req missing/empty in $ENV_FILE"
    exit 1
  fi
done

VOLUME_THRESHOLD="${VOLUME_THRESHOLD:-200}"
AUTH_FAILURE_BURST_THRESHOLD="${AUTH_FAILURE_BURST_THRESHOLD:-5}"
PUSHOVER_ROLLUP_SECONDS="${PUSHOVER_ROLLUP_SECONDS:-1800}"
PUSHOVER_ENABLED="${PUSHOVER_ENABLED:-0}"
OB1_MONITOR_LABEL="${OB1_MONITOR_LABEL:-ob1}"

# A malformed threshold must not silently disable an alarm: bash integer
# comparisons can reject syntactically numeric values outside their range.
# Alert locally and use the documented default instead.
if ! [[ "$VOLUME_THRESHOLD" =~ ^(0|[1-9][0-9]{0,8})$ ]]; then
  local_alert "invalid VOLUME_THRESHOLD='$VOLUME_THRESHOLD' (need a 1-9 digit integer) in $ENV_FILE — using 200"
  VOLUME_THRESHOLD=200
fi
if ! [[ "$AUTH_FAILURE_BURST_THRESHOLD" =~ ^[1-9][0-9]{0,8}$ ]]; then
  local_alert "invalid AUTH_FAILURE_BURST_THRESHOLD='$AUTH_FAILURE_BURST_THRESHOLD' (need an integer from 1 to 999999999) in $ENV_FILE — using 5"
  AUTH_FAILURE_BURST_THRESHOLD=5
fi
if ! [[ "$PUSHOVER_ROLLUP_SECONDS" =~ ^[1-9][0-9]{1,5}$ ]] ||
   (( PUSHOVER_ROLLUP_SECONDS < 60 || PUSHOVER_ROLLUP_SECONDS > 604800 )); then
  local_alert "invalid PUSHOVER_ROLLUP_SECONDS='$PUSHOVER_ROLLUP_SECONDS' (need 60..604800) in $ENV_FILE — using 1800"
  PUSHOVER_ROLLUP_SECONDS=1800
fi
if [[ "$PUSHOVER_ENABLED" != "0" && "$PUSHOVER_ENABLED" != "1" ]]; then
  local_alert "invalid PUSHOVER_ENABLED='$PUSHOVER_ENABLED' (expected 0 or 1) in $ENV_FILE"
  exit 1
fi
# Restrict the provider-visible label to a short, non-identifying token and
# exclude whitespace/control characters that could forge a multiline body.
if ! [[ "$OB1_MONITOR_LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]]; then
  local_alert "invalid OB1_MONITOR_LABEL (need 1-32 letters, digits, '_' or '-'); using ob1"
  OB1_MONITOR_LABEL=ob1
fi

if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  if [[ ! -d "$STATE_DIR" || -L "$STATE_DIR" || ! -O "$STATE_DIR" ]]; then
    local_alert "monitor state path must be a current-user-owned directory (not a symlink): $STATE_DIR"
    exit 1
  fi
else
  mkdir -p -m 0700 -- "$STATE_DIR" || {
    local_alert "could not create monitor state directory: $STATE_DIR"
    exit 1
  }
fi
state_dir_mode=$(stat -c '%a' -- "$STATE_DIR") || {
  local_alert "could not inspect monitor state directory permissions: $STATE_DIR"
  exit 1
}
if [[ ! "$state_dir_mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$state_dir_mode & 077) != 0 )); then
  local_alert "monitor state directory must have no group/other permissions: $STATE_DIR (mode $state_dir_mode)"
  exit 1
fi

last_funnel_id=""
last_push_epoch=0
pending_auth_failures=0
if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
  if [[ ! -f "$STATE_FILE" || -L "$STATE_FILE" || ! -O "$STATE_FILE" || ! -r "$STATE_FILE" ]]; then
    local_alert "monitor state must be a readable, current-user-owned regular file (not a symlink): $STATE_FILE"
    exit 1
  fi
  state_mode=$(stat -c '%a' -- "$STATE_FILE") || {
    local_alert "could not inspect monitor state permissions: $STATE_FILE"
    exit 1
  }
  if [[ ! "$state_mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$state_mode & 077) != 0 )); then
    local_alert "monitor state must have no group/other permissions: $STATE_FILE (mode $state_mode)"
    exit 1
  fi
  state_value=$(<"$STATE_FILE")
  canonical_integer='(0|[1-9][0-9]{0,17})'
  state_pattern="^${canonical_integer} ${canonical_integer} ${canonical_integer}$"
  if ! [[ "$state_value" =~ $state_pattern ]]; then
    local_alert "monitor state is malformed; refusing to advance it: $STATE_FILE"
    exit 1
  fi
  last_funnel_id="${BASH_REMATCH[1]}"
  last_push_epoch="${BASH_REMATCH[2]}"
  pending_auth_failures="${BASH_REMATCH[3]}"
fi

q() { # scalar query -> stdout; empty on failure (stderr -> ERRLOG)
  # PGCONNECT_TIMEOUT bounds the handshake; statement_timeout bounds a hung
  # backend after connect — without it a stuck query outlives the 5-min timer.
  PGCONNECT_TIMEOUT=5 PGOPTIONS='-c statement_timeout=15s' \
  PGPASSWORD="$OPENBRAIN_MONITOR_PASSWORD" \
  psql -X -w -h "$DB_HOST" -p "${DB_PORT:-5432}" -U openbrain_monitor \
       -d "${POSTGRES_DB:-openbrain}" -tA -v ON_ERROR_STOP=1 -c "$1" 2>>"$ERRLOG"
}

write_state() { # $1=last row id, $2=last push epoch, $3=pending count
  local tmp
  tmp=$(mktemp "$STATE_DIR/.state.XXXXXX") || return 1
  if ! printf '%s %s %s\n' "$1" "$2" "$3" > "$tmp" ||
     ! chmod 0600 -- "$tmp" ||
     ! mv -f -- "$tmp" "$STATE_FILE"; then
    rm -f -- "$tmp"
    return 1
  fi
}

send_pushover() { # $1=aggregate auth-failure count
  private_file_ok "$PUSHOVER_TOKEN_FILE" "Pushover application token" || return 1
  private_file_ok "$PUSHOVER_USER_FILE" "Pushover user key" || return 1
  if ! command -v curl >/dev/null 2>&1; then
    local_alert "curl is required for Pushover delivery"
    return 1
  fi

  # File-backed form fields keep both secrets out of argv. The fixed endpoint
  # is intentionally not configurable: a writable env file must not be able
  # to redirect provider credentials to another host.
  curl -q -fsS --max-time 20 --proto '=https' "$PUSHOVER_API_URL" \
    --form "token=<$PUSHOVER_TOKEN_FILE" \
    --form "user=<$PUSHOVER_USER_FILE" \
    --form-string "title=OB1 funnel anomaly" \
    --form-string "message=$OB1_MONITOR_LABEL: auth-failure burst — funnel-401-rows=$1 since the previous notification. No request data included." \
    --form-string "priority=1" >/dev/null
}

volume=$(q "SELECT COUNT(*) FROM funnel_access_log WHERE socket='funnel' AND ts > now() - interval '5 minutes';" | tr -d '[:space:]')

# Bound the scan by the largest visible row id, then advance to that id only
# after the count is safely in local state. IDs follow ingestion order, so a
# delayed Caddy log row is still observed even when its request timestamp is
# older than the preceding five-minute wall-clock window. This cursor relies
# on the shipped log ingester's explicit single-process, serial awaited-insert
# loop; if that writer becomes concurrent, its commit-order contract and this
# cursor must be changed together.
if [[ -z "$last_funnel_id" ]]; then
  auth_sql="WITH bounds AS MATERIALIZED (
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
  FROM bounds;"
else
  auth_sql="WITH bounds AS MATERIALIZED (
    SELECT COALESCE(MAX(id), 0)::bigint AS max_id,
           FLOOR(EXTRACT(EPOCH FROM now()))::bigint AS cutoff_epoch
    FROM funnel_access_log
  )
  SELECT max_id || '|' || cutoff_epoch || '|' ||
         (SELECT COUNT(*) FROM funnel_access_log AS event
          WHERE event.id > $last_funnel_id
            AND event.id <= bounds.max_id
            AND event.socket = 'funnel'
            AND event.status = 401)
  FROM bounds;"
fi
auth_result=$(q "$auth_sql" | tr -d '[:space:]')

new_funnel_id=""
cutoff_epoch=""
auth_failures=""
extra=""
IFS='|' read -r new_funnel_id cutoff_epoch auth_failures extra <<< "$auth_result"

echo "[$ts] vol=${volume:-?} auth_failures=${auth_failures:-?}" >> "$LOG"

re='^(0|[1-9][0-9]{0,17})$'
alert=0
reason=""
if ! [[ "$volume" =~ $re ]]; then
  alert=1
  reason="monitor probe FAILED (volume='${volume:-empty}') — db qube unreachable or role/creds broken; see $ERRLOG"
elif (( volume > VOLUME_THRESHOLD )); then
  alert=1
  reason="funnel volume>$VOLUME_THRESHOLD in 5min ($volume)"
fi
if [[ -n "$extra" ]] ||
   ! [[ "$new_funnel_id" =~ ^(0|[1-9][0-9]{0,17})$ ]] ||
   ! [[ "$cutoff_epoch" =~ ^(0|[1-9][0-9]{0,17})$ ]] ||
   ! [[ "$auth_failures" =~ ^(0|[1-9][0-9]{0,17})$ ]]; then
  alert=1
  reason="${reason:+$reason; }monitor probe FAILED (auth_failures='${auth_result:-empty}')"
elif [[ -n "$last_funnel_id" && "$new_funnel_id" != "0" ]] &&
     (( new_funnel_id < last_funnel_id )); then
  # An empty retained table legitimately reports max(id)=0, so keep the old
  # cursor. A lower non-zero max indicates a restore/reset; advancing would
  # permanently skip rows until the sequence caught up.
  alert=1
  reason="${reason:+$reason; }monitor probe FAILED (funnel row id moved backwards; inspect/reset $STATE_FILE)"
  auth_failures=""
elif (( auth_failures >= AUTH_FAILURE_BURST_THRESHOLD )); then
  alert=1
  reason="${reason:+$reason; }auth_failure_burst=$auth_failures since prior successful probe (threshold=$AUTH_FAILURE_BURST_THRESHOLD)"
fi

if (( alert == 1 )); then
  local_alert "$reason"
  echo "[$ts] !!! Manual remediation (if needed): sudo tailscale funnel --https=443 off" >> "$LOG"
fi

# A malformed/failed auth probe never advances the cursor or notification
# state. The volume probe remains independently visible in the local log.
if [[ -z "$auth_failures" ]]; then
  exit 1
fi

if [[ -n "$last_funnel_id" && "$new_funnel_id" == "0" ]]; then
  new_funnel_id="$last_funnel_id"
fi
if (( cutoff_epoch < last_push_epoch )); then
  local_alert "database clock moved behind the last Pushover timestamp; refusing to advance notification state"
  exit 1
fi

if [[ "$PUSHOVER_ENABLED" == "1" ]] &&
   (( auth_failures >= AUTH_FAILURE_BURST_THRESHOLD )); then
  if (( pending_auth_failures > 999999999999999999 - auth_failures )); then
    local_alert "pending auth-failure count would overflow; refusing to advance notification state"
    exit 1
  fi
  pending_auth_failures=$((pending_auth_failures + auth_failures))
elif [[ "$PUSHOVER_ENABLED" == "0" ]]; then
  # Enabling notifications later starts with future events, not an unexpected
  # push for activity observed while delivery was explicitly disabled.
  last_push_epoch=0
  pending_auth_failures=0
fi

# Commit cursor + pending count before any provider call. A failed send keeps
# the count for the next timer run; a crash after provider acceptance may
# duplicate one aggregate notification, which is safer than losing it.
if ! write_state "$new_funnel_id" "$last_push_epoch" "$pending_auth_failures"; then
  local_alert "could not atomically persist monitor state; Pushover send suppressed"
  exit 1
fi

if [[ "$PUSHOVER_ENABLED" == "1" ]] &&
   (( pending_auth_failures > 0 )) &&
   (( last_push_epoch == 0 || cutoff_epoch - last_push_epoch >= PUSHOVER_ROLLUP_SECONDS )); then
  if send_pushover "$pending_auth_failures"; then
    delivered_count="$pending_auth_failures"
    if ! write_state "$new_funnel_id" "$cutoff_epoch" 0; then
      # At-least-once delivery: leave the older pending state intact if the
      # post-send commit fails, so the next run may repeat rather than lose it.
      local_alert "Pushover accepted auth-failure rollup=$delivered_count, but state reset failed; notification may repeat"
      exit 1
    fi
    echo "[$ts] Pushover sent: auth_failure_rollup=$delivered_count" >> "$LOG"
  else
    local_alert "Pushover send failed; pending auth-failure count retained"
    exit 1
  fi
fi
