#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${LOG_SINK_RUNNER_ACTIVE:-}" != 1 ]]; then
  exec "$SCRIPT_DIR/run_log_sink_smokes.sh" lifecycle
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/log_sink_common.sh"

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${LOG_SINK_TOKEN:?LOG_SINK_TOKEN is required}"

log_sink_step "Healthy pre-marker sink is assertion-gated before adoption"
adoption_root="$(mktemp -d "$RUNNER_TEMP/log-sink-adoption.XXXXXX")"
adoption_volume="$LOG_SINK_TOKEN-adoption-volume"
adoption_project="$LOG_SINK_TOKEN-adoption"

# Omitting the generated-column migration, current assertion, wrapper, and
# durable marker reconstructs the prior deployed catalog/PGDATA shape. The
# current adoption helper must refuse it until the explicit migration lands.
cat > "$adoption_root/compose.yml" <<'YAML'
services:
  log-sink:
    image: ${PG_IMAGE:?PG_IMAGE is required}
    network_mode: none
    environment:
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB is required}
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_INITDB_ARGS: --auth-local=scram-sha-256 --auth-host=scram-sha-256
      POSTGRES_HOST_AUTH_METHOD: reject
      OPENBRAIN_INGESTER_PASSWORD: ${OPENBRAIN_INGESTER_PASSWORD:?OPENBRAIN_INGESTER_PASSWORD is required}
      OPENBRAIN_LOGS_ROLLUP_PASSWORD: ${OPENBRAIN_LOGS_ROLLUP_PASSWORD:?OPENBRAIN_LOGS_ROLLUP_PASSWORD is required}
      OPENBRAIN_MONITOR_PASSWORD: ${OPENBRAIN_MONITOR_PASSWORD:-}
    entrypoint: ["docker-entrypoint.sh"]
    command: ["postgres", "-c", "listen_addresses="]
    volumes:
      - log_sink_data:/var/lib/postgresql/data
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/00-log-sink-roles.sh:/docker-entrypoint-initdb.d/00-log-sink-roles.sh:ro
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/01-log-sink.sql:/docker-entrypoint-initdb.d/01-log-sink.sql:ro
volumes:
  log_sink_data:
    name: ${ADOPTION_VOLUME:?ADOPTION_VOLUME is required}
YAML

cat > "$adoption_root/marker.yml" <<'YAML'
services:
  log-sink:
    entrypoint: ["/bin/sh", "/usr/local/bin/openbrain-log-sink-entrypoint.sh"]
    volumes:
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/log-sink-entrypoint.sh:/usr/local/bin/openbrain-log-sink-entrypoint.sh:ro
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/02-log-sink-status-class.sql:/docker-entrypoint-initdb.d/02-log-sink-status-class.sql:ro
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/02-log-sink-assertion.sql:/docker-entrypoint-initdb.d/99-log-sink-assertion.sql:ro
      - ${CI_REPO_ROOT:?CI_REPO_ROOT is required}/db/log-sink/03-log-sink-ready.sh:/docker-entrypoint-initdb.d/zz-log-sink-ready.sh:ro
YAML

cat > "$adoption_root/.env" <<ENV
COMPOSE_FILE=compose.yml
COMPOSE_PROJECT_NAME=$adoption_project
ADOPTION_VOLUME=$adoption_volume
ENV

adoption_compose_opts=(
  --project-directory "$adoption_root"
  --env-file "$adoption_root/.env"
  --project-name "$adoption_project"
)

cleanup_adoption() {
  local rc=$1
  if (( rc != 0 )); then
    docker compose "${adoption_compose_opts[@]}" \
      -f "$adoption_root/compose.yml" -f "$adoption_root/marker.yml" \
      logs >&2 || true
  fi
  docker compose "${adoption_compose_opts[@]}" \
    -f "$adoption_root/compose.yml" -f "$adoption_root/marker.yml" \
    down -v >/dev/null 2>&1 || true
  docker volume rm "$adoption_volume" >/dev/null 2>&1 || true
  rm -rf -- "$adoption_root"
  return "$rc"
}
trap 'cleanup_adoption "$?"' EXIT

docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" up -d log-sink

