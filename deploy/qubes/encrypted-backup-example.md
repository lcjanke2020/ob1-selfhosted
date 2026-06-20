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
# Pull DB_HOST / DB_PORT / POSTGRES_DB and a read-only role's password from your deploy env.
set -a; . /path/to/deploy/.env; set +a
OUT_DIR=/path/to/offbox-synced-dir
PUBKEY=/path/to/backup-pubkey.asc            # PUBLIC key only
TS=$(date +%Y%m%d)
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

# pipefail makes the whole chain fail if pg_dump (e.g. lost connection), gzip, or the
# gpg encrypt step errors — so a partial/failed dump is never published.
PGPASSWORD="$READONLY_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U <readonly_role> -d "$POSTGRES_DB" \
  --no-owner --no-privileges \
  | gzip \
  | gpg --batch --no-tty --yes --recipient-file "$PUBKEY" --encrypt --output "$TMP"

# Encrypt-only host can't decrypt to verify; just ensure a non-empty artifact
# (the pipeline above already guaranteed each stage exited 0).
[ -s "$TMP" ]
mv -f "$TMP" "$OUT_DIR/db-$TS.sql.gz.gpg"    # atomic publish into the off-box folder
find "$OUT_DIR" -maxdepth 1 -name 'db-*.sql.gz.gpg' -mtime +14 -delete
```

Drive it with a systemd `oneshot` service + a daily `timer` (or cron). `--recipient-file`
needs no keyring or ownertrust — the public key in the file is used directly.

## Verify (on the machine that holds the private key)

A backup you haven't restored is not a backup. With the encrypted dumps on the off-box
store and the private key on a separate machine that can reach it:

```bash
ssh <offbox-host> "cat '/path/db-YYYYMMDD.sql.gz.gpg'" \
  | gpg --decrypt | gunzip > /tmp/restore.sql
# restore into a throwaway Postgres + pgvector, compare row counts, then `shred -u` the plaintext
```

## Notes

- **Encrypt-only on the app host is the point** — the public-facing box never holds material
  that can decrypt the corpus.
- **Back up the private key itself.** Data encrypted to a key you can lose is data you can lose.
- Move the public key with a **binary-safe transport** (file copy / sync), not email or chat
  paste, which reflow armored text and corrupt the key block.
