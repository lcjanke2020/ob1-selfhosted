#!/bin/bash
# Pull the ingress qube's Funnel summary over a fixed Qubes RPC service,
# encrypt it on the app qube, and publish it into the off-box backup directory.
# No plaintext dump is ever written to disk.

set -euo pipefail
umask 077

ENV_FILE="${FUNNEL_SUMMARY_BACKUP_ENV_FILE:-/rw/config/openbrain-units/funnel-summary-backup.env}"
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${TARGET_QUBE:?set TARGET_QUBE in $ENV_FILE (the ingress qube dom0 name)}"
: "${PUBKEY:?set PUBKEY in $ENV_FILE (the existing backup public key)}"
: "${OUT_DIR:?set OUT_DIR in $ENV_FILE (the existing off-box directory)}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-1024}"
MAX_DUMP_BYTES="${MAX_DUMP_BYTES:-67108864}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
BOUNDED_STREAM="${BOUNDED_STREAM:-/rw/config/openbrain-units/ob1-bounded-stream.py}"

numeric_setting() {
	local name=$1 value=$2
	if [[ ! "$value" =~ ^[0-9]+$ ]]; then
		echo "$name must be a non-negative integer (got: $value)" >&2
		exit 2
	fi
}
numeric_setting RETAIN_DAYS "$RETAIN_DAYS"
numeric_setting MIN_DUMP_BYTES "$MIN_DUMP_BYTES"
numeric_setting MAX_DUMP_BYTES "$MAX_DUMP_BYTES"
numeric_setting TIMEOUT_SECONDS "$TIMEOUT_SECONDS"
if (( MIN_DUMP_BYTES > MAX_DUMP_BYTES || TIMEOUT_SECONDS == 0 )); then
	echo "require MIN_DUMP_BYTES <= MAX_DUMP_BYTES and TIMEOUT_SECONDS > 0" >&2
	exit 2
fi
if [[ ! "$TARGET_QUBE" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
	echo "TARGET_QUBE is not a concrete Qubes domain name" >&2
	exit 2
fi
if [[ ! -r "$PUBKEY" ]]; then
	echo "backup public key is not readable: $PUBKEY" >&2
	exit 2
fi
if [[ ! -x "$BOUNDED_STREAM" ]]; then
	echo "bounded-stream helper is not executable: $BOUNDED_STREAM" >&2
	exit 2
fi
QREXEC_CLIENT="$(command -v qrexec-client-vm)" || {
	echo "qrexec-client-vm is not on PATH" >&2
	exit 127
}

mkdir -p "$OUT_DIR" || {
	echo "cannot create OUT_DIR=$OUT_DIR" >&2
	exit 2
}

# One scheduled or manual pull at a time. The lock lives on the destination
# filesystem and remains hidden from the published-artifact retention globs.
exec 9>"$OUT_DIR/.funnel-summary-backup.lock"
if ! flock -n 9; then
	echo "another Funnel summary backup is already running" >&2
	exit 75
fi

TMP=""
DIGEST_TMP=""
GNUPGHOME=""
cleanup() {
	[[ -z "$TMP" ]] || rm -f -- "$TMP"
	[[ -z "$DIGEST_TMP" ]] || rm -f -- "$DIGEST_TMP"
	[[ -z "$GNUPGHOME" ]] || rm -rf -- "$GNUPGHOME"
}
trap cleanup EXIT

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="funnel-summary-$TS"
TMP="$(mktemp "$OUT_DIR/.funnel-summary-$TS.XXXXXX")"
DIGEST_TMP="$(mktemp "$OUT_DIR/.funnel-summary-digest-$TS.XXXXXX")"

# Treat the ingress qube as hostile input. timeout bounds a hung producer;
# ob1-bounded-stream.py rejects empty/truncated and oversized streams without
# writing plaintext to disk; pipefail makes any producer/filter/GPG error fatal.
if ! timeout --foreground --signal=TERM --kill-after=10s "$TIMEOUT_SECONDS" \
	"$QREXEC_CLIENT" "$TARGET_QUBE" openbrain.LogSinkDump </dev/null \
	| "$BOUNDED_STREAM" "$MIN_DUMP_BYTES" "$MAX_DUMP_BYTES" PGDMP \
	| gpg --batch --no-tty --yes -z 0 \
		--recipient-file "$PUBKEY" --encrypt --output "$TMP"; then
	echo "Funnel summary pull/encryption pipeline failed" >&2
	exit 1
fi
if [[ ! -s "$TMP" ]]; then
	echo "encrypted Funnel summary artifact is empty" >&2
	exit 1
fi

DIGEST="$(sha256sum "$TMP" | awk '{print $1}')"
PUBLISHED=""
PUBLISHED_DIGEST=""
for ((attempt = 1; attempt <= 1000; attempt++)); do
	if (( attempt == 1 )); then
		candidate="$OUT_DIR/$BASENAME.dump.gpg"
	else
		candidate="$OUT_DIR/$BASENAME-$attempt.dump.gpg"
	fi
	candidate_digest="$candidate.sha256"

	if [[ -e "$candidate" || -L "$candidate" ||
	      -e "$candidate_digest" || -L "$candidate_digest" ]]; then
		continue
	fi
	printf '%s  %s\n' "$DIGEST" "${candidate##*/}" > "$DIGEST_TMP"

	# Publish the digest first, then make the encrypted artifact visible. Each
	# link is atomic and no-clobber; this ordering means even a power loss between
	# them can leave only an inert orphan digest, never an artifact with no digest.
	if ! ln -T -- "$DIGEST_TMP" "$candidate_digest" 2>/dev/null; then
		if [[ -e "$candidate_digest" || -L "$candidate_digest" ]]; then
			continue
		fi
		echo "cannot atomically publish Funnel summary digest at $candidate_digest" >&2
		exit 1
	fi
	if ! ln -T -- "$TMP" "$candidate" 2>/dev/null; then
		rm -f -- "$candidate_digest"
		if [[ -e "$candidate" || -L "$candidate" ]]; then
			continue
		fi
		echo "cannot atomically publish Funnel summary at $candidate" >&2
		exit 1
	fi

	PUBLISHED="$candidate"
	PUBLISHED_DIGEST="$candidate_digest"
	rm -f -- "$TMP" "$DIGEST_TMP"
	TMP=""
	DIGEST_TMP=""
	break
done

if [[ -z "$PUBLISHED" ]]; then
	echo "cannot publish Funnel summary: all 1000 names for $BASENAME are occupied" >&2
	exit 1
fi
printf 'published encrypted Funnel summary: %s sha256=%s digest=%s\n' \
	"$PUBLISHED" "$DIGEST" "$PUBLISHED_DIGEST"

# This backup contains only the rolling 365-day aggregate table. Fourteen
# daily snapshots give rollback depth without extending raw IP/user-agent data
# beyond its on-edge 30-day policy.
find "$OUT_DIR" -regextype posix-extended -maxdepth 1 -type f \
	-regex '.*/funnel-summary-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?\.dump\.gpg(\.sha256)?' \
	-mtime +"$RETAIN_DAYS" -delete
