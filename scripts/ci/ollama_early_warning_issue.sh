#!/usr/bin/env bash
# Keeps one GitHub issue per candidate Ollama version in step with the early
# warning's delivered verdicts. Used by the notify job of
# .github/workflows/ollama-early-warning.yml.
#
# usage: scripts/ci/ollama_early_warning_issue.sh VERDICT_DIR
#   VERDICT_DIR holds the runner's issue.md.
# Environment (required): REPO (owner/name), VERDICT (compatible, drift or
# broken), CANDIDATE and PINNED (versions), KEY (the evaluation key); gh must be
# authenticated with issues:write. Prints url=<issue URL or empty>.
#
# drift/broken: the first evaluation opens the issue; a later one comments,
# updates the title and reopens it. compatible: comments on an open issue and
# closes it. Every body and comment carries the evaluation key, so retrying the
# delivery of the same evaluation (after a failed Pushover) adds nothing.
set -euo pipefail

dir=${1:?usage: ollama_early_warning_issue.sh VERDICT_DIR}
: "${REPO:?}" "${VERDICT:?}" "${CANDIDATE:?}" "${PINNED:?}" "${KEY:?}"
if ! [[ $VERDICT =~ ^(compatible|drift|broken)$ &&
  $CANDIDATE =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ &&
  $PINNED =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$ &&
  $KEY =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid VERDICT, CANDIDATE, PINNED or KEY" >&2
  exit 1
fi

label=ollama-early-warning
prefix="Ollama $CANDIDATE:"
title="$prefix nomic-embed-text embeddings $VERDICT vs pinned $PINNED"
marker="<!-- ollama-ew-key: $KEY -->"

gh label create "$label" -R "$REPO" --force --color D93F0B \
  --description "Ollama release changes the pinned embeddings" >/dev/null
issue=$(gh issue list -R "$REPO" --state all --label "$label" --limit 500 \
  --json number,state,title,url |
  jq -c --arg p "$prefix" 'map(select(.title | startswith($p))) | first // {}')
number=$(jq -r '.number // empty' <<<"$issue")
state=$(jq -r '.state // empty' <<<"$issue")
url=$(jq -r '.url // empty' <<<"$issue")

body() {
  cat "$dir/issue.md"
  printf '\n%s\n' "$marker"
}
comment() {
  {
    echo "**Re-evaluated** (a new image digest, pin, model or harness revision):"
    echo
    body
  } | gh issue comment "$number" -R "$REPO" --body-file - >/dev/null
}
# Whether this exact evaluation already reached the issue.
reported() {
  gh issue view "$number" -R "$REPO" --json body,comments |
    jq -e --arg m "$marker" '[.body, .comments[].body] | any(contains($m))' \
      >/dev/null
}

if [[ $VERDICT == compatible ]]; then
  if [[ $state == OPEN ]]; then
    reported || comment
    gh issue close "$number" -R "$REPO" --reason completed >/dev/null
  fi
elif [[ -z $number ]]; then
  url=$(body | gh issue create -R "$REPO" --label "$label" --title "$title" \
    --body-file -)
elif ! reported; then
  comment
  gh issue edit "$number" -R "$REPO" --title "$title" >/dev/null
  if [[ $state == CLOSED ]]; then
    gh issue reopen "$number" -R "$REPO" >/dev/null
  fi
fi
echo "url=$url"
