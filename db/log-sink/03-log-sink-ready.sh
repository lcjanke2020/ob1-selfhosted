#!/bin/sh
# Mounted as zz-log-sink-ready.sh so it runs only after the 99- assertion. There
# must be no later init script: this marker is the durable proof that initdb.d
# reached the end successfully.

set -eu

: "${PGDATA:?PGDATA is required}"
umask 077
: > "$PGDATA/.openbrain-log-sink-init-complete"
echo "log sink: init completion marker written"
