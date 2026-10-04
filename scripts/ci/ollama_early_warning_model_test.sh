#!/usr/bin/env bash
# Tests for scripts/ci/ollama_early_warning_model.sh with stubbed curl and gh, in
# a disposable copy of the checkout: a moved tag notifies, an unchanged one does
# not, registry failures, non-manifests and digest disagreements fail the check,
# only trusted delivery markers dedupe, and the report reuses an issue for the
# same upstream manifest. Needs bash 4+, git, jq and deno; no registry access.
# usage: scripts/ci/ollama_early_warning_model_test.sh
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama-ew-model-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
repo=$work/repo
stubs=$work/bin
export STUB_RUNS=$work/runs STUB_LOG=$work/gh.log
mkdir -p "$repo" "$stubs" "$STUB_RUNS"
(cd "$SRC" && git ls-files -co --exclude-standard -z | tar -cf - --null -T -) |
  tar -xf - -C "$repo"

# Two model manifests: the pin is rewritten to the first one's digest.
manifest() {
  printf '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:%s","size":1}]}' "$1"
}
manifest "$(printf 'a%.0s' {1..64})" >"$work/pinned.json"
manifest "$(printf 'b%.0s' {1..64})" >"$work/moved.json"
echo '<html>maintenance</html>' >"$work/html.json"
pinned=$(sha256sum "$work/pinned.json" | cut -c1-64)
moved=$(sha256sum "$work/moved.json" | cut -c1-64)
sed -i "s/\"[0-9a-f]\{64\}\"/\"$pinned\"/" "$repo/scripts/nomic_pin.ts"

cat >"$stubs/curl" <<'EOF'
#!/usr/bin/env bash
head=false out=
while (($#)); do
  case $1 in
    -I) head=true ;;
    -o) out=$2; shift ;;
  esac
  shift
done
if [[ -n ${STUB_CURL_FAIL:-} ]]; then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit 22
fi
# STUB_HEADER_DIGEST overrides the digest header; "omit" leaves it out.
# STUB_HEADER_SHOUT=1 sends upper-case field names with tab and trailing
# whitespace, which HTTP allows.
if [[ $head == true ]]; then
  digest_name='ollama-content-digest: ' push_name='ollama-push-time: ' tail=''
  if [[ -n ${STUB_HEADER_SHOUT:-} ]]; then
    digest_name=$'OLLAMA-CONTENT-DIGEST:\t' push_name=$'OLLAMA-PUSH-TIME:\t' tail=$' \t'
  fi
  {
    printf 'HTTP/2 200\r\n'
    [[ ${STUB_HEADER_DIGEST:-} == omit ]] ||
      printf '%s%s%s\r\n' "$digest_name" \
        "${STUB_HEADER_DIGEST:-$(sha256sum "$STUB_MANIFEST" | cut -c1-64)}" "$tail"
    printf '%s1708536356%s\r\n\r\n' "$push_name" "$tail"
  } >"$out"
else
  cp "$STUB_MANIFEST" "$out"
fi
EOF
cat >"$stubs/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >>"$STUB_LOG"
args="$*"
case "$args" in
  "api -X GET repos/"*"/actions/artifacts "*)
    printf '%s\n' "${STUB_ARTIFACTS:-"{\"artifacts\":[]}"}" ;;
  "api repos/"*"/actions/runs/"*) cat "$STUB_RUNS/${args##*/}.json" ;;
  *) echo "unexpected: gh $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$stubs/curl" "$stubs/gh"

failures=0
model() { (cd "$repo" && PATH="$stubs:$PATH" scripts/ci/ollama_early_warning_model.sh "$@"); }
field() { sed -n "s/^$1=//p"; }
check() {
  local name=$1
  shift
  if "$@"; then echo "ok - $name"; else
    echo "FAIL - $name" >&2
    failures=$((failures + 1))
  fi
}
notify_is() {
  local want=$1 got
  got=$(model check | field notify) || return 1
  [[ $got == "$want" ]]
}
fails() { ! model check >/dev/null 2>&1; }

