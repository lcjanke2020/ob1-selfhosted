#!/usr/bin/env bash
# Deterministic regression test for collision-proof encrypted backup naming,
# publication, label validation, and retention. pg_dump and gpg are stubbed;
# gzip plus the real filesystem/link/find behavior remain in the path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$HERE/ob1-db-backup.sh"

if [[ -n "${TMPDIR:-}" ]]; then
	TEST_TMP_BASE="$TMPDIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
	TEST_TMP_BASE="$RUNNER_TEMP"
else
	TEST_TMP_BASE="/tmp/${USER:-ob1-backup-test}"
	install -d -m 0700 "$TEST_TMP_BASE"
fi
TEST_ROOT="$(mktemp -d "$TEST_TMP_BASE/ob1-db-backup-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

BIN="$TEST_ROOT/bin"
OUT="$TEST_ROOT/out"
SCRIPT_TMP="$TEST_ROOT/tmp"
ENV_FILE="$TEST_ROOT/backup.env"
PG_DUMP_LOG="$TEST_ROOT/pg-dump.log"
mkdir -p "$BIN" "$OUT" "$SCRIPT_TMP"
touch "$TEST_ROOT/backup-pubkey.asc" "$PG_DUMP_LOG"

cat > "$BIN/date" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "-u +%Y%m%dT%H%M%SZ" ]] || {
	echo "unexpected date arguments: $*" >&2
	exit 90
}
printf '%s\n' "${TEST_TIMESTAMP:?}"
EOF

cat > "$BIN/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf 'CALL\n' >> "${TEST_PG_DUMP_LOG:?}"
printf '%s' "${TEST_DUMP_PAYLOAD:?}"
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
[[ -n "$output" ]] || { echo "gpg stub did not receive --output" >&2; exit 91; }
cat > "$output"
EOF
chmod +x "$BIN/date" "$BIN/pg_dump" "$BIN/gpg"

cat > "$ENV_FILE" <<EOF
DB_HOST=db.test.invalid
DB_PORT=5432
POSTGRES_DB=openbrain
READONLY_ROLE=openbrain_readonly
READONLY_PASSWORD=test-only-password
PUBKEY=$TEST_ROOT/backup-pubkey.asc
OUT_DIR=$OUT
RETAIN_DAYS=14
LABEL_RETAIN_DAYS=90
EOF

export PATH="$BIN:$PATH"
export TMPDIR="$SCRIPT_TMP"
export TEST_TIMESTAMP="20260731T003300Z"
export TEST_PG_DUMP_LOG="$PG_DUMP_LOG"

failures=0
assert_eq() {
	local expected="$1" actual="$2" message="$3"
	if [[ "$expected" != "$actual" ]]; then
		echo "FAIL: $message (expected '$expected', got '$actual')" >&2
		failures=$((failures + 1))
	fi
}
assert_exists() {
	local path="$1" message="$2"
	if [[ ! -f "$path" ]]; then
		echo "FAIL: $message (missing $path)" >&2
		failures=$((failures + 1))
	fi
}
assert_missing() {
	local path="$1" message="$2"
	if [[ -e "$path" || -L "$path" ]]; then
		echo "FAIL: $message (unexpected $path)" >&2
		failures=$((failures + 1))
	fi
}
assert_contains() {
	local path="$1" needle="$2" message="$3"
	if ! grep -Fq -- "$needle" "$path"; then
		echo "FAIL: $message (missing '$needle' in $path)" >&2
		failures=$((failures + 1))
	fi
}

run_daily() {
	local payload="$1"
	env -u BACKUP_LABEL \
		BACKUP_ENV_FILE="$ENV_FILE" TEST_DUMP_PAYLOAD="$payload" \
		"$BACKUP_SCRIPT"
}
run_labelled() {
	local label="$1" payload="$2"
	BACKUP_LABEL="$label" BACKUP_ENV_FILE="$ENV_FILE" \
		TEST_DUMP_PAYLOAD="$payload" "$BACKUP_SCRIPT"
}
payload_of() {
	gzip -dc -- "$1"
}

# Force two complete runs into the exact same UTC second. Both must survive,
# and the second publication must not mutate the first inode's content.
run_daily "before-migration" > "$TEST_ROOT/first.stdout"
first="$OUT/db-20260731T003300Z.sql.gz.gpg"
assert_exists "$first" "first daily backup"
assert_eq "before-migration" "$(payload_of "$first")" "first daily payload"
assert_eq "600" "$(stat -c '%a' "$first")" "published artifact mode"

run_daily "after-migration" > "$TEST_ROOT/second.stdout"
second="$OUT/db-20260731T003300Z-2.sql.gz.gpg"
assert_exists "$first" "first backup after repeated run"
assert_exists "$second" "collision-suffixed second backup"
assert_eq "before-migration" "$(payload_of "$first")" "preserved first payload"
assert_eq "after-migration" "$(payload_of "$second")" "second daily payload"
assert_contains "$TEST_ROOT/second.stdout" "$second" "reported collision-selected path"
assert_eq "2" "$(wc -l < "$PG_DUMP_LOG" | tr -d ' ')" "two pg_dump invocations"

