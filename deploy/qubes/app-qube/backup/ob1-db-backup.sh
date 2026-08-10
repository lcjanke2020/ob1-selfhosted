#!/bin/bash
# Encrypted off-box DB backup — daily job, runs on the APP qube.
#
# Dumps the canonical Postgres on the db qube with a READ-ONLY role, gzips,
# GPG-encrypts to a PUBLIC key (this host holds no private key), and publishes
# the artifact into an off-box-replicated directory (Syncthing, rsync, …). The
# only place that can decrypt is the separate machine holding the private key.
# Design rationale + the restore/verify procedure: ../../encrypted-backup-example.md
#
# Install: /rw/config/openbrain-units/ob1-db-backup.sh (chmod +x), driven by
# ob1-db-backup.service + .timer. Config comes from backup.env (see
# backup.env.example) — NOT this qube's compose .env (sourcing the whole .env
# would export every secret to child processes).

set -euo pipefail

# Capture the one-shot operator input before loading persistent configuration.
# An accidental BACKUP_LABEL assignment in backup.env must not relabel the daily
# timer or override a caller's explicit rollback label.
BACKUP_LABEL_ARG="${BACKUP_LABEL:-}"

# Source only the few vars this job needs. `set -a` so they reach pg_dump's env.
ENV_FILE="${BACKUP_ENV_FILE:-/rw/config/openbrain-units/backup.env}"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a   # DB_HOST DB_PORT POSTGRES_DB READONLY_ROLE READONLY_PASSWORD PUBKEY OUT_DIR RETAIN_DAYS LABEL_RETAIN_DAYS
BACKUP_LABEL="$BACKUP_LABEL_ARG"

: "${DB_HOST:?set DB_HOST in $ENV_FILE (the app qube own-IP ConnectTCP db forwarder)}"
: "${DB_PORT:=5432}"
: "${POSTGRES_DB:?set POSTGRES_DB in $ENV_FILE}"
: "${READONLY_ROLE:?set READONLY_ROLE in $ENV_FILE (e.g. openbrain_readonly)}"
: "${READONLY_PASSWORD:?set READONLY_PASSWORD in $ENV_FILE}"
: "${PUBKEY:?set PUBKEY in $ENV_FILE (path to the backup PUBLIC key, .asc)}"
: "${OUT_DIR:?set OUT_DIR in $ENV_FILE (off-box-replicated directory)}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
LABEL_RETAIN_DAYS="${LABEL_RETAIN_DAYS:-90}"

if [[ ! "$RETAIN_DAYS" =~ ^[0-9]+$ ]]; then
	echo "RETAIN_DAYS must be a non-negative integer (got: $RETAIN_DAYS)" >&2
	exit 2
fi
if [[ ! "$LABEL_RETAIN_DAYS" =~ ^[0-9]+$ ]]; then
	echo "LABEL_RETAIN_DAYS must be a non-negative integer (got: $LABEL_RETAIN_DAYS)" >&2
	exit 2