export STUB_MANIFEST=$work/pinned.json
check "an unchanged tag does not notify" notify_is false
pushed() { [[ $(model check | field push_time) == 2024-02-21T17:25:56Z ]]; }
check "the registry push time is reported" pushed

export STUB_MANIFEST=$work/moved.json
check "a moved tag notifies" notify_is true
keyed() {
  local out
  out=$(model check)
  [[ $(field upstream_digest <<<"$out") == "$moved" &&
    $(field key <<<"$out") == "nomic-ew-${moved:0:12}-pin-${pinned:0:12}" ]]
}
check "a moved tag reports its digest and key" keyed

registry_fails() { STUB_CURL_FAIL=1 fails; }
check "a registry failure fails the check" registry_fails
html() { STUB_MANIFEST=$work/html.json fails; }
check "a non-manifest response fails the check" html
disagree() { STUB_HEADER_DIGEST=$pinned fails; }
check "a header digest that disagrees fails the check" disagree
# A moved tag is only reported with the registry's own corroboration; the
# pinned bytes need none.
moved_header() { STUB_HEADER_DIGEST=$1 fails; }
check "a moved tag without a digest header fails the check" moved_header omit
check "a moved tag with an empty digest header fails the check" moved_header sha256:
check "a moved tag with a malformed digest header fails the check" moved_header "${moved:0:63}"
shouted() {
  local out
  out=$(STUB_HEADER_SHOUT=1 model check) || return 1
  [[ $(field notify <<<"$out") == true &&
    $(field push_time <<<"$out") == 2024-02-21T17:25:56Z ]]
}
check "header names in any case with tab and trailing whitespace are read" shouted
unchanged_no_header() { STUB_MANIFEST=$work/pinned.json STUB_HEADER_DIGEST=omit notify_is false; }
check "the pinned bytes without a digest header do not notify" unchanged_no_header

# Delivery markers dedupe exactly as in the release gate.
w=.github/workflows/ollama-early-warning.yml
marker() {
  local id=$1 head_repo=$2 event=$3
  printf '{"event":"%s","head_branch":"main","path":"%s","head_repository":{"id":%s},"repository":{"id":1}}\n' \
    "$event" "$w" "$head_repo" >"$STUB_RUNS/$id.json"
  printf '{"artifacts":[{"expired":false,"workflow_run":{"id":%s,"repository_id":1,"head_repository_id":%s}}]}' \
    "$id" "$head_repo"
}
with_marker() {
  local want=$1
  shift
  STUB_ARTIFACTS=$(marker "$@") EW_REPO=o/r notify_is "$want"
}
check "a scheduled delivery dedupes" with_marker false 31 1 schedule
check "a pull request artifact does not" with_marker true 32 1 pull_request
forced() { STUB_ARTIFACTS=$(marker 33 1 schedule) EW_REPO=o/r EW_FORCE=true notify_is true; }
check "force ignores a trusted marker" forced
lookup_fails() {
  STUB_ARTIFACTS=$(marker 34 1 schedule)
  rm "$STUB_RUNS/34.json"
  STUB_ARTIFACTS=$STUB_ARTIFACTS EW_REPO=o/r fails
}
check "a failed run lookup fails the check" lookup_fails

# Report: one issue per upstream manifest, reconciled per delivery key against
# the stateful gh stub, as the release lane reconciles per evaluation key.
rbin=$work/rbin
mkdir -p "$rbin"
cp "$SRC/scripts/ci/ollama_early_warning_gh_stub.sh" "$rbin/gh"
export GH_LOG=$work/report.log STATE=$work/issues.json
key="nomic-ew-${moved:0:12}-pin-${pinned:0:12}"
mark="<!-- ollama-ew-key: $key -->"
prefix="Upstream nomic-embed-text:latest moved to manifest ${moved:0:12}"
old_title="$prefix (pinned 000000000000)"