# Invalid labels fail before pg_dump and cannot escape into another directory.
set +e
BACKUP_LABEL="../escape" BACKUP_ENV_FILE="$ENV_FILE" \
	TEST_DUMP_PAYLOAD="must-not-run" "$BACKUP_SCRIPT" \
	> "$TEST_ROOT/invalid.stdout" 2> "$TEST_ROOT/invalid.stderr"
invalid_rc=$?
set -e
if (( invalid_rc == 0 )); then
	echo "FAIL: invalid backup label succeeded" >&2
	failures=$((failures + 1))
fi
assert_contains "$TEST_ROOT/invalid.stderr" "BACKUP_LABEL must be" \
	"invalid-label diagnostic"
assert_eq "2" "$(wc -l < "$PG_DUMP_LOG" | tr -d ' ')" \
	"invalid label rejected before pg_dump"
assert_missing "$TEST_ROOT/escape-20260731T003300Z.sql.gz.gpg" \
	"invalid label path traversal"

# Routine artifacts expire sooner than labelled rollback lines. Legacy
# date-only canonical names remain routine; unrelated/manual names are not
# silently adopted into either retention policy.
printf old > "$OUT/db-20200101T000000Z.sql.gz.gpg"
printf old > "$OUT/db-20200101.sql.gz.gpg"
printf old > "$OUT/db-20200101T000000Z-37.sql.gz.gpg"
printf hold > "$OUT/db-labelled-hold-20200101T000000Z.sql.gz.gpg"
printf expire > "$OUT/db-labelled-expire-20200101T000000Z.sql.gz.gpg"
printf manual > "$OUT/pre-manual-20200101.sql.gz.gpg"
printf manual > "$OUT/db-7year-manual-archive.sql.gz.gpg"
printf manual > "$OUT/db-20200101-pre-migration.sql.gz.gpg"
printf manual > "$OUT/db-20200101T000000Z-keep-me.sql.gz.gpg"
printf manual > "$OUT/db-labelled-manual-archive.sql.gz.gpg"
printf manual > "$OUT/db-labelled-hold-20200101T000000Z-keep-me.sql.gz.gpg"
touch -d '30 days ago' \
	"$OUT/db-20200101T000000Z.sql.gz.gpg" \
	"$OUT/db-20200101.sql.gz.gpg" \
	"$OUT/db-20200101T000000Z-37.sql.gz.gpg" \
	"$OUT/db-labelled-hold-20200101T000000Z.sql.gz.gpg" \
	"$OUT/db-7year-manual-archive.sql.gz.gpg" \
	"$OUT/db-20200101-pre-migration.sql.gz.gpg" \
	"$OUT/db-20200101T000000Z-keep-me.sql.gz.gpg" \
	"$OUT/pre-manual-20200101.sql.gz.gpg"
touch -d '100 days ago' \
	"$OUT/db-labelled-expire-20200101T000000Z.sql.gz.gpg" \
	"$OUT/db-labelled-manual-archive.sql.gz.gpg" \
	"$OUT/db-labelled-hold-20200101T000000Z-keep-me.sql.gz.gpg"

run_labelled "pre-1.20.0" "labelled-rollback" > "$TEST_ROOT/labelled.stdout"
labelled="$OUT/db-labelled-pre-1.20.0-20260731T003300Z.sql.gz.gpg"
assert_exists "$labelled" "first-class labelled backup"
assert_eq "labelled-rollback" "$(payload_of "$labelled")" "labelled payload"
assert_missing "$OUT/db-20200101T000000Z.sql.gz.gpg" "expired routine backup"
assert_missing "$OUT/db-20200101.sql.gz.gpg" "expired legacy routine backup"
assert_missing "$OUT/db-20200101T000000Z-37.sql.gz.gpg" \
	"expired collision-suffixed routine backup"
assert_exists "$OUT/db-labelled-hold-20200101T000000Z.sql.gz.gpg" \
	"labelled backup inside extended retention"
assert_missing "$OUT/db-labelled-expire-20200101T000000Z.sql.gz.gpg" \
	"labelled backup beyond extended retention"
assert_exists "$OUT/pre-manual-20200101.sql.gz.gpg" \
	"unknown manual artifact outside automatic retention"
assert_exists "$OUT/db-7year-manual-archive.sql.gz.gpg" \
	"digit-prefixed manual artifact outside automatic retention"
assert_exists "$OUT/db-20200101-pre-migration.sql.gz.gpg" \
	"legacy-looking manual artifact outside automatic retention"
assert_exists "$OUT/db-20200101T000000Z-keep-me.sql.gz.gpg" \
	"non-numeric routine suffix outside automatic retention"
assert_exists "$OUT/db-labelled-manual-archive.sql.gz.gpg" \
	"timestamp-free labelled-looking artifact outside automatic retention"
assert_exists "$OUT/db-labelled-hold-20200101T000000Z-keep-me.sql.gz.gpg" \
	"non-numeric labelled suffix outside automatic retention"
assert_eq "0" "$(find "$OUT" -maxdepth 1 -name '.db-*' | wc -l | tr -d ' ')" \
	"staging files cleaned after successful runs"

if (( failures > 0 )); then
	echo "$failures backup-script test(s) failed" >&2
	exit 1
fi
echo "All encrypted backup script tests passed."
