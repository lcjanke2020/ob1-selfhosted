# Encrypted off-box DB backup (reference example)

> One possible approach, provided **for reference** — not a turnkey component.
> Adapt the paths, role names, transport, and scheduler to your environment.

When Postgres runs in a dedicated qube (see [`three-qube-design.md`](three-qube-design.md)
and [`docker-compose.external-db.yml`](docker-compose.external-db.yml)), a small daily
job can produce an **encrypted, off-box** dump *without putting any private key on the
edge/app host*.

## Shape

- **App host** — holds only the backup **public key** (encrypt-only; no private key, no
  secret keyring). Dumps with a read-only DB role, gzips, GPG-encrypts to the public key,
  and drops the artifact into an off-box-replicated directory (Syncthing, `rsync`, …).
- **Off-box store** — receives the `*.sql.gz.gpg` only: encrypted at rest, so a compromise
  there does not expose the data.
- **A separate machine** holds the **private key** and is the only place that can decrypt
  and test-restore.

## Daily job (runs on the app host as an unprivileged user)

```bash
#!/bin/bash
set -euo pipefail
# Source only the few vars this job needs from your deploy env. Sourcing the whole
# .env exports *every* variable to child processes (and a value with spaces / # / $
# can misparse) — a dedicated backup env file, or a PGPASSFILE/.pgpass entry for the
# password, keeps the surface small.
set -a; . /path/to/deploy/backup.env; set +a   # DB_HOST DB_PORT POSTGRES_DB READONLY_ROLE READONLY_PASSWORD
OUT_DIR=/path/to/offbox-synced-dir
PUBKEY=/path/to/backup-pubkey.asc            # PUBLIC key only
TS=$(date +%Y%m%d)
# Stage the temp file *inside* OUT_DIR so the final publish is a same-filesystem
# rename (a cross-FS mv from /tmp is copy-then-unlink, not atomic — a watcher could
# replicate a half-written *.sql.gz.gpg). The leading dot keeps it clear of the
# prune glob below; add it to .stignore (see note) so peers never sync the partial.
TMP="$(mktemp "$OUT_DIR/.db-$TS.XXXXXX")"; trap 'rm -f "$TMP"' EXIT

# pipefail makes the whole chain fail if pg_dump (e.g. lost connection), gzip, or the
# gpg encrypt step errors — so a partial/failed dump is never published.
# gpg -z 0 disables gpg's own compression so we don't compress twice; gzip --rsyncable
# keeps small daily diffs localized so Syncthing/rsync don't re-ship the whole file.
PGPASSWORD="$READONLY_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$READONLY_ROLE" -d "$POSTGRES_DB" \
  --no-owner --no-privileges \
  | gzip --rsyncable \
  | gpg --batch --no-tty --yes -z 0 --recipient-file "$PUBKEY" --encrypt --output "$TMP"

# Encrypt-only host can't decrypt to verify; just ensure a non-empty artifact
# (the pipeline above already guaranteed each stage exited 0).
[ -s "$TMP" ]
mv -f "$TMP" "$OUT_DIR/db-$TS.sql.gz.gpg"    # same-FS atomic rename; publish first…
find "$OUT_DIR" -maxdepth 1 -name 'db-*.sql.gz.gpg' -mtime +14 -delete   # …then prune
```

Drive it with a systemd `oneshot` service + a daily `timer` (or cron). `--recipient-file`
needs no keyring or ownertrust — the public key in the file is used directly.

A daily job that fails silently becomes an incident the day you need a restore. Wire the
unit with `OnFailure=` (or a cron wrapper that mails/logs) so a broken pipeline is noticed.
If `OUT_DIR` is a Syncthing folder, add the staging temp to `.stignore` so peers never see
a partial:

```
/.db-*
```

## Verify (on the machine that holds the private key)

A backup you haven't restored is not a backup. With the encrypted dumps on the off-box
store and the private key on a separate machine that can reach it:

```bash
# Pipe straight into a throwaway Postgres + pgvector so the decrypted plaintext never
# lands on disk (avoids a predictable-path window, and `shred -u` is unreliable on
# journaling/CoW filesystems and SSDs anyway). If you must stage a file, `mktemp` it 0600.
ssh <offbox-host> "cat '/path/db-YYYYMMDD.sql.gz.gpg'" \
  | gpg --decrypt | gunzip | psql "<throwaway-dsn>"

# Then spot-check the restore — a backup that restores but is empty is still no backup:
psql "<throwaway-dsn>" -c '\dt'
psql "<throwaway-dsn>" -c "SELECT count(*) FROM thoughts;"
```

## Notes

- **Encrypt-only on the app host is the point** — the public-facing box never holds material
  that can decrypt the corpus.
- **Back up the private key itself.** Data encrypted to a key you can lose is data you can lose.
- Move the public key with a **binary-safe transport** (file copy / sync), not email or chat
  paste, which reflow armored text and corrupt the key block.
