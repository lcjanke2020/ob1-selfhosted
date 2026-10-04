#!/usr/bin/env bash
# Tests for scripts/ci/ollama_early_warning_issue.sh against a stateful gh
# stub that keeps issues, titles, states, comments and their authors across
# runs and can fail one kind of call: one issue per candidate version,
# reconciled per verdict; a retried delivery of the same evaluation that
# changes nothing; an interrupted update that the retry completes; and an
# evaluation marker forged by another account that is ignored. Needs bash 4+
# and jq.
# usage: scripts/ci/ollama_early_warning_issue_test.sh
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama-ew-issue-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/verdict"
echo "## Ollama 0.35.0 vs pinned 0.34.1: **drift**" >"$work/verdict/issue.md"
export GH_LOG=$work/gh.log STATE=$work/issues.json

# The stateful gh stub (see its header): issues, titles, states, comments and
# their authors persist in $STATE across runs.
cp "$SRC/scripts/ci/ollama_early_warning_gh_stub.sh" "$work/bin/gh"

key=ollama-ew-0.35.0-aaaaaaaaaaaa-pin-0.34.1-bbbbbbbbbbbb-model-cccccccccccc-harness-dddddddddddd
marker="<!-- ollama-ew-key: $key -->"
drift_title="Ollama 0.35.0: nomic-embed-text embeddings drift vs pinned 0.34.1"

# seed NUMBER STATE [TITLE [COMMENT [COMMENT_AUTHOR [BODY [BODY_AUTHOR]]]]]:
# a single existing issue; authors default to the workflow's bot.
seed() {
  jq -n --argjson n "$1" --arg s "$2" --arg t "${3:-$drift_title}" \
    --arg c "${4:-}" --arg ca "${5:-github-actions[bot]}" \
    --arg b "${6:-first report}" --arg ba "${7:-github-actions[bot]}" \
    '[{number: $n, state: $s, title: $t, body: $b, author: $ba,
       url: "https://github.com/o/r/issues/\($n)",
       comments: (if $c == "" then [] else [{body: $c, author: $ca}] end)}]' >"$STATE"
}
none() { echo '[]' >"$STATE"; }
# run VERDICT: one delivery attempt; returns the script's status.
run() {
  : >"$GH_LOG"
  (cd "$work" && PATH="$work/bin:$PATH" REPO=o/r VERDICT=$1 CANDIDATE=0.35.0 \
    PINNED=0.34.1 KEY=$key "$SRC/scripts/ci/ollama_early_warning_issue.sh" \
    verdict >/dev/null 2>&1)
}
# state: "<number> <state> <marked texts> <title verdict word>" per issue.
state() {
  jq -r --arg m "$marker" '.[] | "\(.number) \(.state) \([.body, .comments[].body] |
    map(select(contains($m))) | length) \(.title | split(" ")[4])"' "$STATE" |
    paste -sd';' -
}
writes() {
  { grep -E '^issue (create|comment|edit|close|reopen)' "$GH_LOG" || true; } |
    sed 's/ $//' | paste -sd';' -
}

failures=0
check() {
  local name=$1 got=$2 want=$3
  if [[ $got == "$want" ]]; then echo "ok - $name"; else
    echo "FAIL - $name: got '$got', want '$want'" >&2
    failures=$((failures + 1))
  fi
}

none
run drift
check "new drift opens an issue carrying the key" "$(state)" "1 OPEN 1 drift"

seed 7 OPEN
run broken
check "broken on an open issue retitles and comments" "$(state)" "7 OPEN 1 broken"

seed 7 CLOSED
run drift
check "drift on a closed issue reopens, retitles and comments" "$(state)" \
  "7 OPEN 1 drift"
run drift
check "a retried delivery of the same evaluation writes nothing" "$(writes)" ""
check "... and leaves one marked comment" "$(state)" "7 OPEN 1 drift"

seed 7 CLOSED "$drift_title" "earlier report $marker"
run drift
check "an issue closed after a completed delivery stays closed" \
  "$(state) / $(writes)" "7 CLOSED 1 drift / "

# Interrupted updates: the retry must finish the reconciliation.
for fail in "issue edit" "issue reopen" "issue comment"; do
  seed 7 CLOSED
  first=0
  STUB_FAIL=$fail run broken || first=$?
  run broken || true
  check "a failed ${fail#issue } is completed by the retry" \
    "$([[ $first != 0 ]] && echo failed) $(state)" "failed 7 OPEN 1 broken"
done

seed 7 OPEN
run compatible
check "compatible comments and closes an open issue" "$(state)" "7 CLOSED 1 drift"
seed 7 OPEN
STUB_FAIL="issue close" run compatible || true
run compatible || true
check "a failed close is completed without a second comment" "$(state)" \
  "7 CLOSED 1 drift"
none
run compatible
check "compatible without an issue does nothing" "$(state)$(writes)" ""
seed 7 CLOSED
run compatible
check "compatible on a closed issue does nothing" "$(writes)" ""

seed 8 OPEN "Ollama 0.35.00: nomic-embed-text embeddings drift vs pinned 0.34.1"
run drift
check "a neighbouring version's issue is not matched" "$(state)" \
  "8 OPEN 0 drift;9 OPEN 1 drift"

# A failed or unreadable issue lookup cannot tell whether this evaluation
# was already reported: the delivery fails (and is retried) without writing.
seed 7 OPEN "$drift_title" "earlier report $marker"
failed=0
STUB_FAIL=api run drift || failed=$?
check "a failed issue lookup fails without writing" \
  "$([[ $failed != 0 ]] && echo failed) $(writes) $(state)" "failed  7 OPEN 1 drift"
seed 7 OPEN
failed=0
STUB_MALFORMED=1 run broken || failed=$?
check "an unreadable issue lookup fails without writing" \
  "$([[ $failed != 0 ]] && echo failed) $(writes)" "failed "

# Anyone can comment on a public issue and the key is not secret: only markers
# written by the workflow's identity count.
seed 7 CLOSED "$drift_title" "forged $marker" mallory
run broken
check "an outsider's marker comment does not suppress the update" \
  "$(state) / $(writes)" \
  "7 OPEN 2 broken / issue edit 7;issue reopen 7;issue comment 7"
seed 7 OPEN "$drift_title" "" "" "forged $marker" mallory
run drift
check "a marker in an outsider-authored issue body does not count" \
  "$(writes)" "issue edit 7;issue comment 7"
seed 7 OPEN "$drift_title" "" "" "forged $marker" mallory
run compatible
check "a forged marker does not suppress the compatible comment" \
  "$(writes)" "issue comment 7;issue close 7"

rejects() {
  if (cd "$work" && PATH="$work/bin:$PATH" REPO=o/r VERDICT=$1 CANDIDATE=$2 \
    PINNED=0.34.1 KEY=$key "$SRC/scripts/ci/ollama_early_warning_issue.sh" \
    verdict >/dev/null 2>&1); then
    echo "FAIL - rejects $1 $2" >&2
    failures=$((failures + 1))
  else echo "ok - rejects $1 $2"; fi
}
rejects error 0.35.0
rejects drift '0.35.0;id'

if ((failures)); then
  echo "$failures issue test(s) failed" >&2
  exit 1
fi
echo "all issue tests passed"