fi
if [[ -n "$BACKUP_LABEL" ]] &&
	{ (( ${#BACKUP_LABEL} > 64 )) ||
	  [[ ! "$BACKUP_LABEL" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; }; then
	echo "BACKUP_LABEL must be 1-64 ASCII letters, digits, dots, underscores, or hyphens and start/end with a letter or digit" >&2
	exit 2
fi

# Create OUT_DIR if missing so the mktemp below fails with a clear message rather
# than an indirect mktemp error (a one-time miss otherwise becomes a silent gap).
mkdir -p "$OUT_DIR" || { echo "cannot create OUT_DIR=$OUT_DIR" >&2; exit 2; }

# Clean up private staging state on every ordinary exit. A successful publish
# clears TMP after unlinking its staging name; the final hard link remains.
TMP=""
GNUPGHOME=""
cleanup() {
	[[ -z "$TMP" ]] || rm -f -- "$TMP"
	[[ -z "$GNUPGHOME" ]] || rm -rf -- "$GNUPGHOME"
}
trap cleanup EXIT

# gpg writes/locks state under ~/.gnupg by default, which the unit's
# ProtectHome=read-only sandbox blocks. Point GNUPGHOME at a private temp dir
# (0700) — --recipient-file reads the public key directly, so no keyring is
# needed, but gpg still wants a home for its random_seed/trustdb.
GNUPGHOME="$(mktemp -d)"; export GNUPGHOME

# Every artifact gets a full UTC timestamp. BACKUP_LABEL is deliberately a
# one-shot operator input rather than a persistent default: a pre-migration dump
# should say what it protects, while the daily timer keeps the routine namespace.
TS=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -n "$BACKUP_LABEL" ]]; then
	BASENAME="db-labelled-$BACKUP_LABEL-$TS"
else
	BASENAME="db-$TS"
fi
# Stage the temp file INSIDE OUT_DIR so the final publish is a same-filesystem
# operation (a cross-FS copy from /tmp could expose a half-written artifact to a
# watcher). The leading dot keeps it clear of the prune globs below; add
# `/.db-*` to the Syncthing folder's .stignore so peers never sync the partial.
TMP="$(mktemp "$OUT_DIR/.db-$TS.XXXXXX")"

# pipefail makes the whole chain fail if pg_dump (e.g. lost connection), gzip, or
# the gpg encrypt step errors — so a partial/failed dump is never published.
# gpg -z 0 disables gpg's own compression so the already-gzipped stream isn't
# compressed twice. --recipient-file needs no keyring/ownertrust — the public
# key in the file is used directly (requires GnuPG >= 2.2.28; Debian 12+/recent
# Fedora are fine — on an older template, import the key and use --recipient KEYID).
PGPASSWORD="$READONLY_PASSWORD" pg_dump \
	-h "$DB_HOST" -p "$DB_PORT" -U "$READONLY_ROLE" -d "$POSTGRES_DB" \
	--no-owner --no-privileges \
	| gzip \
	| gpg --batch --no-tty --yes -z 0 --recipient-file "$PUBKEY" --encrypt --output "$TMP"

# Encrypt-only host can't decrypt to verify; just ensure a non-empty artifact
# (the pipeline above already guaranteed each stage exited 0).
[ -s "$TMP" ]

# Publish without a clobber window. A hard link is atomic, cannot replace an
# existing directory entry, and exposes the already-complete inode at the final
# name. Exact same-second collisions receive a deterministic numeric suffix.
# `-T` prevents an attacker-created directory at a candidate path from being
# treated as a target directory by GNU ln.
PUBLISHED=""
for ((attempt = 1; attempt <= 1000; attempt++)); do
	if (( attempt == 1 )); then
		candidate="$OUT_DIR/$BASENAME.sql.gz.gpg"
	else
		candidate="$OUT_DIR/$BASENAME-$attempt.sql.gz.gpg"
	fi

	if ln -T -- "$TMP" "$candidate" 2>/dev/null; then
		PUBLISHED="$candidate"
		rm -f -- "$TMP"
		TMP=""
		break
	fi

	# Existing files, symlinks, or directories are name collisions. Any other
	# hard-link failure means the output filesystem cannot provide the atomic
	# no-clobber guarantee, so fail rather than falling back to an unsafe copy.
	if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
		echo "cannot atomically publish backup at $candidate (hard-link failed)" >&2
		exit 1
	fi
done

if [[ -z "$PUBLISHED" ]]; then
	echo "cannot publish backup: all 1000 names for $BASENAME already exist" >&2
	exit 1
fi
printf 'published encrypted backup: %s\n' "$PUBLISHED"

# Routine and explicitly labelled rollback dumps have separate, bounded
# retention horizons. The routine pattern also covers legacy db-YYYYMMDD files;
# unknown hand-built names stay outside automatic deletion.
find "$OUT_DIR" -regextype posix-extended -maxdepth 1 -type f \
	-regex '.*/db-[0-9]{8}(T[0-9]{6}Z(-[0-9]+)?)?\.sql\.gz\.gpg' \
	-mtime +"$RETAIN_DAYS" -delete
find "$OUT_DIR" -regextype posix-extended -maxdepth 1 -type f \
	-regex '.*/db-labelled-[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?\.sql\.gz\.gpg' \
	-mtime +"$LABEL_RETAIN_DAYS" -delete
