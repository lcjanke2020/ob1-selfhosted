#!/usr/bin/env bash
# Deterministic failure-path tests for the app-initiated Funnel summary pull.
# qrexec and GPG are stubbed; timeout, flock, hashing, hard-link publication,
# byte bounds, and retention use the real host implementations.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$HERE/ob1-funnel-summary-backup.sh"
BOUNDED_STREAM="$HERE/ob1-bounded-stream.py"

if [[ -n "${TMPDIR:-}" ]]; then
	TEST_TMP_BASE="$TMPDIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
	TEST_TMP_BASE="$RUNNER_TEMP"
else
	TEST_TMP_BASE="/tmp/${USER:-ob1-funnel-backup-test}"
	install -d -m 0700 "$TEST_TMP_BASE"
fi
TEST_ROOT="$(mktemp -d "$TEST_TMP_BASE/ob1-funnel-backup-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

BIN="$TEST_ROOT/bin"
OUT="$TEST_ROOT/out"
SCRIPT_TMP="$TEST_ROOT/tmp"
ENV_FILE="$TEST_ROOT/funnel-summary-backup.env"
QREXEC_LOG="$TEST_ROOT/qrexec.log"
mkdir -p "$BIN" "$OUT" "$SCRIPT_TMP"
touch "$TEST_ROOT/backup-pubkey.asc" "$QREXEC_LOG"

cat > "$BIN/date" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "-u +%Y%m%dT%H%M%SZ" ]] || {
	echo "unexpected date arguments: $*" >&2
	exit 90
}
printf '%s\n' "${TEST_TIMESTAMP:?}"
EOF

cat > "$BIN/qrexec-client-vm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${TEST_QREXEC_LOG:?}"
if IFS= read -r -t 0.1 unexpected; then
	echo "qrexec stub received caller-controlled stdin: $unexpected" >&2
	exit 91
fi
case "${TEST_QREXEC_MODE:-success}" in
	success) printf '%s' "${TEST_DUMP_PAYLOAD:?}" ;;
	empty) ;;
	truncated) printf 'tiny' ;;
	oversized) printf 'PGDMP0123456789012345678901234567890123456789' ;;
	malformed) printf 'not-a-pg-dump!!' ;;
	denied) exit 77 ;;
	hung) exec sleep 30 ;;
	*) echo "unknown qrexec test mode: $TEST_QREXEC_MODE" >&2; exit 92 ;;
esac
EOF

cat > "$BIN/gpg" <<'EOF'
#!/usr/bin/env bash
output=""
while (( $# > 0 )); do
	case "$1" in
		--output)
			output="${2:?missing --output value}"
			shift 2
			;;
		*) shift ;;
	esac
done
[[ -n "$output" ]] || { echo "gpg stub did not receive --output" >&2; exit 93; }
if [[ "${TEST_GPG_MODE:-success}" == fail ]]; then
	cat >/dev/null
	exit 70
fi
cat > "$output"
EOF
chmod +x "$BIN/date" "$BIN/qrexec-client-vm" "$BIN/gpg"

cat > "$ENV_FILE" <<EOF
TARGET_QUBE=ingress-test
PUBKEY=$TEST_ROOT/backup-pubkey.asc
OUT_DIR=$OUT
RETAIN_DAYS=14
MIN_DUMP_BYTES=8
MAX_DUMP_BYTES=32
TIMEOUT_SECONDS=1
BOUNDED_STREAM=$BOUNDED_STREAM
EOF

export PATH="$BIN:$PATH"
export TMPDIR="$SCRIPT_TMP"
export TEST_QREXEC_LOG="$QREXEC_LOG"
export TEST_DUMP_PAYLOAD='PGDMP-custom-data'
export TEST_QREXEC_MODE=success
export TEST_GPG_MODE=success