# pg_isready alone can see the init-phase temporary socket server. PID 1
# becomes postgres only after initdb.d ends and the entrypoint execs the final
# server, eliminating the shutdown/startup gap.
ready=
for _ in $(seq 1 60); do
  if docker compose "${adoption_compose_opts[@]}" \
    -f "$adoption_root/compose.yml" \
    exec -T log-sink sh -c \
      'test "$(cat /proc/1/comm)" = postgres && pg_isready -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T log-sink sh -c \
    'test ! -e "$PGDATA/.openbrain-log-sink-init-complete"'

# Preserve a representative historical row across migration/adoption/recreate.
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
    psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c "INSERT INTO public.funnel_access_log
            (ts, socket, path, status)
          VALUES ('2026-08-13T00:00:00Z', 'funnel',
                  '/pre-marker-history', 200)"

# The current assertion is the adoption gate, so an unmigrated legacy catalog
# must remain unmarked even though its two old relations and grants are healthy.
trap - ERR
set +e
adoption_output=$(COMPOSE_DIR="$adoption_root" \
  COMPOSE_FILE="$adoption_root/compose.yml" \
  COMPOSE_PROJECT_NAME="$adoption_project" \
  "$CI_REPO_ROOT/scripts/adopt-log-sink-marker.sh" 2>&1)
adoption_rc=$?
set -e
trap log_sink_error ERR
test "$adoption_rc" -ne 0
grep -Fq 'funnel_access_log columns drifted' \
  <<< "$adoption_output"
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T log-sink sh -c \
    'test ! -e "$PGDATA/.openbrain-log-sink-init-complete"'

# Run the exact deployed migration twice. The first execution backfills the
# retained row; the second proves idempotency. Both are one transaction.
for _ in 1 2; do
  docker compose "${adoption_compose_opts[@]}" \
    -f "$adoption_root/compose.yml" \
    exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
      psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
        -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f - \
      < "$CI_REPO_ROOT/db/log-sink/02-log-sink-status-class.sql" \
      >/dev/null
