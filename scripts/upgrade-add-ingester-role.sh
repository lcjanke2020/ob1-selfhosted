#!/usr/bin/env bash
# Retired corpus-role migration entry point. Kept as a fail-closed tombstone
# so old operator automation explains the Arc B boundary instead of recreating
# an edge credential in the thoughts database.
set -euo pipefail

echo "[upgrade-add-ingester-role] refused: openbrain_ingester must not exist on the corpus cluster" >&2
echo "Provision sink roles only through db/log-sink/00-log-sink-roles.sh." >&2
exit 2
