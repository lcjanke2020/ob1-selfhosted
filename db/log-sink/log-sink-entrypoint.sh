#!/bin/sh
# Refuse to start an existing log-sink data directory unless the final init
# script recorded that every role, relation, grant, and assertion completed.
#
# The stock Postgres entrypoint creates PG_VERSION before it runs initdb.d. If
# an init script fails, a restart would otherwise treat that partial directory
# as initialized, skip every script, and start a superficially healthy server.

set -eu

: "${PGDATA:?PGDATA is required}"
ready_marker="$PGDATA/.openbrain-log-sink-init-complete"

if [ -s "$PGDATA/PG_VERSION" ] && [ ! -f "$ready_marker" ]; then
  echo >&2 "[log-sink-entrypoint] refusing to start: existing PGDATA is missing the Open Brain init completion marker"
  echo >&2 "[log-sink-entrypoint] inspect the first-init logs; do not create the marker by hand"
  exit 1
fi

exec docker-entrypoint.sh "$@"
