#!/bin/sh
# Mounted as zz-log-sink-ready.sh so it runs only after the 99- assertion. There
# must be no later init script: this marker is the durable proof that initdb.d
# reached the end successfully on a fresh volume. The pre-marker adoption helper
# is the only other writer, and likewise runs the current assertion first.

set -eu

: "${PGDATA:?PGDATA is required}"
umask 077
: > "$PGDATA/.openbrain-log-sink-init-complete"
echo "log sink: init completion marker written"