# seed NUMBER STATE [TITLE [COMMENT [COMMENT_AUTHOR]]]: one existing issue.
seed() {
  jq -n --argjson n "$1" --arg s "$2" --arg t "${3:-$old_title}" \
    --arg c "${4:-}" --arg ca "${5:-github-actions[bot]}" \
    '[{number: $n, state: $s, title: $t, body: "earlier report",
       author: "github-actions[bot]", url: "https://github.com/o/r/issues/\($n)",
       comments: (if $c == "" then [] else [{body: $c, author: $ca}] end)}]' >"$STATE"
}
none() { echo "[]" >"$STATE"; }
# report [UPSTREAM]: one delivery attempt; returns the script's status.
report() {
  : >"$GH_LOG"
  (cd "$repo" && PATH="$rbin:$PATH" REPO=o/r MODEL=nomic-embed-text:latest \
    PINNED_DIGEST=$pinned UPSTREAM_DIGEST=${1:-$moved} \
    scripts/ci/ollama_early_warning_model.sh report >/dev/null 2>&1)
}
# state: "<number> <state> <marked texts> <pin in title>" per issue.
state() {
  jq -r --arg m "$mark" '.[] | "\(.number) \(.state) \([.body, .comments[].body] |
    map(select(contains($m))) | length) \(.title | capture("pinned (?<p>[^)]*)").p)"' \
    "$STATE" | paste -sd";" -
}
writes() {
  { grep -E "^issue (create|comment|edit|close|reopen)" "$GH_LOG" || true; } |
    sed "s/ $//" | paste -sd";" -
}
expect() {
  local name=$1 got=$2 want=$3
  if [[ $got == "$want" ]]; then echo "ok - $name"; else
    echo "FAIL - $name: got '$got', want '$want'" >&2
    failures=$((failures + 1))
  fi
}
p12=${pinned:0:12}

none
report
expect "the first report opens an issue carrying the key" "$(state)" "1 OPEN 1 $p12"
report
expect "a retried report writes nothing" "$(writes)" ""

seed 7 CLOSED
report
expect "a new key on a closed issue retitles, reopens and comments" \
  "$(state) / $(writes)" "7 OPEN 1 $p12 / issue edit 7;issue reopen 7;issue comment 7"
report
expect "... and its retry writes nothing" "$(writes)" ""

seed 7 OPEN
report
expect "a new key on an open issue retitles and comments" \
  "$(state) / $(writes)" "7 OPEN 1 $p12 / issue edit 7;issue comment 7"

seed 7 CLOSED "$old_title" "earlier report $mark"
report
expect "an issue closed after a completed delivery stays closed" \
  "$(state) / $(writes)" "7 CLOSED 1 000000000000 / "

for fail in "issue edit" "issue reopen" "issue comment"; do
  seed 7 CLOSED
  first=0
  STUB_FAIL=$fail report || first=$?
  report || true
  expect "a failed ${fail#issue } is completed by the retry" \
    "$([[ $first != 0 ]] && echo failed) $(state)" "failed 7 OPEN 1 $p12"
done

seed 8 OPEN "Upstream nomic-embed-text:latest moved to manifest cccccccccccc (pinned $p12)"
report
expect "another upstream manifest gets its own issue" "$(state)" \
  "8 OPEN 0 $p12;9 OPEN 1 $p12"

seed 7 OPEN "$old_title" "earlier report $mark"
failed=0
STUB_FAIL=api report || failed=$?
expect "a failed issue lookup fails without writing" \
  "$([[ $failed != 0 ]] && echo failed) $(writes)" "failed "

seed 7 CLOSED "$old_title" "forged $mark" mallory
report
expect "an outsider's marker does not suppress the update" "$(writes)" \
  "issue edit 7;issue reopen 7;issue comment 7"

none
failed=0
report "$pinned" || failed=$?
expect "a report for the pinned manifest itself fails without writing" \
  "$([[ $failed != 0 ]] && echo failed) $(writes)" "failed "
invalid() { ! REPO=o/r MODEL="x;id" PINNED_DIGEST=$pinned UPSTREAM_DIGEST=$moved model report >/dev/null 2>&1; }
check "an invalid model fails the report" invalid

if ((failures)); then
  echo "$failures model test(s) failed" >&2
  exit 1
fi
echo "all model tests passed"
