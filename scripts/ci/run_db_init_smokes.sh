#!/usr/bin/env bash
# Run one or more corpus DB-init smoke families against an ephemeral pgvector
# container. Each named family is a complete local command; "all" mirrors CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$CI_REPO_ROOT"
export CI_REPO_ROOT GITHUB_WORKSPACE="$CI_REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage: scripts/ci/run_db_init_smokes.sh [all|preflight|schema|auth|grants|retirement|search|summary]...

Examples:
  scripts/ci/run_db_init_smokes.sh auth
  scripts/ci/run_db_init_smokes.sh grants retirement
  scripts/ci/run_db_init_smokes.sh all
USAGE
}

if (( $# == 0 )); then
  set -- all
fi
for family in "$@"; do
  case "$family" in
    all|preflight|schema|auth|grants|retirement|search|summary) ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown DB-init smoke family: $family" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# This runner owns a throwaway fixture. Do not inherit a caller's deployment
# target, host, or credentials into it.
export POSTGRES_DB=openbrain
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=ci_superuser_pw
export OPENBRAIN_APP_PASSWORD=ci_app_pw
export OPENBRAIN_READONLY_PASSWORD=ci_readonly_pw
export OPENBRAIN_TOKEN_ADMIN_PASSWORD=ci_token_admin_pw
export DB_SMOKE_HOST=127.0.0.1
export DB_SMOKE_PORT="${DB_SMOKE_PORT:-55439}"

created_runner_temp=
if [[ -z "${RUNNER_TEMP:-}" ]]; then
  RUNNER_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/ob1-db-init-smoke.XXXXXX")"
  created_runner_temp=$RUNNER_TEMP
fi
export RUNNER_TEMP

run_token="${GITHUB_RUN_ID:-local-${UID:-0}-$$}-${GITHUB_RUN_ATTEMPT:-1}"
run_token="${run_token//[^A-Za-z0-9_.-]/-}"
export DB_INIT_CONTAINER="${DB_INIT_CONTAINER:-ob1-db-init-$run_token}"

container_started=0
cleanup() {
  local rc=$?
  trap - EXIT
  if (( container_started )); then
    if (( rc != 0 )); then
      echo "DB-init smoke failed; container logs follow" >&2
      docker logs "$DB_INIT_CONTAINER" >&2 || true
    fi
    docker rm -f "$DB_INIT_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$created_runner_temp" ]]; then
    rm -rf -- "$created_runner_temp"
  fi
  exit "$rc"
}
trap cleanup EXIT

run_family() {
  local label=$1
  shift
  printf '\n===== DB-init family: %s =====\n' "$label"
  if "$@"; then
    printf '===== passed: %s =====\n' "$label"
  else
    local rc=$?
    echo "::error title=DB-init smoke failed::$label failed (exit $rc)" >&2
    return "$rc"
  fi
}

run_preflight() {
  run_family "workflow path contract" \
    deno run --config server/deno.json --frozen \
      --allow-read=.github/workflows/db-init.yml \
      scripts/ci/check_db_init_paths.ts
  run_family "Funnel monitor" bash scripts/funnel_monitor_test.sh
  run_family "encrypted backup publication" \
    bash deploy/qubes/app-qube/backup/ob1-db-backup_test.sh
}

