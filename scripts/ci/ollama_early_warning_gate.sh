#!/usr/bin/env bash
# Cheap gate for the Ollama early warning: decides whether a candidate release
# needs the A/B run, without pulling any image. Prints `key=value` lines for
# GITHUB_OUTPUT: run, reason, candidate_version, candidate_image,
# pinned_version, model_digest and key.
#
# usage: scripts/ci/ollama_early_warning_gate.sh [CANDIDATE_VERSION]
#   Without a version, the candidate is the latest stable ollama/ollama
#   release, and a candidate equal to the pinned version needs no run.
# Environment:
#   EW_FORCE=true  run even when the latest release is already pinned or this
#                  evaluation key already has a verdict
#   EW_REPO        owner/name whose verdict artifacts are the dedupe record
#                  (requires gh with actions:read); unset skips the lookup
#   EW_BRANCH      branch whose runs count as evaluated (default main)
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

explicit=${1:-}
candidate=$explicit
if [[ -z $candidate ]]; then
  tag=$(gh api repos/ollama/ollama/releases/latest --jq .tag_name)
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

if [[ -z $explicit && $candidate == "$pinned_version" && ${EW_FORCE:-false} != true ]]; then
  skip "latest release $candidate is already pinned"
fi

# A release can appear on GitHub before its image reaches Docker Hub; the next
# scheduled run picks it up.
if ! index=$(docker buildx imagetools inspect "ollama/ollama:$candidate" \
  --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest) ||
  ! [[ $index =~ ^sha256:[0-9a-f]{64}$ ]]; then
  skip "image ollama/ollama:$candidate is not published yet"
fi
emit candidate_image "ollama/ollama:$candidate@$index"

# The harness revision: a changed probe, fingerprint or verdict re-evaluates.
harness=$(cd "$ROOT" && sha256sum \
  .github/workflows/ollama-early-warning.yml \
  scripts/ci/ollama_early_warning*.sh \
  scripts/ci/ollama_early_warning_verdict.ts \
  scripts/embedding-fingerprint.ts \
  scripts/nomic_pin.ts \
  scripts/probe-embedding-runtime.ts | sha256sum | cut -c1-12)
key="ollama-ew-$candidate-${index:7:12}-pin-$pinned_version-${pinned_digest:0:12}"
key+="-model-${model_digest:0:12}-harness-$harness"
emit key "$key"

if [[ ${EW_FORCE:-false} != true && -n ${EW_REPO:-} ]]; then
  found=$(gh api -X GET "repos/$EW_REPO/actions/artifacts" \
    -f name="$key" -f per_page=100 |
    jq --arg branch "${EW_BRANCH:-main}" \
      '[.artifacts[] | select((.expired | not) and
        .workflow_run.head_branch == $branch)] | length')
  if ((found > 0)); then
    skip "$key already has a verdict"
  fi
fi
emit run true
emit reason "evaluate $candidate against pinned $pinned_version"
