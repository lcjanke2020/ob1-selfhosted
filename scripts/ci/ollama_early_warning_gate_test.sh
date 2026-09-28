#!/usr/bin/env bash
# Tests for scripts/ci/ollama_early_warning_gate.sh with stubbed gh and docker,
# in a disposable copy of the checkout: the evaluation key follows every
# measured file, registry and release failures fail the gate, the pin check is
# digest-aware, only trusted delivery markers dedupe, and the workflow's
# pull_request paths cover every harness input. Needs bash 4+, git, jq and
# deno (for the dependency graph); no Docker and no registry access.
# usage: scripts/ci/ollama_early_warning_gate_test.sh
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ollama-ew-gate-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
repo=$work/repo
stubs=$work/bin
export STUB_RUNS=$work/runs
mkdir -p "$repo" "$stubs" "$STUB_RUNS"
(cd "$SRC" && git ls-files -co --exclude-standard -z | tar -cf - --null -T -) |
  tar -xf - -C "$repo"

cat >"$stubs/gh" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "api repos/ollama/ollama/releases/latest")
    if [[ -n ${STUB_RELEASES_FAIL:-} ]]; then echo "HTTP 503" >&2; exit 1; fi
    printf '{"tag_name":"%s"}\n' "${STUB_LATEST:-v0.34.4}" ;;
  "api -X GET repos/"*"/actions/artifacts "*)
    printf '%s\n' "${STUB_ARTIFACTS:-"{\"artifacts\":[]}"}" ;;
  "api repos/"*"/actions/runs/"*) cat "$STUB_RUNS/${args##*/}.json" ;;
  *) echo "unexpected: gh $*" >&2; exit 1 ;;
esac
EOF
cat >"$stubs/docker" <<'EOF'
#!/usr/bin/env bash
case "${STUB_IMAGETOOLS:-ok}" in
  ok) printf '{"digest":"%s"}\n' "$STUB_DIGEST" ;;
  notfound) echo "ERROR: docker.io/ollama/ollama:x: not found" >&2; exit 1 ;;
  outage)
    echo 'ERROR: failed to do request: Head "https://registry-1.docker.io/v2/ollama/ollama/manifests/x": 503 Service Unavailable' >&2
    exit 1 ;;
esac
EOF
chmod +x "$stubs/gh" "$stubs/docker"

