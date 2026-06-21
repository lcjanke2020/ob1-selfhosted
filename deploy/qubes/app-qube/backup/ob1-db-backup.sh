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

# Source only the few vars this job needs. `set -a` so they reach pg_dump's env.
ENV_FILE="${BACKUP_ENV_FILE:-/rw/config/openbrain-units/backup.env}"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a   # DB_HOST DB_PORT POSTGRES_DB READONLY_ROLE READONLY_PASSWORD PUBKEY OUT_DIR RETAIN_DAYS

: "${DB_HOST:?set DB_HOST in $ENV_FILE (the db qube tailnet address)}"
: "${DB_PORT:=5432}"
: "${POSTGRES_DB:?set POSTGRES_DB in $ENV_FILE}"
: "${READONLY_ROLE:?set READONLY_ROLE in $ENV_FILE (e.g. openbrain_readonly)}"
: "${READONLY_PASSWORD:?set READONLY_PASSWORD in $ENV_FILE}"
: "${PUBKEY:?set PUBKEY in $ENV_FILE (path to the backup PUBLIC key, .asc)}"
: "${OUT_DIR:?set OUT_DIR in $ENV_FILE (off-box-replicated directory)}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

# Date-only stamp: the daily timer produces one artifact per day. A MANUAL re-run
# the same day overwrites that day's file (intended — keeps the prune glob and
# retention math simple); add %H%M%S if you want same-day runs kept separately.
TS=$(date +%Y%m%d)
# Stage the temp file INSIDE OUT_DIR so the final publish is a same-filesystem
# rename (a cross-FS mv from /tmp is copy-then-unlink, not atomic — a watcher
# could replicate a half-written *.sql.gz.gpg). The leading dot keeps it clear
# of the prune glob below; add `/.db-*` to the Syncthing folder's .stignore so
# peers never sync the partial.
TMP="$(mktemp "$OUT_DIR/.db-$TS.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

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
mv -f "$TMP" "$OUT_DIR/db-$TS.sql.gz.gpg"    # same-FS atomic rename; publish first…
find "$OUT_DIR" -maxdepth 1 -name 'db-*.sql.gz.gpg' -mtime +"$RETAIN_DAYS" -delete   # …then prune