done
migration_verdict=$(docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
    psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" -Atc \
      "SELECT
         (SELECT status_class FROM public.funnel_access_log
          WHERE path = '/pre-marker-history'),
         (SELECT attgenerated FROM pg_attribute
          WHERE attrelid = 'public.funnel_access_log'::regclass
            AND attname = 'status_class' AND NOT attisdropped),
         (SELECT count(*) FROM public.funnel_access_log
          WHERE path = '/pre-marker-history')")
test "$migration_verdict" = "2xx|s|1" || {
  echo "legacy status migration drifted (class|generated|rows=$migration_verdict, want 2xx|s|1)" >&2
  exit 1
}

# A migrated catalog with an unrelated drift relation must still remain
# unmarked; migration is not permission to weaken the closed-world assertion.
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
    psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c 'CREATE TABLE public.adoption_must_refuse (id integer)'
trap - ERR
set +e
adoption_output=$(COMPOSE_DIR="$adoption_root" \
  COMPOSE_FILE="$adoption_root/compose.yml" \
  COMPOSE_PROJECT_NAME="$adoption_project" \
  "$CI_REPO_ROOT/scripts/adopt-log-sink-marker.sh" 2>&1)
adoption_rc=$?
set -e
trap log_sink_error ERR
test "$adoption_rc" -ne 0
grep -Fq 'expected exactly (funnel_access_log, funnel_access_summary)' \
  <<< "$adoption_output"
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
    psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c 'DROP TABLE public.adoption_must_refuse'
adoption_output=$(COMPOSE_DIR="$adoption_root" \
  COMPOSE_FILE="$adoption_root/compose.yml" \
  COMPOSE_PROJECT_NAME="$adoption_project" \
  "$CI_REPO_ROOT/scripts/adopt-log-sink-marker.sh" 2>&1)
grep -Fq 'log sink: invariants OK' <<< "$adoption_output"
grep -Fq 'pre-marker volume adopted after current invariants passed' \
  <<< "$adoption_output"
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" \
  exec -T log-sink sh -c \
    'test -f "$PGDATA/.openbrain-log-sink-init-complete" && test "$(stat -c %a "$PGDATA/.openbrain-log-sink-init-complete")" = 600'

# Recreate the service with the new wrapper on the SAME named volume. It must
# accept the assertion-gated marker and keep the catalog/data.
docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" -f "$adoption_root/marker.yml" \
  up -d --force-recreate log-sink
restarted=
for _ in $(seq 1 60); do
  if docker compose "${adoption_compose_opts[@]}" \
    -f "$adoption_root/compose.yml" -f "$adoption_root/marker.yml" \
    exec -T log-sink sh -c \
      'test "$(cat /proc/1/comm)" = postgres && test -f "$PGDATA/.openbrain-log-sink-init-complete" && pg_isready -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      >/dev/null 2>&1; then
    restarted=1
    break
  fi
  sleep 1
done
test "$restarted" = 1
history_rows=$(docker compose "${adoption_compose_opts[@]}" \
  -f "$adoption_root/compose.yml" -f "$adoption_root/marker.yml" \
  exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" log-sink \
    psql -X -w -h /var/run/postgresql -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" -Atc \
      "SELECT count(*) FROM public.funnel_access_log
       WHERE path = '/pre-marker-history'")
test "$history_rows" = 1
echo "legacy status migration idempotent with history intact; current assertion gated adoption; drifted volume refused; wrapper restart passed"

cleanup_adoption 0
trap - EXIT

log_sink_step "Failed first init cannot restart as a partial sink"
partial_volume="$LOG_SINK_TOKEN-partial-volume"
partial_first="$LOG_SINK_TOKEN-partial-first"
partial_restart="$LOG_SINK_TOKEN-partial-restart"
failure_sql="$RUNNER_TEMP/log-sink-intentional-init-failure-$LOG_SINK_TOKEN.sql"
printf '%s\n' '\set ON_ERROR_STOP on' 'SELECT 1 / 0;' > "$failure_sql"
docker volume create "$partial_volume" >/dev/null

cleanup_partial() {
  local rc=$1
  docker rm -f "$partial_first" "$partial_restart" >/dev/null 2>&1 || true
  docker volume rm "$partial_volume" >/dev/null 2>&1 || true
  rm -f -- "$failure_sql"
  return "$rc"
}
trap 'cleanup_partial "$?"' EXIT

trap - ERR
set +e
docker run --name "$partial_first" --network none \
  -e POSTGRES_PASSWORD=ci_partial_superuser_pw \
  -v "$partial_volume:/var/lib/postgresql/data" \
  -v "$CI_REPO_ROOT/db/log-sink/log-sink-entrypoint.sh:/usr/local/bin/openbrain-log-sink-entrypoint.sh:ro" \
  -v "$failure_sql:/docker-entrypoint-initdb.d/99-intentional-failure.sql:ro" \
  --entrypoint /bin/sh \
  "$PG_IMAGE" /usr/local/bin/openbrain-log-sink-entrypoint.sh \
  postgres -c listen_addresses= >/dev/null 2>&1
first_rc=$?
set -e
trap log_sink_error ERR
test "$first_rc" -ne 0 || {
  echo "intentional first-init failure unexpectedly succeeded" >&2
  exit 1
}
docker rm "$partial_first" >/dev/null

trap - ERR
set +e
restart_output=$(timeout 120 docker run --name "$partial_restart" --network none \
  -e POSTGRES_PASSWORD=ci_partial_superuser_pw \
  -v "$partial_volume:/var/lib/postgresql/data" \
  -v "$CI_REPO_ROOT/db/log-sink/log-sink-entrypoint.sh:/usr/local/bin/openbrain-log-sink-entrypoint.sh:ro" \
  --entrypoint /bin/sh \
  "$PG_IMAGE" /usr/local/bin/openbrain-log-sink-entrypoint.sh \
  postgres -c listen_addresses= 2>&1)
restart_rc=$?
set -e
trap log_sink_error ERR
# A missing guard would start postgres on the partial PGDATA and never return;
# the bound turns that regression into a distinct failure instead of a hung run.
test "$restart_rc" -ne 124 || {
  echo "partial sink kept running instead of refusing to start" >&2
  exit 1
}
test "$restart_rc" -ne 0
grep -Fq 'missing the Open Brain init completion marker' <<< "$restart_output"
echo "partial PGDATA remained fail-closed across restart"

cleanup_partial 0
trap - EXIT