failures=0
assert_eq() {
	local expected=$1 actual=$2 message=$3
	if [[ "$expected" != "$actual" ]]; then
		echo "FAIL: $message (expected '$expected', got '$actual')" >&2
		failures=$((failures + 1))
	fi
}
assert_exists() {
	local path=$1 message=$2
	if [[ ! -f "$path" ]]; then
		echo "FAIL: $message (missing $path)" >&2
		failures=$((failures + 1))
	fi
}
assert_missing() {
	local path=$1 message=$2
	if [[ -e "$path" || -L "$path" ]]; then
		echo "FAIL: $message (unexpected $path)" >&2
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
assert_no_staging() {
	local message=$1 count
	count=$(find "$OUT" -maxdepth 1 -type f -name '.funnel-summary-*' \
		! -name '.funnel-summary-backup.lock' | wc -l | tr -d ' ')
	assert_eq 0 "$count" "$message"
}

run_backup() {
	local config=${1:-$ENV_FILE}
	FUNNEL_SUMMARY_BACKUP_ENV_FILE="$config" "$BACKUP_SCRIPT"
}
expect_failure() {
	local label=$1 expected_text=$2
	set +e
	run_backup > "$TEST_ROOT/$label.stdout" 2> "$TEST_ROOT/$label.stderr"
	local rc=$?
	set -e
	if (( rc == 0 )); then
		echo "FAIL: $label unexpectedly succeeded" >&2
		failures=$((failures + 1))
	fi
	assert_contains "$TEST_ROOT/$label.stderr" "$expected_text" "$label diagnostic"
	assert_no_staging "$label staging cleanup"
}

# The byte-bound helper must accept both exact bounds and reject either side.
assert_eq abc "$(printf abc | "$BOUNDED_STREAM" 3 3)" \
	"bounded helper accepts exact bounds"
set +e
printf ab | "$BOUNDED_STREAM" 3 3 >/dev/null 2> "$TEST_ROOT/bounds-under.stderr"
bounds_under_rc=$?
printf abcd | "$BOUNDED_STREAM" 3 3 >/dev/null 2> "$TEST_ROOT/bounds-over.stderr"
bounds_over_rc=$?
set -e
assert_eq 66 "$bounds_under_rc" "bounded helper rejects undersize"
assert_eq 65 "$bounds_over_rc" "bounded helper rejects oversize"

# Two successful pulls in one second must publish immutable, private artifacts
# and matching digests without mutating the first publication.
export TEST_TIMESTAMP=20260822T200000Z
run_backup > "$TEST_ROOT/first.stdout"
first="$OUT/funnel-summary-20260822T200000Z.dump.gpg"
first_digest="$first.sha256"
assert_exists "$first" "first encrypted summary"
assert_exists "$first_digest" "first summary digest"
assert_eq "$TEST_DUMP_PAYLOAD" "$(cat "$first")" "first encrypted payload stub"
assert_eq 600 "$(stat -c '%a' "$first")" "first artifact mode"
assert_eq 600 "$(stat -c '%a' "$first_digest")" "first digest mode"
assert_eq "$(sha256sum "$first" | awk '{print $1}')  ${first##*/}" \
	"$(cat "$first_digest")" "first digest contents"

export TEST_DUMP_PAYLOAD='PGDMP-second-data'
run_backup > "$TEST_ROOT/second.stdout"
second="$OUT/funnel-summary-20260822T200000Z-2.dump.gpg"
assert_exists "$second" "collision-suffixed summary"
assert_exists "$second.sha256" "collision-suffixed digest"
assert_eq PGDMP-custom-data "$(cat "$first")" "first publication remains immutable"
assert_eq PGDMP-second-data "$(cat "$second")" "second publication payload"
assert_contains "$TEST_ROOT/second.stdout" "$second" "reported collision-selected path"
assert_eq "ingress-test openbrain.LogSinkDump" "$(head -n 1 "$QREXEC_LOG")" \
	"fixed qrexec target and service"
assert_no_staging "successful-run staging cleanup"

# Every hostile-source or encryptor failure must leave no final artifact and no
# hidden staging file for that timestamp.
export TEST_TIMESTAMP=20260822T200100Z TEST_QREXEC_MODE=empty
expect_failure empty "below minimum"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "empty pull publication"

export TEST_TIMESTAMP=20260822T200200Z TEST_QREXEC_MODE=truncated
expect_failure truncated "below minimum"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "truncated pull publication"

export TEST_TIMESTAMP=20260822T200300Z TEST_QREXEC_MODE=oversized
expect_failure oversized "exceeded maximum"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "oversized pull publication"

export TEST_TIMESTAMP=20260822T200400Z TEST_QREXEC_MODE=malformed
expect_failure malformed "unexpected archive signature"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "malformed pull publication"

export TEST_TIMESTAMP=20260822T200500Z TEST_QREXEC_MODE=denied
expect_failure denied "pipeline failed"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "denied pull publication"

export TEST_TIMESTAMP=20260822T200600Z TEST_QREXEC_MODE=hung
expect_failure hung "pipeline failed"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "timed-out pull publication"

export TEST_TIMESTAMP=20260822T200700Z TEST_QREXEC_MODE=success TEST_GPG_MODE=fail
export TEST_DUMP_PAYLOAD='PGDMP-encryptor-failure'
expect_failure encryptor "pipeline failed"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "encryptor failure publication"
export TEST_GPG_MODE=success

# A path occupied by a regular file cannot become the output directory. Reject
# it before qrexec so a local storage fault does not consume source work.
bad_out="$TEST_ROOT/not-a-directory"
bad_out_env="$TEST_ROOT/bad-out.env"
printf occupied > "$bad_out"
sed "s|^OUT_DIR=.*|OUT_DIR=$bad_out|" "$ENV_FILE" > "$bad_out_env"
qrexec_calls_before=$(wc -l < "$QREXEC_LOG" | tr -d ' ')
set +e
run_backup "$bad_out_env" \
	> "$TEST_ROOT/bad-out.stdout" 2> "$TEST_ROOT/bad-out.stderr"
bad_out_rc=$?
set -e
if (( bad_out_rc == 0 )); then
	echo "FAIL: invalid output directory unexpectedly succeeded" >&2
	failures=$((failures + 1))
fi
assert_contains "$TEST_ROOT/bad-out.stderr" "cannot create OUT_DIR" \
	"output-directory failure diagnostic"
assert_eq "$qrexec_calls_before" "$(wc -l < "$QREXEC_LOG" | tr -d ' ')" \
	"output-directory failure rejected before qrexec"

# A concurrent manual/timer invocation must fail before contacting the source.
qrexec_calls_before=$(wc -l < "$QREXEC_LOG" | tr -d ' ')
exec 8> "$OUT/.funnel-summary-backup.lock"
flock -n 8
export TEST_TIMESTAMP=20260822T200800Z TEST_DUMP_PAYLOAD='PGDMP-lock-guard'
set +e
run_backup > "$TEST_ROOT/locked.stdout" 2> "$TEST_ROOT/locked.stderr"
locked_rc=$?
set -e
flock -u 8
exec 8>&-
assert_eq 75 "$locked_rc" "lock contention exit code"
assert_contains "$TEST_ROOT/locked.stderr" "already running" "lock contention diagnostic"
assert_eq "$qrexec_calls_before" "$(wc -l < "$QREXEC_LOG" | tr -d ' ')" \
	"lock contention rejected before qrexec"
assert_missing "$OUT/funnel-summary-$TEST_TIMESTAMP.dump.gpg" "locked pull publication"

# Retention adopts only canonical artifact/digest names. Unknown manual files
# and hidden state remain outside automatic deletion.
old="$OUT/funnel-summary-20200101T000000Z.dump.gpg"
printf old > "$old"
printf old-digest > "$old.sha256"
manual="$OUT/funnel-summary-manual-archive.dump.gpg"
printf manual > "$manual"
touch -d '30 days ago' "$old" "$old.sha256" "$manual"
export TEST_TIMESTAMP=20260822T200900Z TEST_DUMP_PAYLOAD='PGDMP-retention-run'
run_backup > "$TEST_ROOT/retention.stdout"
assert_missing "$old" "expired canonical summary"
assert_missing "$old.sha256" "expired canonical digest"
assert_exists "$manual" "manual artifact outside retention"
assert_exists "$OUT/.funnel-summary-backup.lock" "persistent lock inode"
assert_no_staging "retention-run staging cleanup"

if (( failures > 0 )); then
	echo "$failures Funnel summary backup test(s) failed" >&2
	exit 1
fi
echo "All Funnel summary backup tests passed."