# shellcheck source=scripts/ci/ollama_early_warning_common.sh
source "$repo/scripts/ci/ollama_early_warning_common.sh"
pinned=$(pinned_image)
pinned_digest=sha256:${pinned##*@sha256:}
pinned_version=${pinned#ollama/ollama:}
pinned_version=${pinned_version%@*}
STUB_DIGEST=sha256:$(printf 'c%.0s' {1..64})
export STUB_DIGEST

failures=0
gate() { (cd "$repo" && PATH="$stubs:$PATH" scripts/ci/ollama_early_warning_gate.sh "$@"); }
field() { sed -n "s/^$1=//p"; }
check() {
  local name=$1
  shift
  if "$@"; then echo "ok - $name"; else
    echo "FAIL - $name" >&2
    failures=$((failures + 1))
  fi
}
run_is() {
  local want=$1 got
  shift
  got=$(gate "$@" | field run) || return 1
  [[ $got == "$want" ]]
}
fails() { ! gate "$@" >/dev/null 2>&1; }

# The key follows every file the measurement executes or configures.
key_follows() {
  local file=$1 edit=$2 before after
  before=$(gate 0.34.4 | field key)
  cp "$repo/$file" "$work/saved"
  sed -i "$edit" "$repo/$file"
  after=$(gate 0.34.4 | field key)
  cp "$work/saved" "$repo/$file"
  [[ -n $before && $before != "$after" ]]
}
check "key changes with the server chunker" key_follows \
  server/embedding_index.ts 's/INITIAL_CHUNK_UNITS = 4096/INITIAL_CHUNK_UNITS = 2048/'
check "key changes with the runtime canaries" key_follows \
  server/embedding_runtime.ts 's/UNCASED_MIN_COSINE = 0.999/UNCASED_MIN_COSINE = 0.99/'
check "key changes with a transitive config module" key_follows \
  server/runtime_config.ts '1s/^/\/\/ edited\n/'
# shellcheck disable=SC2016 # a sed script, not a shell expansion
check "key changes with the lockfile" key_follows server/deno.lock '$a\ '

# Every harness input triggers the pull request lane.
# shellcheck disable=SC2016 # TypeScript source, not a shell expansion
paths_cover_inputs() {
  harness_inputs | (cd "$repo" && deno eval --config server/deno.json --frozen '
    import { parse } from "@std/yaml";
    import { globToRegExp } from "@std/path";
    const workflow = parse(
      Deno.readTextFileSync(".github/workflows/ollama-early-warning.yml"),
    ) as { on: { pull_request: { paths: string[] } } };
    const patterns = workflow.on.pull_request.paths.map((p) =>
      globToRegExp(p, { extended: true, globstar: true })
    );
    const inputs = (await new Response(Deno.stdin.readable).text()).trim()
      .split("\n");
    const missing = inputs.filter((f) => !patterns.some((re) => re.test(f)));
    if (missing.length) {
      console.error(`not in pull_request.paths: ${missing.join(", ")}`);
      Deno.exit(1);
    }')
}
check "pull_request paths cover every harness input" paths_cover_inputs

# Registry and release lookups: only a definite not-found skips.
not_published() {
  [[ $(STUB_IMAGETOOLS=notfound gate 0.34.4 | field reason) == *"not published"* ]]
}
outage() { STUB_IMAGETOOLS=outage fails 0.34.4; }
release_lookup_fails() { STUB_RELEASES_FAIL=1 fails; }
check "an unpublished image skips" not_published
check "a registry outage fails the gate" outage
check "a release lookup failure fails the gate" release_lookup_fails
check "an invalid candidate fails the gate" fails '0.34.4;id'

# The pin check compares the digest, not just the version.
latest_pinned() { STUB_LATEST=v$pinned_version STUB_DIGEST=$1 run_is "$2"; }
check "the pinned version and digest skip" latest_pinned "$pinned_digest" false
check "a re-published pinned tag runs" latest_pinned "$STUB_DIGEST" true

# Delivery markers: only this workflow's trusted runs on main count.
marker() {
  local id=$1 head_repo=$2 event=$3 branch=$4 path=$5 expired=${6:-false}
  printf '{"event":"%s","head_branch":"%s","path":"%s","head_repository":{"id":%s},"repository":{"id":1}}\n' \
    "$event" "$branch" "$path" "$head_repo" >"$STUB_RUNS/$id.json"
  printf '{"artifacts":[{"expired":%s,"workflow_run":{"id":%s,"repository_id":1,"head_repository_id":%s,"head_branch":"%s"}}]}' \
    "$expired" "$id" "$head_repo" "$branch"
}
w=$WORKFLOW
with_marker() {
  local want=$1
  shift
  STUB_ARTIFACTS=$(marker "$@") EW_REPO=o/r run_is "$want" 0.34.4
}
check "a scheduled delivery on main dedupes" with_marker false 11 1 schedule main "$w"
check "a manual delivery with a ref-suffixed path dedupes" \
  with_marker false 12 1 workflow_dispatch main "$w@refs/heads/main"
check "a fork artifact on a branch named main does not" \
  with_marker true 13 999 pull_request main "$w"
check "a same-repository pull request artifact does not" \
  with_marker true 14 1 pull_request main "$w"
check "a manual run on another branch does not" \
  with_marker true 15 1 workflow_dispatch tmp/x "$w"
check "another workflow's artifact does not" \
  with_marker true 16 1 schedule main .github/workflows/other.yml
check "an expired marker does not" with_marker true 17 1 schedule main "$w" true
forced() { STUB_ARTIFACTS=$(marker 18 1 schedule main "$w") EW_REPO=o/r EW_FORCE=true run_is true 0.34.4; }
check "force ignores a trusted marker" forced

if ((failures)); then
  echo "$failures gate test(s) failed" >&2
  exit 1
fi
echo "all gate tests passed"
