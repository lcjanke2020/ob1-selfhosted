# Encrypted off-box DB backup (reference example)

> One possible approach, provided **for reference** — not a turnkey component.
> Adapt the paths, role names, transport, and scheduler to your environment.
>
> A concrete instantiation of this approach — the script, the systemd service +
> timer, and a scoped env file — is shipped for the app qube under
> [`app-qube/backup/`](app-qube/backup/). This page is the rationale + the
> restore/verify procedure behind it.

When Postgres runs in a dedicated qube (see
[`three-qube-design.md`](three-qube-design.md) and
[`docker-compose.external-db.yml`](docker-compose.external-db.yml)), a small
daily job can produce an **encrypted, off-box** dump _without putting any
private key on the edge/app host_.

## Shape

- **App host** — holds only the backup **public key** (encrypt-only; no private
  key, no secret keyring). Dumps with a read-only DB role, gzips, GPG-encrypts
  to the public key, and drops the artifact into an off-box-replicated directory
  (Syncthing, `rsync`, …).
- **Off-box store** — receives the `*.sql.gz.gpg` only: encrypted at rest, so a
  compromise there does not expose the data.
- **A separate machine** holds the **private key** and is the only place that
  can decrypt and test-restore.

## Daily job (runs on the app host as an unprivileged user)

```bash
#!/bin/bash
set -euo pipefail
# Source only the few vars this job needs from your deploy env. Sourcing the whole
# .env exports *every* variable to child processes (and a value with spaces / # / $
# can misparse) — a dedicated backup env file, or a PGPASSFILE/.pgpass entry for the
# password, keeps the surface small.
BACKUP_LABEL_ARG=${BACKUP_LABEL:-}             # capture caller-only input first
set -a; . /path/to/deploy/backup.env; set +a   # DB_HOST DB_PORT POSTGRES_DB READONLY_ROLE READONLY_PASSWORD
BACKUP_LABEL=$BACKUP_LABEL_ARG                 # ignore any persistent setting
OUT_DIR=/path/to/offbox-synced-dir
PUBKEY=/path/to/backup-pubkey.asc            # PUBLIC key only
RETAIN_DAYS=${RETAIN_DAYS:-14}
LABEL_RETAIN_DAYS=${LABEL_RETAIN_DAYS:-90}

[[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]]
[[ "$LABEL_RETAIN_DAYS" =~ ^[0-9]+$ ]]
if [[ -n "$BACKUP_LABEL" ]]; then
  (( ${#BACKUP_LABEL} <= 64 ))
  [[ "$BACKUP_LABEL" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -n "$BACKUP_LABEL" ]]; then
  STEM="db-labelled-$BACKUP_LABEL-$TS"
else
  STEM="db-$TS"
fi
# Stage the temp file *inside* OUT_DIR so the final publish is a same-filesystem
# operation (a cross-FS copy from /tmp could expose a half-written final file).
# The leading dot keeps staging clear of the prune globs and Syncthing ignore rule.
TMP="$(mktemp "$OUT_DIR/.db-$TS.XXXXXX")"
trap '[[ -z "${TMP:-}" ]] || rm -f -- "$TMP"' EXIT

# pipefail makes the whole chain fail if pg_dump (e.g. lost connection), gzip, or the
# gpg encrypt step errors — so a partial/failed dump is never published.
# gpg -z 0 disables gpg's own compression so the already-gzipped stream isn't compressed
# twice. (Don't expect rsync/Syncthing to ship only daily *diffs* of these artifacts:
# gpg uses a fresh random session key + CFB prefix per run, so the ciphertext changes
# pervasively even for identical input — the whole file re-replicates each day. See Notes
# for the incremental-encrypted-backup option.)
PGPASSWORD="$READONLY_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$READONLY_ROLE" -d "$POSTGRES_DB" \
  --no-owner --no-privileges \
  | gzip \
  | gpg --batch --no-tty --yes -z 0 --recipient-file "$PUBKEY" --encrypt --output "$TMP"

# Encrypt-only host can't decrypt to verify; just ensure a non-empty artifact
# (the pipeline above already guaranteed each stage exited 0).
[ -s "$TMP" ]

# Atomically add a hard link to the complete staging inode. An existing entry is
# never replaced; exact same-second collisions receive -2, -3, and so on. `-T`
# requires GNU coreutils and prevents a candidate directory becoming a target dir.
PUBLISHED=""
for ((attempt = 1; attempt <= 1000; attempt++)); do
  if (( attempt == 1 )); then
    OUT="$OUT_DIR/$STEM.sql.gz.gpg"
  else
    OUT="$OUT_DIR/$STEM-$attempt.sql.gz.gpg"
  fi
  if ln -T -- "$TMP" "$OUT" 2>/dev/null; then
    PUBLISHED="$OUT"
    rm -f -- "$TMP"; TMP=""
    break
  fi
  if [[ ! -e "$OUT" && ! -L "$OUT" ]]; then
    echo "cannot atomically publish backup at $OUT (hard-link failed)" >&2
    exit 1
  fi
done
if [[ -z "$PUBLISHED" ]]; then
  echo "cannot publish backup: all 1000 names for $STEM already exist" >&2
  exit 1
fi
printf 'published encrypted backup: %s\n' "$PUBLISHED"

# Routine (including legacy date-only) and labelled artifacts have deliberately
# separate retention horizons. Unknown/manual names are not auto-deleted.
find "$OUT_DIR" -regextype posix-extended -maxdepth 1 -type f \
  -regex '.*/db-[0-9]{8}(T[0-9]{6}Z(-[0-9]+)?)?\.sql\.gz\.gpg' \
  -mtime +"$RETAIN_DAYS" -delete
find "$OUT_DIR" -regextype posix-extended -maxdepth 1 -type f \
  -regex '.*/db-labelled-[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?\.sql\.gz\.gpg' \
  -mtime +"$LABEL_RETAIN_DAYS" -delete
```

