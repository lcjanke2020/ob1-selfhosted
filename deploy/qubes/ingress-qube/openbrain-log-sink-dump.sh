#!/bin/bash
# Fixed Qubes RPC producer for the ingress qube's Funnel summary backup.
#
# Install an operator-reviewed copy at
#   /rw/config/openbrain-log-sink-dump.sh
# and let rc.local restage it as the executable service
#   /etc/qubes-rpc/openbrain.LogSinkDump
# on every AppVM boot. The matching dom0 policy must allow only the app qube,
# force user=user, and deny every other source/argument/target combination.
#
# stdout is ONLY the custom-format pg_dump. Diagnostics stay on stderr.

set -euo pipefail

# >>> EDIT BOTH placeholders in the installed /rw/config copy.
EXPECTED_CALLER="<app-qube>"
COMPOSE_DIR="<ingress-compose-dir>"

readonly SERVICE_FULL_NAME="openbrain.LogSinkDump+"

if [[ "$EXPECTED_CALLER" == "<app-qube>" ||
      "$COMPOSE_DIR" == "<ingress-compose-dir>" ]]; then
	echo "openbrain.LogSinkDump: install placeholders are not configured" >&2
	exit 78
fi
if (( $# != 0 )); then
	echo "openbrain.LogSinkDump: service arguments are not accepted" >&2
	exit 64
fi
if [[ "${QREXEC_SERVICE_FULL_NAME:-}" != "$SERVICE_FULL_NAME" ]]; then
	echo "openbrain.LogSinkDump: unexpected service identity" >&2
	exit 65
fi
if [[ "${QREXEC_REMOTE_DOMAIN:-}" != "$EXPECTED_CALLER" ]]; then
	echo "openbrain.LogSinkDump: caller is not the configured app qube" >&2
	exit 77
fi
if [[ ! -x /usr/bin/docker || ! -r "$COMPOSE_DIR/.env" ||
      ! -r "$COMPOSE_DIR/docker-compose.yml" ]]; then
	echo "openbrain.LogSinkDump: compose runtime or deployment files are unavailable" >&2
	exit 69
fi

# The caller cannot feed data or commands into this service. The only bytes
# returned are produced by the fixed pg_dump below. The backup role can SELECT
# only the 365-day aggregate table, so raw IP/user-agent rows retain their
# existing 30-day, on-edge-only lifetime.
exec </dev/null
cd "$COMPOSE_DIR"
exec /usr/bin/docker compose \
	--project-directory "$COMPOSE_DIR" \
	--env-file "$COMPOSE_DIR/.env" \
	-f "$COMPOSE_DIR/docker-compose.yml" \
	exec -T log-sink sh -eu -c '
		: "${OPENBRAIN_LOGS_BACKUP_PASSWORD:?backup role password is not configured}"
		: "${POSTGRES_DB:?sink database name is not configured}"
		export PGPASSWORD="$OPENBRAIN_LOGS_BACKUP_PASSWORD"
		exec pg_dump -w \
			-h /var/run/postgresql \
			-U openbrain_logs_backup \
			-d "$POSTGRES_DB" \
			--format=custom \
			--compress=none \
			--strict-names \
			--no-owner \
			--no-privileges \
			--table=public.funnel_access_summary
	'