start_database() {
  command -v docker >/dev/null || {
    echo "docker is required for DB-init smoke families" >&2
    return 127
  }
  command -v deno >/dev/null || {
    echo "deno is required for DB-init smoke families" >&2
    return 127
  }

  if docker container inspect "$DB_INIT_CONTAINER" >/dev/null 2>&1; then
    echo "container already exists: $DB_INIT_CONTAINER" >&2
    return 2
  fi

  local image
  image=$(grep -m1 -oE 'pgvector/pgvector:[A-Za-z0-9._-]+' \
    deploy/compose-local/docker-compose.yml || true)
  test -n "$image" || {
    echo "no pgvector image found in deploy/compose-local/docker-compose.yml" >&2
    return 1
  }
  printf 'Using %s (from deploy/compose-local/docker-compose.yml)\n' "$image"

  if ! docker run -d --name "$DB_INIT_CONTAINER" \
    -p "127.0.0.1:$DB_SMOKE_PORT:5432" \
    -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD \
    -e OPENBRAIN_APP_PASSWORD -e OPENBRAIN_READONLY_PASSWORD \
    -e OPENBRAIN_TOKEN_ADMIN_PASSWORD \
    -v "$GITHUB_WORKSPACE/db/00-roles.sh:/docker-entrypoint-initdb.d/00-roles.sh:ro" \
    -v "$GITHUB_WORKSPACE/db/01-schema.sql:/docker-entrypoint-initdb.d/01-schema.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/02-observability.sql:/docker-entrypoint-initdb.d/02-observability.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/04-sessions.sql:/docker-entrypoint-initdb.d/04-sessions.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/05-hybrid-search.sql:/docker-entrypoint-initdb.d/05-hybrid-search.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/06-spaces.sql:/docker-entrypoint-initdb.d/06-spaces.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/07-metadata-degradation.sql:/docker-entrypoint-initdb.d/07-metadata-degradation.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/08-access-tokens.sql:/docker-entrypoint-initdb.d/08-access-tokens.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/09-retire-corpus-funnel.sql:/docker-entrypoint-initdb.d/09-retire-corpus-funnel.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/10-thought-mutations.sql:/docker-entrypoint-initdb.d/10-thought-mutations.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/03-grants-assertion.sql:/docker-entrypoint-initdb.d/99-grants-assertion.sql:ro" \
    "$image" >/dev/null; then
    # Docker may create the named container before failing to bind its port.
    # The name was proven absent above, so any such residue belongs to us.
    docker rm -f "$DB_INIT_CONTAINER" >/dev/null 2>&1 || true
    return 1
  fi
  container_started=1

  local ready=
  for i in $(seq 1 60); do
    if docker exec "$DB_INIT_CONTAINER" pg_isready -h 127.0.0.1 \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      printf 'Postgres ready after %ss\n' "$i"
      ready=1
      break
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$DB_INIT_CONTAINER" 2>/dev/null)" != "true" ]]; then
      echo "Postgres container exited during init" >&2
      return 1
    fi
    sleep 1
  done
  test "$ready" = 1 || {
    echo "timed out waiting for Postgres init" >&2
    return 1
  }
}

run_schema() {
  run_family "schema baseline" bash scripts/ci/db_init_schema_smoke.sh baseline
  run_family "schema/data contracts" bash scripts/ci/db_init_schema_smoke.sh data
}
run_auth() {
  run_family "native-token auth" bash scripts/ci/db_init_auth_smoke.sh tokens
  run_family "auth audit and upgrade" bash scripts/ci/db_init_auth_smoke.sh audit
}
run_grants() {
  run_family "corpus grants" bash scripts/ci/db_init_grants_smoke.sh
}
run_retirement() {
  run_family "corpus retirement" bash scripts/ci/db_init_retirement_smoke.sh
}
run_search() {
  run_family "search" bash scripts/ci/db_init_search_smoke.sh
}
run_summary() {
  run_family "summary wrappers" bash scripts/ci/db_init_summary_smoke.sh
}

requested=("$@")
if [[ " ${requested[*]} " == *" all "* || " ${requested[*]} " == *" preflight "* ]]; then
  run_preflight
fi

db_requested=()
if [[ " ${requested[*]} " == *" all "* ]]; then
  db_requested=(schema auth grants retirement search summary)
else
  for family in "${requested[@]}"; do
    [[ "$family" == "preflight" ]] || db_requested+=("$family")
  done
fi

if (( ${#db_requested[@]} > 0 )); then
  run_family "ephemeral corpus setup" start_database
  for family in "${db_requested[@]}"; do
    "run_$family"
  done
fi
