#!/usr/bin/env bash
# Deterministic regression coverage for scripts/funnel_monitor.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/funnel_monitor.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/funnel-monitor-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

BIN_DIR="$TEST_ROOT/bin"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$PATH"
export TEST_PSQL_LOG="$TEST_ROOT/psql.log"
export TEST_CURL_LOG="$TEST_ROOT/curl.log"
: > "$TEST_PSQL_LOG"
: > "$TEST_CURL_LOG"

cat > "$BIN_DIR/psql" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${OPENBRAIN_MONITOR_PASSWORD+x}" ]]; then
  echo "OPENBRAIN_MONITOR_PASSWORD leaked to psql" >&2
  exit 97
fi
sql=""
while (( $# > 0 )); do
  if [[ "$1" == "-c" && $# -ge 2 ]]; then
    sql="$2"
    break
  fi
  shift
done
printf '%s\n--END--\n' "$sql" >> "$TEST_PSQL_LOG"
if [[ "$sql" == *"WITH bounds AS MATERIALIZED"* ]]; then
  if [[ -n "${TEST_AUTH_STARTED_FILE:-}" ]]; then
    : > "$TEST_AUTH_STARTED_FILE"
  fi
  if [[ -n "${TEST_AUTH_BLOCK_FILE:-}" ]]; then
    while [[ -e "$TEST_AUTH_BLOCK_FILE" ]]; do
      sleep 0.02
    done
  fi
  if [[ -n "${TEST_AUTH_RESULT+x}" ]]; then
    printf '%s\n' "$TEST_AUTH_RESULT"
  else
    printf '%s|%s|%s\n' "$TEST_MAX_ID" "$TEST_CUTOFF_EPOCH" "$TEST_AUTH_FAILURES"
  fi
elif [[ "$sql" == *"SELECT COUNT(*) FROM funnel_access_log"* ]]; then
  printf '%s\n' "$TEST_VOLUME"
else
  echo "unexpected psql query" >&2
  exit 98
fi
STUB

cat > "$BIN_DIR/curl" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
if [[ -n "${OPENBRAIN_MONITOR_PASSWORD+x}" ]]; then
  echo "OPENBRAIN_MONITOR_PASSWORD leaked to curl" >&2
  exit 97
fi
{
  echo "CALL"
  printf 'ARG:<%s>\n' "$@"
} >> "$TEST_CURL_LOG"
exit "${TEST_CURL_EXIT:-0}"
STUB
chmod 0755 "$BIN_DIR/psql" "$BIN_DIR/curl"

fail() {
  echo "funnel_monitor_test: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1" actual="$2" context="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$context: expected '$expected', got '$actual'"
}

assert_contains() {
  local file="$1" needle="$2" context="$3"
  grep -Fq -- "$needle" "$file" ||
    fail "$context: '$needle' not found in $file"
}

assert_not_contains() {
  local file="$1" needle="$2" context="$3"
  if grep -Fq -- "$needle" "$file"; then
    fail "$context: unexpected '$needle' found in $file"
  fi
}

curl_calls() {
  grep -c '^CALL$' "$TEST_CURL_LOG" || true
}

make_home() {
  local home="$1" enabled="${2:-1}" threshold="${3:-5}"
  local db_host="${4:-$home/sink-run}"
  mkdir -p "$home/.config/funnel-monitor"
  cat > "$home/.config/funnel-monitor.env" <<EOF
DB_HOST=$db_host
DB_PORT=5432
LOG_SINK_DB=openbrain_logs
OPENBRAIN_MONITOR_PASSWORD=monitor-test-secret
VOLUME_THRESHOLD=200
PUSHOVER_ENABLED=$enabled
AUTH_FAILURE_BURST_THRESHOLD=$threshold
PUSHOVER_ROLLUP_SECONDS=1800
OB1_MONITOR_LABEL=edge
EOF
  chmod 0600 "$home/.config/funnel-monitor.env"
  if [[ "$enabled" == "1" ]]; then
    printf %s application-test-secret > "$home/.config/funnel-monitor/pushover-token"
    printf %s user-test-secret > "$home/.config/funnel-monitor/pushover-user"
    chmod 0600 "$home/.config/funnel-monitor/pushover-token" \
      "$home/.config/funnel-monitor/pushover-user"
  fi
}

run_monitor() {
  local expected_rc="$1" home="$2" rc
  set +e
  HOME="$home" "$MONITOR" > "$TEST_ROOT/stdout" 2> "$TEST_ROOT/stderr"
  rc=$?
  set -e
  assert_eq "$expected_rc" "$rc" "monitor exit code"
}

export TEST_VOLUME=4 TEST_CURL_EXIT=0

# A stale pre-breakout TCP target is rejected before psql gets a chance to
# reconnect the edge monitor to a corpus endpoint.
TCP_HOME="$TEST_ROOT/tcp-home"
make_home "$TCP_HOME" 0 5 db.test.invalid
tcp_psql_before=$(grep -c '^--END--$' "$TEST_PSQL_LOG" || true)
run_monitor 1 "$TCP_HOME"
tcp_psql_after=$(grep -c '^--END--$' "$TEST_PSQL_LOG" || true)
assert_eq "$tcp_psql_before" "$tcp_psql_after" "TCP target query suppression"
assert_contains "$TCP_HOME/funnel_monitor.log" \
  "DB_HOST must be an absolute unix-socket directory" "TCP target rejection"

MAIN_HOME="$TEST_ROOT/main-home"
make_home "$MAIN_HOME"

# A sub-threshold interval advances the ingestion cursor without notifying.
export TEST_MAX_ID=10 TEST_CUTOFF_EPOCH=1000 TEST_AUTH_FAILURES=4
run_monitor 0 "$MAIN_HOME"
assert_eq "10 0 0" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "sub-threshold state"
assert_eq "600" "$(stat -c '%a' "$MAIN_HOME/.local/state/funnel-monitor/lock")" \
  "state lock permissions"
assert_eq 0 "$(curl_calls)" "sub-threshold delivery count"
assert_contains "$MAIN_HOME/funnel_monitor.log" "funnel_401_rows=4" \
  "self-describing 401 log field"

# The first qualifying burst sends immediately and clears the pending count.
export TEST_MAX_ID=20 TEST_CUTOFF_EPOCH=1100 TEST_AUTH_FAILURES=6
run_monitor 0 "$MAIN_HOME"
assert_eq "20 1100 0" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "first-burst state"
assert_eq 1 "$(curl_calls)" "first-burst delivery count"
assert_contains "$TEST_CURL_LOG" "message=edge: auth-failure burst — funnel-401-rows=6" \
  "first-burst privacy-safe body"
assert_contains "$TEST_CURL_LOG" "across qualifying burst windows. No request details included." \
  "first-burst count semantics"

# Further burst intervals accumulate until the configured rollup cadence.
export TEST_MAX_ID=30 TEST_CUTOFF_EPOCH=1200 TEST_AUTH_FAILURES=7
run_monitor 0 "$MAIN_HOME"
assert_eq "30 1100 7" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "deduped pending state"
assert_eq 1 "$(curl_calls)" "deduped delivery count"

export TEST_MAX_ID=40 TEST_CUTOFF_EPOCH=2900 TEST_AUTH_FAILURES=8
run_monitor 0 "$MAIN_HOME"
assert_eq "40 2900 0" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "periodic-rollup state"
assert_eq 2 "$(curl_calls)" "periodic-rollup delivery count"
assert_contains "$TEST_CURL_LOG" "message=edge: auth-failure burst — funnel-401-rows=15" \
  "periodic aggregate body"

# Provider failure retains both the advanced cursor and aggregate for retry.
export TEST_MAX_ID=50 TEST_CUTOFF_EPOCH=4800 TEST_AUTH_FAILURES=5 TEST_CURL_EXIT=22
run_monitor 1 "$MAIN_HOME"
assert_eq "50 2900 5" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "failed-send retained state"
assert_eq 3 "$(curl_calls)" "failed-send attempt count"

export TEST_MAX_ID=60 TEST_CUTOFF_EPOCH=4900 TEST_AUTH_FAILURES=0 TEST_CURL_EXIT=0
run_monitor 0 "$MAIN_HOME"
assert_eq "60 4900 0" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "retry state"
assert_eq 4 "$(curl_calls)" "retry delivery count"

# A provider token with broad permissions is rejected before curl, while the
# observed count remains pending for a fixed configuration to deliver later.
chmod 0644 "$MAIN_HOME/.config/funnel-monitor/pushover-token"
export TEST_MAX_ID=70 TEST_CUTOFF_EPOCH=6800 TEST_AUTH_FAILURES=5
run_monitor 1 "$MAIN_HOME"
assert_eq "70 4900 5" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "unsafe-token retained state"
assert_eq 4 "$(curl_calls)" "unsafe-token curl suppression"
assert_contains "$MAIN_HOME/funnel_monitor.log" "must be mode 0600" \
  "unsafe-token local alert"

chmod 0600 "$MAIN_HOME/.config/funnel-monitor/pushover-token"
export TEST_MAX_ID=80 TEST_CUTOFF_EPOCH=6810 TEST_AUTH_FAILURES=0
run_monitor 0 "$MAIN_HOME"
assert_eq "80 6810 0" "$(<"$MAIN_HOME/.local/state/funnel-monitor/state")" \
  "fixed-token retry state"
assert_eq 5 "$(curl_calls)" "fixed-token retry count"

# Provider-visible argv contains file references and aggregate metadata only.
assert_not_contains "$TEST_CURL_LOG" "application-test-secret" "token redaction"
assert_not_contains "$TEST_CURL_LOG" "user-test-secret" "user-key redaction"
assert_not_contains "$TEST_CURL_LOG" "monitor-test-secret" "database-secret redaction"
assert_not_contains "$TEST_CURL_LOG" "db.test.invalid" "database-host redaction"
assert_contains "$TEST_CURL_LOG" "ARG:<-q>" "curl user-config suppression"
assert_contains "$TEST_CURL_LOG" "token=<$MAIN_HOME/.config/funnel-monitor/pushover-token" \
  "file-backed token form"

# The stateful probe is scoped to public-door 401 rows and advances by id;
# it does not depend on the cross-door auth-event table.
assert_contains "$TEST_PSQL_LOG" "event.id > 10" "row-id cursor query"
assert_contains "$TEST_PSQL_LOG" "event.socket = 'funnel'" "public-door filter"
assert_contains "$TEST_PSQL_LOG" "event.status = 401" "uniform-401 filter"
assert_not_contains "$TEST_PSQL_LOG" "mcp_auth_events" "cross-door table exclusion"

# Disabled delivery needs no provider credentials and never queues historical
# events for a surprise push when an operator enables it later.
DISABLED_HOME="$TEST_ROOT/disabled-home"
make_home "$DISABLED_HOME" 0
export TEST_MAX_ID=90 TEST_CUTOFF_EPOCH=7000 TEST_AUTH_FAILURES=50
run_monitor 0 "$DISABLED_HOME"
assert_eq "90 0 0" "$(<"$DISABLED_HOME/.local/state/funnel-monitor/state")" \
  "disabled delivery state"
assert_eq 5 "$(curl_calls)" "disabled delivery count"

# Invalid new thresholds fall back fail-loud to five rather than disabling
# notification. This pins the wide-integer regression fixed for v3's volume
# threshold to the new auth-failure threshold as well.
FALLBACK_HOME="$TEST_ROOT/fallback-home"
make_home "$FALLBACK_HOME" 1 999999999999999999999
export TEST_MAX_ID=100 TEST_CUTOFF_EPOCH=7100 TEST_AUTH_FAILURES=5
run_monitor 0 "$FALLBACK_HOME"
assert_eq 6 "$(curl_calls)" "invalid-threshold fallback delivery count"
assert_contains "$FALLBACK_HOME/funnel_monitor.log" \
  "invalid AUTH_FAILURE_BURST_THRESHOLD" "invalid-threshold local alert"

# A typo in the optional delivery toggle fails safe to delivery-off while the
# pre-existing volume alarm and local 401-burst alarm continue to run.
TOGGLE_HOME="$TEST_ROOT/toggle-home"
make_home "$TOGGLE_HOME" true
export TEST_VOLUME=999 TEST_MAX_ID=110 TEST_CUTOFF_EPOCH=7200 TEST_AUTH_FAILURES=5
toggle_curl_before=$(curl_calls)
run_monitor 0 "$TOGGLE_HOME"
assert_eq "$toggle_curl_before" "$(curl_calls)" "invalid-toggle curl suppression"
assert_eq "110 0 0" "$(<"$TOGGLE_HOME/.local/state/funnel-monitor/state")" \
  "invalid-toggle disabled state"
assert_contains "$TOGGLE_HOME/funnel_monitor.log" "invalid PUSHOVER_ENABLED" \
  "invalid-toggle local alert"
assert_contains "$TOGGLE_HOME/funnel_monitor.log" "funnel volume>200" \
  "invalid-toggle preserved volume alarm"
assert_contains "$TOGGLE_HOME/funnel_monitor.log" "auth_failure_burst=5" \
  "invalid-toggle preserved 401 alarm"
export TEST_VOLUME=4

# Malformed non-empty probe output must fail before cursor/pending mutation or
# provider delivery, and a later healthy result must recover without reset.
MALFORMED_HOME="$TEST_ROOT/malformed-probe-home"
make_home "$MALFORMED_HOME"
export TEST_MAX_ID=10 TEST_CUTOFF_EPOCH=1000 TEST_AUTH_FAILURES=0
run_monitor 0 "$MALFORMED_HOME"
malformed_curl_before=$(curl_calls)

export TEST_AUTH_RESULT='abc|1200|0'
run_monitor 1 "$MALFORMED_HOME"
assert_eq "10 0 0" "$(<"$MALFORMED_HOME/.local/state/funnel-monitor/state")" \
  "invalid-field state preservation"
assert_eq "$malformed_curl_before" "$(curl_calls)" "invalid-field delivery suppression"

export TEST_AUTH_RESULT='20|1200|4201100|5|0'
run_monitor 1 "$MALFORMED_HOME"
assert_eq "10 0 0" "$(<"$MALFORMED_HOME/.local/state/funnel-monitor/state")" \
  "extra-field state preservation"
assert_eq "$malformed_curl_before" "$(curl_calls)" "extra-field delivery suppression"
assert_contains "$MALFORMED_HOME/funnel_monitor.log" "monitor probe FAILED" \
  "malformed-probe local alert"

unset TEST_AUTH_RESULT
export TEST_MAX_ID=20 TEST_CUTOFF_EPOCH=1300 TEST_AUTH_FAILURES=0
run_monitor 0 "$MALFORMED_HOME"
assert_eq "20 0 0" "$(<"$MALFORMED_HOME/.local/state/funnel-monitor/state")" \
  "malformed-probe recovery state"

# A newline introduced by echo/editor save is rejected before curl. The
# aggregate remains pending and is delivered after the token file is fixed.
NEWLINE_HOME="$TEST_ROOT/newline-token-home"
make_home "$NEWLINE_HOME"
export TEST_MAX_ID=10 TEST_CUTOFF_EPOCH=1000 TEST_AUTH_FAILURES=0
run_monitor 0 "$NEWLINE_HOME"
printf '\n' >> "$NEWLINE_HOME/.config/funnel-monitor/pushover-token"
newline_curl_before=$(curl_calls)
export TEST_MAX_ID=20 TEST_CUTOFF_EPOCH=1100 TEST_AUTH_FAILURES=5
run_monitor 1 "$NEWLINE_HOME"
assert_eq "20 0 5" "$(<"$NEWLINE_HOME/.local/state/funnel-monitor/state")" \
  "newline-token retained state"
assert_eq "$newline_curl_before" "$(curl_calls)" "newline-token curl suppression"
assert_contains "$NEWLINE_HOME/funnel_monitor.log" "must not contain a newline" \
  "newline-token local alert"

printf %s application-test-secret > "$NEWLINE_HOME/.config/funnel-monitor/pushover-token"
export TEST_MAX_ID=30 TEST_CUTOFF_EPOCH=1200 TEST_AUTH_FAILURES=0
run_monitor 0 "$NEWLINE_HOME"
assert_eq "30 1200 0" "$(<"$NEWLINE_HOME/.local/state/funnel-monitor/state")" \
  "newline-token retry state"
assert_eq "$((newline_curl_before + 1))" "$(curl_calls)" \
  "newline-token retry delivery count"

# Overlapping manual/timer invocations serialize the complete cursor update.
# Without the lock, the delayed older run would overwrite cursor 30 with 20.
LOCK_HOME="$TEST_ROOT/lock-home"
make_home "$LOCK_HOME" 0
export TEST_MAX_ID=10 TEST_CUTOFF_EPOCH=1000 TEST_AUTH_FAILURES=0
run_monitor 0 "$LOCK_HOME"
block_file="$TEST_ROOT/block-auth-query"
started_file="$TEST_ROOT/auth-query-started"
: > "$block_file"
HOME="$LOCK_HOME" TEST_MAX_ID=20 TEST_CUTOFF_EPOCH=1100 TEST_AUTH_FAILURES=5 \
  TEST_AUTH_BLOCK_FILE="$block_file" TEST_AUTH_STARTED_FILE="$started_file" \
  "$MONITOR" > "$TEST_ROOT/lock-first.stdout" 2> "$TEST_ROOT/lock-first.stderr" &
first_pid=$!
for _ in {1..200}; do
  [[ -e "$started_file" ]] && break
  sleep 0.01
done
[[ -e "$started_file" ]] || fail "first overlapping invocation did not reach auth query"

HOME="$LOCK_HOME" TEST_MAX_ID=30 TEST_CUTOFF_EPOCH=1200 TEST_AUTH_FAILURES=4 \
  "$MONITOR" > "$TEST_ROOT/lock-second.stdout" 2> "$TEST_ROOT/lock-second.stderr" &
second_pid=$!
sleep 0.2
kill -0 "$second_pid" 2>/dev/null || fail "second overlapping invocation did not wait for lock"
rm -f -- "$block_file"
set +e
wait "$first_pid"
first_rc=$?
wait "$second_pid"
second_rc=$?
set -e
assert_eq 0 "$first_rc" "first overlapping invocation exit code"
assert_eq 0 "$second_rc" "second overlapping invocation exit code"
assert_eq "30 0 0" "$(<"$LOCK_HOME/.local/state/funnel-monitor/state")" \
  "serialized final state"
assert_contains "$TEST_PSQL_LOG" "event.id > 20" \
  "second overlapping invocation loaded the first cursor"

# Corrupt state fails closed before any query can interpolate its cursor.
printf '%s\n' '1;DROP 0 0' > "$DISABLED_HOME/.local/state/funnel-monitor/state"
chmod 0600 "$DISABLED_HOME/.local/state/funnel-monitor/state"
psql_before=$(grep -c '^--END--$' "$TEST_PSQL_LOG" || true)
run_monitor 1 "$DISABLED_HOME"
psql_after=$(grep -c '^--END--$' "$TEST_PSQL_LOG" || true)
assert_eq "$psql_before" "$psql_after" "malformed state query suppression"
assert_contains "$DISABLED_HOME/funnel_monitor.log" "monitor state is malformed" \
  "malformed-state local alert"

echo "funnel_monitor_test: all checks passed"
