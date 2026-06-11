#!/bin/bash
# Existing-deployment migration for the optional search-schema extensions
# (db/05-recency-search.sql, db/06-text-search.sql, and any future
# db/0N-*.sql extension file in the 05–09 range).
#
# Fresh installs get these via docker-entrypoint-initdb.d (the compose file
# mounts them individually), but init scripts only run on a fresh Postgres
# data directory. This script applies them to a live database; the files are
# idempotent by construction (CREATE OR REPLACE / IF NOT EXISTS throughout),
# so re-running is safe.
#
# Locking note: db/06-text-search.sql builds a trigram GIN index with a
# regular (non-CONCURRENT) CREATE INDEX, which briefly locks `thoughts`
# against writes during the build (roughly a minute or two at ~100K rows;
# imperceptible on a small brain). If you run live capture and can't pause,
# build the index manually with CREATE INDEX CONCURRENTLY first — the
# IF NOT EXISTS in the file will then skip it.
#
# COMPOSE_DIR picks the compose project (defaults to deploy/compose-local;
# set COMPOSE_DIR=.../deploy/compose-tailnet for a Pattern B checkout with
# its own .env).
#
# Exit codes:
#   0 — all extension files applied
#   1 — postgres container not running, prerequisite missing, or psql failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$REPO_ROOT/deploy/compose-local" && pwd)}"

cd "$COMPOSE_DIR"

if [[ ! -f .env ]]; then
  echo "[upgrade-search-schema] .env not found in $(pwd); set COMPOSE_DIR to your compose directory" >&2
  exit 1
fi

# Load .env so POSTGRES_DB is in scope. Scoped via set -a/+a so we don't
# pollute the caller's environment.
set -a
# shellcheck disable=SC1091
. .env
set +a

if ! docker compose ps --status=running postgres | grep -q postgres; then
  echo "[upgrade-search-schema] postgres container not running; aborting" >&2
  exit 1
fi

shopt -s nullglob
files=("$REPO_ROOT"/db/0[5-9]-*.sql)
shopt -u nullglob
if [[ ${#files[@]} -eq 0 ]]; then
  echo "[upgrade-search-schema] no db/0[5-9]-*.sql extension files found; nothing to do" >&2
  exit 1
fi

# Fed via stdin so the files' own BEGIN/COMMIT and ON_ERROR_STOP give an
# all-or-nothing apply per file, with a loud failure if (for example) the
# pg_trgm extension is unavailable in the image.
for f in "${files[@]}"; do
  echo "[upgrade-search-schema] applying $(basename "$f")"
  docker compose exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
    < "$f"
done

echo "[upgrade-search-schema] done — applied ${#files[@]} file(s)"
