#!/usr/bin/env bash
# Shared by the Ollama early-warning gate and runner. Source it; it defines
# ROOT relative to this file, the version and image patterns and the
# pinned-image lookup. It is not a standalone script.
# shellcheck disable=SC2034 # the patterns are used by the sourcing scripts

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$'
IMAGE_RE='^ollama/ollama:([0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?)@sha256:([0-9a-f]{64})$'

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
