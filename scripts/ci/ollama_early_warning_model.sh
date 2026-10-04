#!/usr/bin/env bash
# Early warning for a re-published Nomic model: compares the manifest that the
# Ollama registry serves for the pinned model tag with the pinned manifest
# digest, without pulling the model. Used by the model-gate and model-notify
# jobs of .github/workflows/ollama-early-warning.yml.
#
# The embedding contract hashes the model manifest digest, and the registry does
# not serve an earlier manifest by digest. Once the tag moves, a deployment that
# pulls the model again rejects every capture and search until a full rebuild,
# and existing model stores are the only copies of the pinned model.
#
# usage: scripts/ci/ollama_early_warning_model.sh check
#   Prints `key=value` lines for GITHUB_OUTPUT: model, pinned_digest,
#   upstream_digest, push_time (when the registry reports one), then either
#   notify=false with a reason, or key and notify=true. Any failure to establish
#   the answer (registry, malformed manifest, digest disagreement, dependency
#   lookup) exits nonzero, so a scheduled check can never pass without checking.
#   Environment: EW_FORCE=true notifies even when this upstream manifest was
#   already delivered; EW_REPO and EW_BRANCH as for the gate (see find_delivery).
# usage: scripts/ci/ollama_early_warning_model.sh report
#   Opens the issue for this upstream manifest, or reuses the one an earlier,
#   partly delivered run opened. Prints url=<issue URL>. Environment (required):
#   REPO, MODEL, PINNED_DIGEST, UPSTREAM_DIGEST; optional: PUSH_TIME, RUN_URL.
#   gh must be authenticated with issues:write.
# Requires curl, jq, sha256sum, deno and (for dedupe and report) gh.
set -euo pipefail
# shellcheck source=scripts/ci/ollama_early_warning_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/ollama_early_warning_common.sh"

REGISTRY=https://registry.ollama.ai
MODEL_RE='^([a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$'
DIGEST_RE='^[0-9a-f]{64}$'
LABEL=ollama-early-warning

emit() { printf '%s=%s\n' "$1" "$2"; }

