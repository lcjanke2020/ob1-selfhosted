#!/usr/bin/env bash
# Ollama early-warning A/B runner. Tests one candidate Ollama image against the
# image pinned in the Compose files, both serving the pinned Nomic model on this
# machine, and writes a compatible / drift / broken / error verdict. Used by
# .github/workflows/ollama-early-warning.yml; runnable outside Actions.
#
# usage: scripts/ci/ollama_early_warning.sh CANDIDATE_IMAGE RESULT_DIR
#   CANDIDATE_IMAGE  ollama/ollama:<version>@sha256:<image index digest>
#   RESULT_DIR       directory for logs, fingerprints, verdict.json, summary.md
#
# Three containers run from their own copies of one digest-verified model store:
# pinned (baseline), pinned again (control, a fresh process giving the noise
# floor) and the candidate. scripts/probe-embedding-runtime.ts runs against the
# pinned and candidate endpoints, scripts/embedding-fingerprint.ts against all
# three, and scripts/ci/ollama_early_warning_verdict.ts compares the results.
#
# Environment (all optional):
#   EW_MODEL_STORE  persistent Ollama models directory holding, or receiving, the
#                   pinned Nomic model; default: a scratch directory removed on exit
#   EW_PORT_BASE    first of three loopback ports (default 55450)
#   EW_RUN_URL      link recorded in the report
# Exit status: 0 verdict about the candidate (compatible, drift or broken),
# 1 harness error or no verdict, 2 usage error.
set -euo pipefail

# shellcheck source=scripts/ci/ollama_early_warning_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ollama_early_warning_common.sh"

