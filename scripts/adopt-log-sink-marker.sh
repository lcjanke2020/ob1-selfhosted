#!/bin/bash
# Adopt a healthy log-sink volume created before the durable init marker
# existed. This is deliberately a host-side, pre-recreation operation: the
# old container must still be running so the current assertion can inspect the
# exact cluster that the replacement container will inherit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$SCRIPT_DIR/../deploy/qubes/ingress-qube" && pwd)}"
ASSERTION_FILE="$SCRIPT_DIR/../db/log-sink/02-log-sink-assertion.sql"

if [[ ! -f "$COMPOSE_DIR/.env" ]]; then
  echo "[log-sink-adopt] .env not found in $COMPOSE_DIR" >&2
  exit 1
fi
if [[ ! -s "$ASSERTION_FILE" ]]; then
  echo "[log-sink-adopt] current sink assertion not found at $ASSERTION_FILE" >&2
  exit 1
fi

cd "$COMPOSE_DIR"
compose_cmd=(docker compose --env-file .env)

# Resolve container IDs rather than service names: `ps --services` collapses a
# scaled service to one line and therefore cannot prove there is one PGDATA.
running_ids="$("${compose_cmd[@]}" ps -q --status=running log-sink)"
if [[ -z "$running_ids" || "$running_ids" == *$'\n'* ]]; then
  echo "[log-sink-adopt] expected exactly one running log-sink container" >&2
  echo "[log-sink-adopt] start the pre-marker definition, not the new marker-gated wrapper, before retrying" >&2
  exit 1
fi
running_id="$running_ids"

# Run as the image's postgres OS account so the marker has the same ownership
# as a fresh init marker. The assertion is streamed from THIS checkout; the
# pre-marker container's mounted 99- assertion may be older. `set -e` inside
# the container makes the marker write unreachable when psql or any invariant
# fails. The data-directory identity check prevents a stray shared socket from
# blessing a different PGDATA.
docker exec -i --user postgres "$running_id" sh -eu -c '
  : "${PGDATA:?PGDATA is required}"
  marker="$PGDATA/.openbrain-log-sink-init-complete"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo >&2 "[log-sink-adopt] refusing: PGDATA has no nonempty PG_VERSION"
    exit 1
  fi
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    echo >&2 "[log-sink-adopt] refusing: completion marker already exists; this helper is only for pre-marker volumes"
    exit 1
  fi
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    echo >&2 "[log-sink-adopt] refusing: running container has no POSTGRES_PASSWORD"
    exit 1
  fi

  postgres_user=${POSTGRES_USER:-postgres}
  postgres_db=${POSTGRES_DB:-$postgres_user}
  export PGPASSWORD="$POSTGRES_PASSWORD"

  connected_pgdata=$(psql -X -w -h /var/run/postgresql -p 5432 \
    -U "$postgres_user" -d "$postgres_db" -Atc "SHOW data_directory")
  if [ "$connected_pgdata" != "$PGDATA" ]; then
    echo >&2 "[log-sink-adopt] refusing: socket server uses $connected_pgdata, expected $PGDATA"
    exit 1
  fi

  psql -X -w -h /var/run/postgresql -p 5432 \
    -U "$postgres_user" -d "$postgres_db" -v ON_ERROR_STOP=1 -f -

  unset PGPASSWORD
  umask 077
  set -C
  : > "$marker"
  set +C
  echo "log sink: pre-marker volume adopted after current invariants passed"
' < "$ASSERTION_FILE"

echo "[log-sink-adopt] marker installed; the current log-sink definition may now be recreated"
