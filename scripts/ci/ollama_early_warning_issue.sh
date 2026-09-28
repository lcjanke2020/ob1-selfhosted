#!/usr/bin/env bash
# Keeps one GitHub issue per candidate Ollama version in step with the early
# warning's delivered verdicts. Used by the notify job of
# .github/workflows/ollama-early-warning.yml.
#
# usage: scripts/ci/ollama_early_warning_issue.sh VERDICT_DIR
#   VERDICT_DIR holds the runner's issue.md.
# Environment (required): REPO (owner/name), VERDICT (compatible, drift or
# broken), CANDIDATE and PINNED (versions), KEY (the evaluation key); gh must be
# authenticated with issues:write. Optional: ISSUE_AUTHOR, the login this
# script writes as (default github-actions[bot], the workflow's GITHUB_TOKEN).
# Prints url=<issue URL or empty>.
#
# drift/broken: the first evaluation opens the issue; a later one updates the
# title, reopens it and comments. compatible: comments on an open issue and
# closes it. Every body and comment carries the evaluation key and is written
# after the state changes, so a retried delivery of a finished update adds
# nothing, and a retry after an interrupted one completes it. Only markers
# written by ISSUE_AUTHOR count: anyone can comment on a public issue, and the
# key is derived from public data.
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

author=${ISSUE_AUTHOR:-github-actions[bot]}
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
# Whether this exact evaluation already reached the issue, judged only from
# text this script's identity wrote (a "[bot]" login cannot belong to a user
# account). Read outside any condition: a failed or
# unreadable lookup must fail the delivery (the next run retries it), not pass
# for "not yet reported" and post a duplicate.
reported=false
if [[ -n $number ]]; then
  issue_json=$(gh api "repos/$REPO/issues/$number")
  comments_json=$(gh api --paginate "repos/$REPO/issues/$number/comments" |
    jq -s 'add // []')
  reported=$(jq -rn --arg m "$marker" --arg author "$author" \
    --argjson issue "$issue_json" --argjson comments "$comments_json" '
    [$issue, $comments[]] |
    map(select(.user.login == $author) | .body // "") |
    any(contains($m))')
  if [[ $reported != true && $reported != false ]]; then
    echo "unexpected issue lookup result" >&2
    exit 1
  fi
fi

if [[ $VERDICT == compatible ]]; then
  if [[ $state == OPEN ]]; then
    [[ $reported == true ]] || comment
    gh issue close "$number" -R "$REPO" --reason completed >/dev/null
  fi
elif [[ -z $number ]]; then
  url=$(body | gh issue create -R "$REPO" --label "$label" --title "$title" \
    --body-file -)
elif [[ $reported != true ]]; then
  # Idempotent state changes first: the marked comment is written last, so
  # its presence means the whole update finished. An interrupted update
  # leaves no marker, and the retry completes it.
  gh issue edit "$number" -R "$REPO" --title "$title" >/dev/null
  if [[ $state == CLOSED ]]; then
    gh issue reopen "$number" -R "$REPO" >/dev/null
  fi
  comment
fi
echo "url=$url"