usage() {
  sed -n '7,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
[[ $# -eq 2 ]] || usage
CANDIDATE_IMAGE=$1
OUT=$2
[[ $CANDIDATE_IMAGE =~ $IMAGE_RE ]] || {
  echo "candidate must match $IMAGE_RE" >&2
  exit 2
}
CANDIDATE_VERSION=${BASH_REMATCH[1]}
PORT_BASE=${EW_PORT_BASE:-55450}
if ! [[ $PORT_BASE =~ ^[0-9]+$ ]] || ((PORT_BASE < 1024 || PORT_BASE > 65533)); then
  echo "EW_PORT_BASE must be a port between 1024 and 65533" >&2
  exit 2
fi

PINNED_IMAGE=$(pinned_image)
[[ $PINNED_IMAGE =~ $IMAGE_RE ]]
PINNED_VERSION=${BASH_REMATCH[1]}

model_pin=$(deno run "$ROOT/scripts/nomic_pin.ts")
MODEL=$(jq -r .model <<<"$model_pin")
MODEL_DIGEST=$(jq -r .digest <<<"$model_pin")

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama-ew.XXXXXX")
STORE=${EW_MODEL_STORE:-$WORK/model-store}
mkdir -p "$STORE"
STORE=$(cd "$STORE" && pwd)
PREFIX="ollama-ew-$$"
containers=()

# Keeps the container's log with the results, then removes it.
remove() {
  docker logs "$1" >"$OUT/$1.log" 2>&1 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local name
  for name in "${containers[@]}"; do
    docker container inspect "$name" >/dev/null 2>&1 || continue
    # A serving container's scratch store may hold files it created as root;
    # open them so the invoking user can delete the copy. The persistent
    # store behind the fetch container is left as is.
    [[ $name == "$PREFIX-fetch" ]] ||
      docker exec "$name" chmod -R a+rwX /root/.ollama/models >/dev/null 2>&1 || true
    remove "$name"
  done
  rm -rf "$WORK" || echo "warning: could not remove scratch $WORK" >&2
}
trap cleanup EXIT

# Deno runs with a minimal environment so deployment settings in the caller's
# shell (EMBED_DIM, FETCH_TIMEOUT_MS, ...) cannot change the measurement.
clean_deno() {
  env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 \
    ${DENO_DIR:+DENO_DIR="$DENO_DIR"} \
    ${XDG_CACHE_HOME:+XDG_CACHE_HOME="$XDG_CACHE_HOME"} \
    "$@"
}

wait_ready() {
  local port=$1 i
  for ((i = 0; i < 120; i++)); do
    curl -fsS "http://127.0.0.1:$port/api/version" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "ollama on port $port did not become ready" >&2
  return 1
}

start() {
  local name="$PREFIX-$1" image=$2 port=$3 store=$4
  containers+=("$name")
  # :z relabels the scratch copy on SELinux hosts; elsewhere it is a no-op.
  docker run -d --name "$name" \
    --security-opt no-new-privileges:true \
    -e OLLAMA_NOPRUNE=1 \
    -p "127.0.0.1:$port:11434" \
    -v "$store:/root/.ollama/models:z" \
    "$image" >/dev/null
  wait_ready "$port"
}

served_digest() {
  curl -fsS "http://127.0.0.1:$1/api/tags" |
    jq -r --arg m "$MODEL" '.models[] | select(.name == $m) | .digest' |
    sed 's/^sha256://'
}

docker pull -q "$PINNED_IMAGE" >/dev/null
docker pull -q "$CANDIDATE_IMAGE" >/dev/null

# One verified model store: fetched once with the pinned runtime (or restored
# by the caller), then copied per container so no runtime can modify the files
# another one serves.
start fetch "$PINNED_IMAGE" "$PORT_BASE" "$STORE"
if [[ ! -d $STORE/manifests ]]; then
  echo "fetching $MODEL into $STORE"
  docker exec "$PREFIX-fetch" ollama pull "$MODEL" >"$OUT/model-pull.log" 2>&1 || {
    tail -n 5 "$OUT/model-pull.log" >&2
    exit 1
  }
fi
digest=$(served_digest "$PORT_BASE" || true)
# Ollama writes some store files mode 0600. With rootful Docker they belong to
# root, and the copies below run as the invoking user.
docker exec "$PREFIX-fetch" chmod -R a+rX /root/.ollama/models
remove "$PREFIX-fetch"
if [[ $digest != "$MODEL_DIGEST" ]]; then
  echo "model store serves $MODEL digest '${digest:-none}', not the pin $MODEL_DIGEST" >&2
  exit 1
fi

cpu=$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//' || true)
jq -n \
  --arg pv "$PINNED_VERSION" --arg pi "$PINNED_IMAGE" \
  --arg cv "$CANDIDATE_VERSION" --arg ci "$CANDIDATE_IMAGE" \
  --arg mn "$MODEL" --arg md "$MODEL_DIGEST" \
  --arg url "${EW_RUN_URL:-}" \
  --arg arch "$(uname -m)" --arg cpu "${cpu:-unknown}" --arg n "$(nproc)" \
  '{pinned: {version: $pv, image: $pi}, candidate: {version: $cv, image: $ci},
    model: {name: $mn, digest: $md},
    runner: {arch: $arch, cpu: $cpu, cpus: ($n | tonumber)}}
   + (if $url == "" then {} else {run_url: $url} end)' >"$OUT/meta.json"

declare -A port=(
  [pinned]=$PORT_BASE
  [control]=$((PORT_BASE + 1))
  [candidate]=$((PORT_BASE + 2))
)
for name in pinned control candidate; do
  cp -R "$STORE" "$WORK/store-$name"
done
start pinned "$PINNED_IMAGE" "${port[pinned]}" "$WORK/store-pinned"
start control "$PINNED_IMAGE" "${port[control]}" "$WORK/store-control"
start candidate "$CANDIDATE_IMAGE" "${port[candidate]}" "$WORK/store-candidate"

# Runs a repository Deno script against one endpoint; records stdout, stderr
# and the exit status for the verdict instead of stopping at a failure.
measure() {
  local script=$1 endpoint=$2 out=$3 status=0
  (cd "$ROOT" && clean_deno OLLAMA_URL="http://127.0.0.1:${port[$endpoint]}" \
    deno run --config server/deno.json --frozen --allow-env \
    --allow-net="127.0.0.1:${port[$endpoint]}" "$script") \
    >"$OUT/$out.${4:-jsonl}" 2>"$OUT/$out.stderr" || status=$?
  echo "$status" >"$OUT/$out.status"
  echo "$out: exit $status"
}
# Sequential, so the endpoints never compete for CPU.
measure scripts/probe-embedding-runtime.ts pinned probe-pinned
measure scripts/probe-embedding-runtime.ts candidate probe-candidate
measure scripts/embedding-fingerprint.ts pinned fp-baseline json
measure scripts/embedding-fingerprint.ts control fp-control json
measure scripts/embedding-fingerprint.ts candidate fp-candidate json

status=0
(cd "$ROOT" && clean_deno deno run --config server/deno.json --frozen \
  --allow-read="$OUT" --allow-write="$OUT" \
  scripts/ci/ollama_early_warning_verdict.ts "$OUT") || status=$?
exit "$status"
