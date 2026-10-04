#!/usr/bin/env bash
# Shared by the Ollama early-warning gates, runner and tests. Source it; it
# defines ROOT relative to this file, the version and image patterns, the
# pinned-image lookup, the delivery-marker lookup and the harness inputs. It is
# not a standalone script.
# shellcheck disable=SC2034 # the patterns are used by the sourcing scripts

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$'
IMAGE_RE='^ollama/ollama:([0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?)@sha256:([0-9a-f]{64})$'
WORKFLOW=.github/workflows/ollama-early-warning.yml

# Prints the digest-pinned ollama image both Compose stacks deploy. A bump must
# update them together, so a disagreement is an error.
pinned_image() {
  local pins
  pins=$(grep -hoE 'image: ollama/ollama:[^[:space:]]+' \
    "$ROOT/deploy/compose-local/docker-compose.yml" \
    "$ROOT/deploy/qubes/app-qube/docker-compose.yml" |
    sed 's/^image: //' | sort -u)
  if [[ $(wc -l <<<"$pins") -ne 1 ]] || ! [[ $pins =~ $IMAGE_RE ]]; then
    echo "Compose files disagree on a digest-pinned ollama image:" >&2
    echo "$pins" >&2
    return 1
  fi
  echo "$pins"
}

# Sets DELIVERED_RUN to the id of a trusted run that uploaded the delivery
# marker delivered-KEY, or to nothing. The dedupe record is the marker that a
# notify job uploads after every notification succeeded, not the verdict: a
# failed delivery is retried. Only a marker from a scheduled or manual run of
# this workflow, in this repository and on the trusted branch, counts; a pull
# request (including one from a fork branch named main) can upload an artifact
# under any name. Call it as a plain statement under `set -e` (not inside $()
# or a condition), so an API or parse failure fails the caller rather than
# reading as an untrusted marker.
# usage: find_delivery REPO BRANCH KEY
find_delivery() {
  local repo=$1 branch=$2 key=$3 runs run details trusted
  DELIVERED_RUN=
  runs=$(gh api -X GET "repos/$repo/actions/artifacts" \
    -f name="delivered-$key" -f per_page=100 |
    jq -r '.artifacts[] | select((.expired | not) and
      .workflow_run.head_repository_id == .workflow_run.repository_id) |
      .workflow_run.id')
  for run in $runs; do
    [[ $run =~ ^[0-9]+$ ]] || continue
    details=$(gh api "repos/$repo/actions/runs/$run")
    trusted=$(jq -r --arg branch "$branch" --arg path "$WORKFLOW" '
      (.event == "schedule" or .event == "workflow_dispatch") and
      .head_branch == $branch and (.path | split("@")[0]) == $path and
      .head_repository.id == .repository.id' <<<"$details")
    if [[ $trusted == true ]]; then
      DELIVERED_RUN=$run
      return 0
    fi
  done
}

# Prints, one repository path per line, every file whose content defines a
# measurement: the entry scripts with every local module they import (dynamic
# imports included, so the server's embedder, chunker, runtime canaries and
# configuration), the Deno configuration and lockfile, the workflow and the
# shell runners. The evaluation key hashes exactly these files, and the
# workflow's pull_request paths must cover them (see the gate test).
harness_inputs() {
  local entry
  {
    for entry in scripts/embedding-fingerprint.ts \
      scripts/probe-embedding-runtime.ts \
      scripts/ci/ollama_early_warning_verdict.ts; do
      (cd "$ROOT" && deno info --json --frozen --config server/deno.json "$entry") |
        jq -r --arg root "file://$ROOT/" \
          '.modules[].specifier | select(startswith($root)) | ltrimstr($root)'
    done
    printf '%s\n' server/deno.json server/deno.lock "$WORKFLOW" \
      scripts/ci/ollama_early_warning.sh \
      scripts/ci/ollama_early_warning_common.sh \
      scripts/ci/ollama_early_warning_gate.sh
  } | sort -u
}