check() {
  local pin model pinned name tag url work digest header push_time key
  pin=$(deno run "$ROOT/scripts/nomic_pin.ts")
  model=$(jq -r .model <<<"$pin")
  pinned=$(jq -r .digest <<<"$pin")
  if ! [[ $model =~ $MODEL_RE && $pinned =~ $DIGEST_RE ]]; then
    echo "unexpected model pin: $pin" >&2
    exit 1
  fi
  name=${model%:*}
  tag=${model##*:}
  [[ $name == */* ]] || name=library/$name
  url="$REGISTRY/v2/$name/manifests/$tag"

  work=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: work is local
  trap "rm -rf '$work'" EXIT
  local accept='Accept: application/vnd.docker.distribution.manifest.v2+json'
  curl -fsS --max-time 60 --retry 2 -H "$accept" -o "$work/manifest" "$url"
  # Only a HEAD response carries the registry's own digest and push time. A tag
  # moved between the two requests fails the cross-check; the next run settles.
  curl -fsS --max-time 60 --retry 2 -H "$accept" -I -o "$work/headers" "$url"
  # Ollama identifies a model by the sha256 of the manifest bytes as served.
  digest=$(sha256sum "$work/manifest" | cut -c1-64)
  # Something other than a model manifest (an error page, an empty body) must
  # not read as a moved tag.
  if ! jq -e '.schemaVersion == 2 and
      any(.layers[]?; .mediaType == "application/vnd.ollama.image.model")' \
    "$work/manifest" >/dev/null 2>&1; then
    echo "$url did not return an Ollama model manifest" >&2
    exit 1
  fi
  header=$(tr -d '\r' <"$work/headers" |
    sed -n 's/^[Oo]llama-[Cc]ontent-[Dd]igest: *//p' | tail -n 1)
  header=${header#sha256:}
  if [[ -n $header && $header != "$digest" ]]; then
    echo "registry reports digest $header but the manifest hashes to $digest" >&2
    exit 1
  fi
  push_time=$(tr -d '\r' <"$work/headers" |
    sed -n 's/^[Oo]llama-[Pp]ush-[Tt]ime: *//p' | tail -n 1)

  emit model "$model"
  emit pinned_digest "$pinned"
  emit upstream_digest "$digest"
  if [[ $push_time =~ ^[0-9]+$ ]]; then
    emit push_time "$(date -u -d "@$push_time" +%Y-%m-%dT%H:%M:%SZ)"
  fi
  if [[ $digest == "$pinned" ]]; then
    emit notify false
    emit reason "upstream $model still serves the pinned manifest ${pinned:0:12}"
    exit 0
  fi
  key="nomic-ew-${digest:0:12}-pin-${pinned:0:12}"
  emit key "$key"
  if [[ ${EW_FORCE:-false} != true && -n ${EW_REPO:-} ]]; then
    find_delivery "$EW_REPO" "${EW_BRANCH:-main}" "$key"
    if [[ -n $DELIVERED_RUN ]]; then
      emit notify false
      emit reason "upstream manifest ${digest:0:12} was already reported (run $DELIVERED_RUN)"
      exit 0
    fi
  fi
  emit notify true
  emit reason "upstream $model moved to manifest ${digest:0:12}, pinned ${pinned:0:12}"
}

# shellcheck disable=SC2153 # MODEL and the digests come from the environment
body() {
  local pushed=""
  [[ -z ${PUSH_TIME:-} ]] || pushed=" (pushed $PUSH_TIME)"
  cat <<EOF
## Upstream \`$MODEL\` no longer matches the pin

The Ollama registry now serves manifest \`$UPSTREAM_DIGEST\`$pushed for
\`$MODEL\`. The deployments and this workflow pin \`$PINNED_DIGEST\`
(\`scripts/nomic_pin.ts\`).

### What this means

- The server's embedding contract includes the model manifest digest. A 1.29+
  deployment that pulls the model again (\`ollama pull nomic-embed-text\`, as the
  install guides say) gets the new manifest and rejects every capture and search
  (\`write=not_started\`) until a full backfill re-embeds the corpus. A relabel
  cannot adopt a manifest change.
- A new installation gets the new manifest.
- The registry does not serve the pinned manifest by digest, so existing model
  stores are now the only copies of the pinned model. Do not pull this model on
  a deployment, and back up an Ollama model store before changing anything.
- Until the pin moves, an Ollama release evaluation that has to fetch the model
  again (its cached store expired) reports \`error\`.

### Next steps

Adopting the new manifest is a deliberate migration: update
\`scripts/nomic_pin.ts\` and run the full rebuild (docs/embedding-limits.md,
*Compose backfill runner*). Close this issue once the pin is updated or the
registry serves the pinned manifest again.
EOF
  [[ -z ${RUN_URL:-} ]] || printf '\nRun: %s\n' "$RUN_URL"
}

report() {
  : "${REPO:?}" "${MODEL:?}" "${PINNED_DIGEST:?}" "${UPSTREAM_DIGEST:?}"
  if ! [[ $MODEL =~ $MODEL_RE && $PINNED_DIGEST =~ $DIGEST_RE &&
    $UPSTREAM_DIGEST =~ $DIGEST_RE ]]; then
    echo "invalid MODEL, PINNED_DIGEST or UPSTREAM_DIGEST" >&2
    exit 1
  fi
  local prefix title url
  prefix="Upstream $MODEL moved to manifest ${UPSTREAM_DIGEST:0:12}"
  title="$prefix (pinned ${PINNED_DIGEST:0:12})"
  gh label create "$LABEL" -R "$REPO" --force --color D93F0B \
    --description "Ollama release changes the pinned embeddings" >/dev/null
  # One issue per upstream manifest, in any state: a retried delivery (or a
  # forced run) reuses it instead of opening another. Only collaborators can
  # label issues, so a matching labelled title is this workflow's own.
  url=$(gh issue list -R "$REPO" --state all --label "$LABEL" --limit 500 \
    --json title,url |
    jq -r --arg p "$prefix" 'map(select(.title | startswith($p))) | first | .url // empty')
  if [[ -z $url ]]; then
    url=$(body | gh issue create -R "$REPO" --label "$LABEL" --title "$title" \
      --body-file -)
  fi
  emit url "$url"
}

case ${1:-} in
  check) check ;;
  report) report ;;
  *)
    grep '^# usage:' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2
    exit 2
    ;;
esac
