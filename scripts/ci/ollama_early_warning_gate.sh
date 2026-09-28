#!/usr/bin/env bash
# Cheap gate for the Ollama early warning: decides whether a candidate release
# needs the A/B run, without pulling any image. Prints `key=value` lines for
# GITHUB_OUTPUT: candidate_version, pinned_version, model_digest, then either
# run=false with a reason, or candidate_image, key and run=true. Any failure to
# establish the answer (release lookup, registry, dependency graph) exits
# nonzero, so a scheduled check can never pass without checking.
#
# usage: scripts/ci/ollama_early_warning_gate.sh [CANDIDATE_VERSION]
#   Without a version, the candidate is the latest stable ollama/ollama
#   release, and a candidate whose version and image digest equal the pin
#   needs no run.
# Environment:
#   EW_FORCE=true  run even when the latest release is already pinned or this
#                  evaluation was already delivered
#   EW_REPO        owner/name whose delivery markers are the dedupe record
#                  (requires gh with actions:read); unset skips the lookup
#   EW_BRANCH      branch whose scheduled and manual runs count (default main)
# Requires gh, docker buildx, jq and deno.
set -euo pipefail
# shellcheck source=scripts/ci/ollama_early_warning_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ollama_early_warning_common.sh"

emit() { printf '%s=%s\n' "$1" "$2"; }
skip() {
  emit run false
  emit reason "$1"
  exit 0
}
force=${EW_FORCE:-false}

explicit=${1:-}
candidate=$explicit
if [[ -z $candidate ]]; then
  tag=$(gh api repos/ollama/ollama/releases/latest | jq -r .tag_name)
  candidate=${tag#v}
fi
# Validated before any use: it becomes an image reference and a file name.
if ! [[ $candidate =~ $VERSION_RE ]]; then
  echo "invalid candidate version (expected N.N.N or N.N.N-rcN)" >&2
  exit 1
fi

pinned=$(pinned_image)
[[ $pinned =~ $IMAGE_RE ]]
pinned_version=${BASH_REMATCH[1]}
pinned_digest=${BASH_REMATCH[3]}
model_digest=$(deno run "$ROOT/scripts/nomic_pin.ts" | jq -r .digest)
emit candidate_version "$candidate"
emit pinned_version "$pinned_version"
emit model_digest "$model_digest"

# A release can appear on GitHub before its image reaches Docker Hub; the next
# scheduled run picks it up. Only a definite not-found means that: an outage,
# an authentication failure or an unexpected answer fails the check instead.
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
if ! manifest=$(docker buildx imagetools inspect "ollama/ollama:$candidate" \
  --format '{{json .Manifest}}' 2>"$errors"); then
  if grep -qE ": not found$" "$errors"; then
    skip "image ollama/ollama:$candidate is not published yet"
  fi
  cat "$errors" >&2
  echo "cannot resolve ollama/ollama:$candidate" >&2
  exit 1
fi
index=$(jq -r .digest <<<"$manifest")
if ! [[ $index =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "unexpected manifest for ollama/ollama:$candidate" >&2
  exit 1
fi
# A re-published tag has the pinned version but a new digest: evaluate it.
if [[ -z $explicit && $force != true && $candidate == "$pinned_version" &&
  $index == "sha256:$pinned_digest" ]]; then
  skip "latest release $candidate is already pinned"
fi
emit candidate_image "ollama/ollama:$candidate@$index"

# The measurement's own revision: every file it executes or configures.
inputs=$(harness_inputs)
grep -qx server/embeddings.ts <<<"$inputs" || {
  echo "harness input discovery failed" >&2
  exit 1
}
harness=$(cd "$ROOT" && tr '\n' '\0' <<<"$inputs" | xargs -0 sha256sum |
  sha256sum | cut -c1-12)
key="ollama-ew-$candidate-${index:7:12}-pin-$pinned_version-${pinned_digest:0:12}"
key+="-model-${model_digest:0:12}-harness-$harness"
emit key "$key"

# The dedupe record is the delivery marker that the notify job uploads after
# every notification succeeded, not the verdict: a failed delivery is retried.
# Only a marker from a scheduled or manual run of this workflow, in this
# repository and on the trusted branch, counts; a pull request (including one
# from a fork branch named main) can upload an artifact under any name.
if [[ $force != true && -n ${EW_REPO:-} ]]; then
  runs=$(gh api -X GET "repos/$EW_REPO/actions/artifacts" \
    -f name="delivered-$key" -f per_page=100 |
    jq -r '.artifacts[] | select((.expired | not) and
      .workflow_run.head_repository_id == .workflow_run.repository_id) |
      .workflow_run.id')
  for run in $runs; do
    [[ $run =~ ^[0-9]+$ ]] || continue
    if gh api "repos/$EW_REPO/actions/runs/$run" |
      jq -e --arg branch "${EW_BRANCH:-main}" --arg path "$WORKFLOW" '
        (.event == "schedule" or .event == "workflow_dispatch") and
        .head_branch == $branch and (.path | split("@")[0]) == $path and
        .head_repository.id == .repository.id' >/dev/null; then
      skip "$key was already evaluated and delivered (run $run)"
    fi
  done
fi
emit run true
emit reason "evaluate $candidate against pinned $pinned_version"
