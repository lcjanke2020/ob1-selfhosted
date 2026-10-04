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
if [[ $head == true ]]; then
  printf 'HTTP/2 200\r\nollama-content-digest: %s\r\nollama-push-time: 1708536356\r\n\r\n' \
    "${STUB_HEADER_DIGEST:-$(sha256sum "$STUB_MANIFEST" | cut -c1-64)}" >"$out"
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
  "label create "*) ;;
  "issue list "*) printf '%s\n' "${STUB_ISSUES:-[]}" ;;
  "issue create "*) cat >/dev/null; echo "https://github.com/o/r/issues/99" ;;
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

# Report: one issue per upstream manifest.
report() {
  REPO=o/r MODEL=nomic-embed-text:latest PINNED_DIGEST=$pinned \
    UPSTREAM_DIGEST=$moved model report
}
creates() {
  : >"$STUB_LOG"
  [[ $(report | field url) == https://github.com/o/r/issues/99 ]] &&
    grep -q "^gh issue create .*--title Upstream nomic-embed-text:latest moved to manifest ${moved:0:12} (pinned ${pinned:0:12})" "$STUB_LOG"
}
reuses() {
  local existing="https://github.com/o/r/issues/7"
  : >"$STUB_LOG"
  [[ $(STUB_ISSUES="[{\"title\":\"Upstream nomic-embed-text:latest moved to manifest ${moved:0:12} (pinned 000000000000)\",\"url\":\"$existing\"}]" \
    report | field url) == "$existing" ]] && ! grep -q "issue create" "$STUB_LOG"
}
other_manifest() {
  : >"$STUB_LOG"
  STUB_ISSUES='[{"title":"Upstream nomic-embed-text:latest moved to manifest cccccccccccc (pinned x)","url":"u"}]' \
    report >/dev/null && grep -q "issue create" "$STUB_LOG"
}
invalid() { ! REPO=o/r MODEL='x;id' PINNED_DIGEST=$pinned UPSTREAM_DIGEST=$moved model report >/dev/null 2>&1; }
check "the first report opens an issue" creates
check "a retried report reuses the issue" reuses
check "another upstream manifest gets its own issue" other_manifest
check "an invalid model fails the report" invalid

if ((failures)); then
  echo "$failures model test(s) failed" >&2
  exit 1
fi
echo "all model tests passed"
