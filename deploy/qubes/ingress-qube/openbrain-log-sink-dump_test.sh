#!/usr/bin/env bash
# Prove the Qubes RPC producer accepts only its fixed service/caller and emits
# only the fixed summary dump. A patched copy points /usr/bin/docker at a stub;
# the production script retains its absolute runtime path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HANDLER_SOURCE="$HERE/openbrain-log-sink-dump.sh"

if [[ -n "${TMPDIR:-}" ]]; then
	TEST_TMP_BASE="$TMPDIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
	TEST_TMP_BASE="$RUNNER_TEMP"
else
	TEST_TMP_BASE="/tmp/${USER:-ob1-qrexec-handler-test}"
	install -d -m 0700 "$TEST_TMP_BASE"
fi
TEST_ROOT="$(mktemp -d "$TEST_TMP_BASE/ob1-qrexec-handler-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

BIN="$TEST_ROOT/bin"
COMPOSE_DIR="$TEST_ROOT/compose"
HANDLER="$TEST_ROOT/openbrain-log-sink-dump.sh"
DOCKER_LOG="$TEST_ROOT/docker.log"
mkdir -p "$BIN" "$COMPOSE_DIR"
touch "$COMPOSE_DIR/.env" "$COMPOSE_DIR/docker-compose.yml" "$DOCKER_LOG"

cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
: "${TEST_DOCKER_LOG:?}"
printf '%s\n' "$@" >> "$TEST_DOCKER_LOG"
if IFS= read -r -t 0.1 unexpected; then
	echo "docker stub received qrexec caller stdin: $unexpected" >&2
	exit 91
fi
[[ "${TEST_DOCKER_MODE:-success}" == success ]] || exit 72
printf '%s' "${TEST_DUMP_PAYLOAD:?}"
EOF
chmod +x "$BIN/docker"

# This is deliberately a test-only copy: caller, compose directory, and the
# absolute Docker path are operator-installed constants in production.
sed \
	-e 's|EXPECTED_CALLER="<app-qube>"|EXPECTED_CALLER="app-test"|' \
	-e "s|COMPOSE_DIR=\"<ingress-compose-dir>\"|COMPOSE_DIR=\"$COMPOSE_DIR\"|" \
	-e "s|/usr/bin/docker|$BIN/docker|g" \
	"$HANDLER_SOURCE" > "$HANDLER"
chmod +x "$HANDLER"

export TEST_DOCKER_LOG="$DOCKER_LOG"
export TEST_DUMP_PAYLOAD='PGDMP-summary-only'
export TEST_DOCKER_MODE=success

failures=0
assert_eq() {
	local expected=$1 actual=$2 message=$3
	if [[ "$expected" != "$actual" ]]; then
		echo "FAIL: $message (expected '$expected', got '$actual')" >&2
		failures=$((failures + 1))
	fi
}
assert_contains() {
	local path=$1 needle=$2 message=$3
	if ! grep -Fq -- "$needle" "$path"; then
		echo "FAIL: $message (missing '$needle' in $path)" >&2
		failures=$((failures + 1))
	fi
}

run_handler() {
	QREXEC_SERVICE_FULL_NAME='openbrain.LogSinkDump+' \
	QREXEC_REMOTE_DOMAIN=app-test "$HANDLER"
}
expect_rejected() {
	local label=$1 expected=$2
	shift 2
	local calls_before rc
	calls_before=$(wc -l < "$DOCKER_LOG" | tr -d ' ')
	set +e
	"$@" > "$TEST_ROOT/$label.stdout" 2> "$TEST_ROOT/$label.stderr"
	rc=$?
	set -e
	if (( rc == 0 )); then
		echo "FAIL: $label unexpectedly succeeded" >&2
		failures=$((failures + 1))
	fi
	assert_contains "$TEST_ROOT/$label.stderr" "$expected" "$label diagnostic"
	assert_eq "$calls_before" "$(wc -l < "$DOCKER_LOG" | tr -d ' ')" \
		"$label rejected before Docker"
}

# Caller stdin is discarded before the fixed Docker invocation. Only pg_dump's
# stdout reaches the app-side consumer.
printf 'attacker-controlled input\n' | run_handler \
	> "$TEST_ROOT/success.stdout" 2> "$TEST_ROOT/success.stderr"
assert_eq "$TEST_DUMP_PAYLOAD" "$(cat "$TEST_ROOT/success.stdout")" \
	"handler stdout contains only dump bytes"
assert_eq '' "$(cat "$TEST_ROOT/success.stderr")" "successful handler stderr"
assert_contains "$DOCKER_LOG" "--project-directory" "fixed Compose invocation"
assert_contains "$DOCKER_LOG" "$COMPOSE_DIR" "fixed Compose directory"
assert_contains "$DOCKER_LOG" "exec" "fixed exec subcommand"
assert_contains "$DOCKER_LOG" "-T" "noninteractive Docker exec"
assert_contains "$DOCKER_LOG" "log-sink" "fixed service name"
assert_contains "$DOCKER_LOG" "openbrain_logs_backup" "dedicated backup identity"
assert_contains "$DOCKER_LOG" "--table=public.funnel_access_summary" \
	"summary-only pg_dump selector"
assert_contains "$DOCKER_LOG" "--compress=none" "uncompressed bounded archive"
assert_contains "$DOCKER_LOG" "--strict-names" "missing-table refusal"

expect_rejected wrong-caller "caller is not" \
	env QREXEC_SERVICE_FULL_NAME='openbrain.LogSinkDump+' \
		QREXEC_REMOTE_DOMAIN=other-qube "$HANDLER"
expect_rejected wrong-service "unexpected service identity" \
	env QREXEC_SERVICE_FULL_NAME='openbrain.Other+' \
		QREXEC_REMOTE_DOMAIN=app-test "$HANDLER"
expect_rejected service-argument "service arguments are not accepted" \
	env QREXEC_SERVICE_FULL_NAME='openbrain.LogSinkDump+anything' \
		QREXEC_REMOTE_DOMAIN=app-test "$HANDLER" anything
expect_rejected unconfigured-copy "install placeholders are not configured" \
	env QREXEC_SERVICE_FULL_NAME='openbrain.LogSinkDump+' \
		QREXEC_REMOTE_DOMAIN=app-test "$HANDLER_SOURCE"

# A runtime failure propagates, and no diagnostic is confused with dump bytes.
export TEST_DOCKER_MODE=fail
set +e
run_handler > "$TEST_ROOT/docker-fail.stdout" 2> "$TEST_ROOT/docker-fail.stderr"
docker_fail_rc=$?
set -e
if (( docker_fail_rc == 0 )); then
	echo "FAIL: Docker failure was hidden" >&2
	failures=$((failures + 1))
fi
assert_eq '' "$(cat "$TEST_ROOT/docker-fail.stdout")" \
	"failed handler publishes no dump bytes"

if (( failures > 0 )); then
	echo "$failures qrexec-handler test(s) failed" >&2
	exit 1
fi
echo "All Funnel qrexec handler tests passed."