Drive it with a systemd `oneshot` service + a daily `timer` (or cron).
`--recipient-file` needs no keyring or ownertrust — the public key in the file
is used directly.

A daily job that fails silently becomes an incident the day you need a restore.
Wire the unit with `OnFailure=` (or a cron wrapper that mails/logs) so a broken
pipeline is noticed. If `OUT_DIR` is a Syncthing folder, add the staging temp to
`.stignore` so peers never see a partial:

```
/.db-*
```

The hard-link publish requires the staging and final names to share one
filesystem and that filesystem to support hard links. That is normal for a
Syncthing directory on a local Linux filesystem. Treat failure as a
storage-configuration error; do not fall back to `mv -f` or a copy into the
final name.

For a pre-migration rollback point, invoke the job once with a descriptive label
(for example, `BACKUP_LABEL=pre-1.20.0`). Wait for the labelled artifact to
replicate and verify it from the private-key host before migrating. A
post-deploy routine run gets its own timestamped name and can never replace that
rollback point. Routine dumps default to 14-day retention; labelled dumps
default to 90 days.

## Verify (on the machine that holds the private key)

A backup you haven't restored is not a backup. With the encrypted dumps on the
off-box store and the private key on a separate machine that can reach it:

```bash
#!/bin/bash
# Without pipefail, the pipeline takes psql's exit status — an upstream ssh/gpg/gunzip
# failure mid-pipe could feed psql a truncated dump and still exit 0, i.e. a silently
# partial restore (the exact failure this section warns against).
set -euo pipefail
DSN="postgresql://restore:restore@localhost:5432/restore_test"   # throwaway DB + pgvector

# Pipe straight into the throwaway DB so the decrypted plaintext never lands on disk
# (avoids a predictable-path window, and `shred -u` is unreliable on journaling/CoW
# filesystems and SSDs anyway). If you must stage a file, `mktemp` it 0600.
ssh <offbox-host> "cat '/path/db-YYYYMMDDTHHMMSSZ.sql.gz.gpg'" \
  | gpg --decrypt | gunzip | psql "$DSN"

# Then spot-check the restore — a backup that restores but is empty is still no backup:
psql "$DSN" -c '\dt'
psql "$DSN" -c "SELECT count(*) FROM thoughts;"
```

## Notes

- **Encrypt-only on the app host is the point** — the public-facing box never
  holds material that can decrypt the corpus.
- **Back up the private key itself.** Data encrypted to a key you can lose is
  data you can lose.
- Move the public key with a **binary-safe transport** (file copy / sync), not
  email or chat paste, which reflow armored text and corrupt the key block.
- **Want incremental off-box backups?** Plain `gpg` output can't be diffed —
  each run re-ships the whole artifact. If daily bandwidth matters, reach for a
  tool that dedups at the block level _under_ its own encryption (e.g. `borg`,
  `restic`) instead of `pg_dump | gpg`.
