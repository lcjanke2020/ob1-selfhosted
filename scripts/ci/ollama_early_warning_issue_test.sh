#!/usr/bin/env bash
# Tests for scripts/ci/ollama_early_warning_issue.sh with a recording gh stub:
# one issue per candidate version, reconciled per verdict, and a retried
# delivery of the same evaluation that changes nothing. Needs bash 4+ and jq.
# usage: scripts/ci/ollama_early_warning_issue_test.sh
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama-ew-issue-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/verdict"
echo "## Ollama 0.35.0 vs pinned 0.34.1: **drift**" >"$work/verdict/issue.md"
export GH_LOG=$work/gh.log

cat >"$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
number=${3:-}
[[ $number =~ ^[0-9]+$ ]] || number=
echo "$1 $2 $number" >>"$GH_LOG"
unseen='{"body":"","comments":[]}'
case "$1 $2" in
  "issue list") printf '%s\n' "${STUB_ISSUES:-[]}" ;;
  "issue view") printf '%s\n' "${STUB_VIEW:-$unseen}" ;;
  "issue create") cat >"$GH_LOG.body"; echo "https://github.com/o/r/issues/99" ;;
  "issue comment") cat >"$GH_LOG.body" ;;
esac
EOF
chmod +x "$work/bin/gh"

key=ollama-ew-0.35.0-aaaaaaaaaaaa-pin-0.34.1-bbbbbbbbbbbb-model-cccccccccccc-harness-dddddddddddd
marker="<!-- ollama-ew-key: $key -->"
issue() { # number state [title]
  printf '[{"number":%s,"state":"%s","title":"%s","url":"https://github.com/o/r/issues/%s"}]' \
    "$1" "$2" "${3:-Ollama 0.35.0: nomic-embed-text embeddings drift vs pinned 0.34.1}" "$1"
}
seen() { printf '{"body":"old","comments":[{"body":"x\\n%s\\n"}]}' "$marker"; }

failures=0
# Runs the script for a verdict and compares the gh write calls it made.
expect() {
  local name=$1 verdict=$2 want=$3 got
  : >"$GH_LOG"
  if ! (cd "$work" && PATH="$work/bin:$PATH" REPO=o/r VERDICT=$verdict \
    CANDIDATE=0.35.0 PINNED=0.34.1 KEY=$key \
    "$SRC/scripts/ci/ollama_early_warning_issue.sh" verdict >"$work/out"); then
    echo "FAIL - $name (script failed)" >&2
    failures=$((failures + 1))
    return
  fi
  got=$({ grep -E '^issue (create|comment|edit|close|reopen)' "$GH_LOG" || true; } |
    cut -d' ' -f1-3 | paste -sd';' -)
  if [[ $got == "$want" ]]; then echo "ok - $name"; else
    echo "FAIL - $name: got '$got', want '$want'" >&2
    failures=$((failures + 1))
  fi
}
body_has_marker() {
  if grep -qF "$marker" "$GH_LOG.body"; then echo "ok - $1"; else
    echo "FAIL - $1" >&2
    failures=$((failures + 1))
  fi
}

STUB_ISSUES='[]' expect "new drift opens an issue" drift "issue create "
body_has_marker "the new issue carries the evaluation key"
STUB_ISSUES=$(issue 7 OPEN) expect "drift on an open issue comments and retitles" \
  drift "issue comment 7;issue edit 7"
body_has_marker "the comment carries the evaluation key"
STUB_ISSUES=$(issue 7 CLOSED) expect "broken on a closed issue also reopens" \
  broken "issue comment 7;issue edit 7;issue reopen 7"
STUB_ISSUES=$(issue 7 OPEN) STUB_VIEW=$(seen) \
  expect "a retried drift delivery changes nothing" drift ""
STUB_ISSUES=$(issue 7 CLOSED) STUB_VIEW=$(seen) \
  expect "a retried delivery does not reopen a closed issue" broken ""
STUB_ISSUES=$(issue 7 OPEN) expect "compatible comments and closes" \
  compatible "issue comment 7;issue close 7"
STUB_ISSUES=$(issue 7 OPEN) STUB_VIEW=$(seen) \
  expect "a retried compatible delivery only closes" compatible "issue close 7"
STUB_ISSUES='[]' expect "compatible without an issue does nothing" compatible ""
STUB_ISSUES=$(issue 7 CLOSED) expect "compatible on a closed issue does nothing" \
  compatible ""
STUB_ISSUES=$(issue 8 OPEN "Ollama 0.35.00: nomic-embed-text embeddings drift vs pinned 0.34.1") \
  expect "a neighbouring version's issue is not matched" drift "issue create "

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
