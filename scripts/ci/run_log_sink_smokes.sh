#!/usr/bin/env bash
# Run the log-sink smoke families against disposable, socket-only Postgres
# containers. Each named family is a complete local command; "all" mirrors CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$CI_REPO_ROOT"
export CI_REPO_ROOT GITHUB_WORKSPACE="$CI_REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage: scripts/ci/run_log_sink_smokes.sh [all|preflight|lifecycle|monitor-absent|backup-absent|contract|rollup|wrapper]...

Examples:
  scripts/ci/run_log_sink_smokes.sh lifecycle
  scripts/ci/run_log_sink_smokes.sh contract rollup
  scripts/ci/run_log_sink_smokes.sh all
USAGE
}

if (( $# == 0 )); then
  set -- all
fi
for family in "$@"; do
  case "$family" in
    all|preflight|lifecycle|monitor-absent|backup-absent|contract|rollup|wrapper) ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown log-sink smoke family: $family" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# This runner owns throwaway fixtures. Deployment values from the caller must
# never select its database, credentials, image, checkout, Compose project, or
# container names.
export POSTGRES_DB=openbrain_logs
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=ci_sink_superuser_pw
export OPENBRAIN_INGESTER_PASSWORD=ci_sink_ingester_pw
export OPENBRAIN_LOGS_ROLLUP_PASSWORD=ci_sink_rollup_pw
export OPENBRAIN_MONITOR_PASSWORD=ci_sink_monitor_pw
export OPENBRAIN_LOGS_BACKUP_PASSWORD=ci_sink_backup_pw
export LOG_SINK_RUNNER_ACTIVE=1
# Process-environment values override Compose env files. Scrub every selector
# that could redirect a lifecycle fixture or its adoption helper to a caller's
# deployment; the fixture supplies its own project and file explicitly.
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PATH_SEPARATOR \
  COMPOSE_PROFILES COMPOSE_ENV_FILES

created_runner_temp=
if [[ -z "${RUNNER_TEMP:-}" ]]; then
  task_tmp_base=${TMPDIR:-}
  if [[ -z "$task_tmp_base" || "$task_tmp_base" == /tmp ]]; then
    task_tmp_base="/tmp/${USER:-$(id -un)}"
    install -d -m 0700 "$task_tmp_base"
  fi
  RUNNER_TEMP="$(mktemp -d "$task_tmp_base/ob1-log-sink-smoke.XXXXXX")"
  created_runner_temp=$RUNNER_TEMP
fi
export RUNNER_TEMP TMPDIR="$RUNNER_TEMP"

run_marker_dir="$(mktemp -d "$RUNNER_TEMP/log-sink-run.XXXXXX")"
run_nonce=${run_marker_dir##*/}
run_nonce=${run_nonce#log-sink-run.}
run_token="${GITHUB_RUN_ID:-local-${UID:-0}-$run_nonce}-${GITHUB_RUN_ATTEMPT:-1}"
run_token=${run_token,,}
run_token="${run_token//[^a-z0-9_-]/-}"
export LOG_SINK_TOKEN="ob1-log-sink-$run_token"
export LOG_SINK_CONTAINER="$LOG_SINK_TOKEN-main"

container_started=0
cleanup() {
  local rc=$?
  trap - EXIT
  if (( container_started )); then
    if (( rc != 0 )); then
      echo "Log-sink smoke failed; primary container logs follow" >&2
      docker logs "$LOG_SINK_CONTAINER" >&2 || true
    fi
    docker rm -f -v "$LOG_SINK_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "$created_runner_temp" ]]; then
    rm -rf -- "$created_runner_temp"
  else
    rm -rf -- "$run_marker_dir"
  fi
  exit "$rc"
}
trap cleanup EXIT

run_family() {
  local label=$1
  shift
  printf '\n===== Log-sink family: %s =====\n' "$label"
  if "$@"; then
    printf '===== passed: %s =====\n' "$label"
  else
    local rc=$?
    echo "::error title=Log-sink smoke failed::$label failed (exit $rc)" >&2
    return "$rc"
  fi
}

run_preflight() {
  command -v deno >/dev/null || {
    echo "deno is required for the log-sink role-contract preflight" >&2
    return 127
  }
  deno test --config server/deno.json --frozen --allow-read \
    scripts/ci/check_log_sink_roles_test.ts || return
  deno run --allow-read scripts/ci/check_log_sink_roles.ts || return

  # Prove the checker fails deterministically when the canonical identity
  # changes but its unavoidable runtime literals have not. Keep the mutation
  # under the runner-owned scratch directory; the checkout is never touched.
  local drift_manifest drift_output drift_rc
  drift_manifest="$(mktemp "$RUNNER_TEMP/log-sink-role-drift.XXXXXX.json")"
  sed '0,/openbrain_ingester/s//openbrain_ci_drift/' \
    db/log-sink/role-contract.json > "$drift_manifest"
  set +e
  drift_output="$(deno run --allow-read scripts/ci/check_log_sink_roles.ts \
    --manifest "$drift_manifest" 2>&1)"
  drift_rc=$?
  set -e
  if (( drift_rc == 0 )); then
    echo "role-contract validator accepted a stale ingester identity" >&2
    return 1
  fi
  grep -Fq "sink assertion contract" <<< "$drift_output" || {
    echo "role-contract drift failed for an unexpected reason:" >&2
    echo "$drift_output" >&2
    return 1
  }
  rm -f -- "$drift_manifest"
  echo "role-contract drift probe rejected stale consumers"

  command -v systemd-analyze >/dev/null || {
    echo "systemd-analyze is required for the log-sink preflight family" >&2
    return 127
  }
  systemd-analyze verify \
    deploy/qubes/ingress-qube/funnel-summary.service \
    deploy/qubes/ingress-qube/funnel-summary.timer \
    deploy/qubes/app-qube/backup/ob1-funnel-summary-backup.service \
    deploy/qubes/app-qube/backup/ob1-funnel-summary-backup.timer || return
  systemd-analyze calendar '*-*-* 00:40:00 UTC' >/dev/null
}

prepare_docker() {
  command -v docker >/dev/null || {
    echo "docker is required for log-sink smoke families" >&2
    return 127
  }

  PG_IMAGE=$(grep -m1 -oE 'postgres:[A-Za-z0-9._-]+' \
    deploy/qubes/ingress-qube/docker-compose.yml || true)
  test -n "$PG_IMAGE" || {
    echo "no postgres image found in deploy/qubes/ingress-qube/docker-compose.yml" >&2
    return 1
  }
  export PG_IMAGE
  printf 'Using %s (from deploy/qubes/ingress-qube/docker-compose.yml)\n' \
    "$PG_IMAGE"
}

start_sink() {
  if docker container inspect "$LOG_SINK_CONTAINER" >/dev/null 2>&1; then
    echo "container already exists: $LOG_SINK_CONTAINER" >&2
    return 2
  fi

  if ! docker run -d --name "$LOG_SINK_CONTAINER" --network none \
    -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD \
    -e POSTGRES_INITDB_ARGS="--auth-local=scram-sha-256 --auth-host=scram-sha-256" \
    -e POSTGRES_HOST_AUTH_METHOD=reject \
    -e OPENBRAIN_INGESTER_PASSWORD -e OPENBRAIN_LOGS_ROLLUP_PASSWORD \
    -e OPENBRAIN_MONITOR_PASSWORD -e OPENBRAIN_LOGS_BACKUP_PASSWORD \
    -v "$GITHUB_WORKSPACE/db/log-sink/log-sink-entrypoint.sh:/usr/local/bin/openbrain-log-sink-entrypoint.sh:ro" \
    -v "$GITHUB_WORKSPACE/db/log-sink/00-log-sink-roles.sh:/docker-entrypoint-initdb.d/00-log-sink-roles.sh:ro" \
    -v "$GITHUB_WORKSPACE/db/log-sink/01-log-sink.sql:/docker-entrypoint-initdb.d/01-log-sink.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/log-sink/02-log-sink-status-class.sql:/docker-entrypoint-initdb.d/02-log-sink-status-class.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/log-sink/02-log-sink-assertion.sql:/docker-entrypoint-initdb.d/99-log-sink-assertion.sql:ro" \
    -v "$GITHUB_WORKSPACE/db/log-sink/03-log-sink-ready.sh:/docker-entrypoint-initdb.d/zz-log-sink-ready.sh:ro" \
    --entrypoint /bin/sh \
    "$PG_IMAGE" /usr/local/bin/openbrain-log-sink-entrypoint.sh \
    postgres -c listen_addresses= >/dev/null; then
    docker rm -f -v "$LOG_SINK_CONTAINER" >/dev/null 2>&1 || true
    return 1
  fi
  container_started=1

  local ready=
  for i in $(seq 1 60); do
    if docker exec "$LOG_SINK_CONTAINER" sh -c \
      'test "$(cat /proc/1/comm)" = postgres && test -f "$PGDATA/.openbrain-log-sink-init-complete" && pg_isready -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      >/dev/null 2>&1; then
      printf 'Log sink ready after %ss\n' "$i"
      ready=1
      break
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$LOG_SINK_CONTAINER" 2>/dev/null)" != true ]]; then
      echo "log-sink container exited during init" >&2
      return 1
    fi
    sleep 1
  done
  test "$ready" = 1 || {
    echo "timed out waiting for final log-sink server" >&2
    return 1
  }
}

run_monitor_absent() {
  local primary_container=$LOG_SINK_CONTAINER
  local monitor_password=$OPENBRAIN_MONITOR_PASSWORD

  export LOG_SINK_CONTAINER="${LOG_SINK_TOKEN}-monitor-absent"
  unset OPENBRAIN_MONITOR_PASSWORD
  start_sink || return
  bash scripts/ci/log_sink_contract_smoke.sh monitor-absent || return
  docker rm -f -v "$LOG_SINK_CONTAINER" >/dev/null || return
  container_started=0

  export LOG_SINK_CONTAINER=$primary_container
  export OPENBRAIN_MONITOR_PASSWORD=$monitor_password
}

run_backup_absent() {
  local primary_container=$LOG_SINK_CONTAINER
  local backup_password=$OPENBRAIN_LOGS_BACKUP_PASSWORD

  export LOG_SINK_CONTAINER="${LOG_SINK_TOKEN}-backup-absent"
  unset OPENBRAIN_LOGS_BACKUP_PASSWORD
  start_sink || return
  bash scripts/ci/log_sink_contract_smoke.sh backup-absent || return
  docker rm -f -v "$LOG_SINK_CONTAINER" >/dev/null || return
  container_started=0

  export LOG_SINK_CONTAINER=$primary_container
  export OPENBRAIN_LOGS_BACKUP_PASSWORD=$backup_password
}

requested=("$@")
run_all=0
if [[ " ${requested[*]} " == *" all "* ]]; then
  run_all=1
fi

if (( run_all )) || [[ " ${requested[*]} " == *" preflight "* ]]; then
  run_family "ingress rollup unit preflight" run_preflight
fi

needs_docker=0
for family in "${requested[@]}"; do
  [[ "$family" == preflight ]] || needs_docker=1
done
if (( needs_docker )); then
  run_family "derive pinned sink runtime" prepare_docker
fi

if (( run_all )) || [[ " ${requested[*]} " == *" lifecycle "* ]]; then
  docker compose version >/dev/null || {
    echo "docker compose is required for the log-sink lifecycle family" >&2
    exit 127
  }
  run_family "adoption and partial-init lifecycle" \
    bash scripts/ci/log_sink_lifecycle_smoke.sh
fi

if (( run_all )) || [[ " ${requested[*]} " == *" monitor-absent "* ]]; then
  run_family "monitor-optional fresh init" run_monitor_absent
fi

if (( run_all )) || [[ " ${requested[*]} " == *" backup-absent "* ]]; then
  run_family "backup-optional fresh init" run_backup_absent
fi

main_requested=()
if (( run_all )); then
  main_requested=(contract rollup wrapper)
else
  for family in contract rollup wrapper; do
    if [[ " ${requested[*]} " == *" $family "* ]]; then
      main_requested+=("$family")
    fi
  done
fi

if (( ${#main_requested[@]} > 0 )); then
  run_family "ephemeral socket-only sink setup" start_sink
fi

if (( run_all )); then
  run_family "sink init and socket boundary" \
    bash scripts/ci/log_sink_contract_smoke.sh baseline
  run_family "least-privilege sink roles" \
    bash scripts/ci/log_sink_contract_smoke.sh roles
  run_family "rollup, retention, and concurrency" \
    bash scripts/ci/log_sink_rollup_smoke.sh
  run_family "socket password authentication" \
    bash scripts/ci/log_sink_contract_smoke.sh auth
  run_family "target-pinned summary wrapper" \
    bash scripts/ci/log_sink_wrapper_smoke.sh
  run_family "post-rollup assertion mutation matrix" \
    bash scripts/ci/log_sink_contract_smoke.sh assertion
else
  for family in "${main_requested[@]}"; do
    case "$family" in
      contract)
        run_family "sink contract" bash scripts/ci/log_sink_contract_smoke.sh
        ;;
      rollup)
        run_family "rollup, retention, and concurrency" \
          bash scripts/ci/log_sink_rollup_smoke.sh
        ;;
      wrapper)
        run_family "target-pinned summary wrapper" \
          bash scripts/ci/log_sink_wrapper_smoke.sh
        ;;
    esac
  done
fi
