#!/usr/bin/env bash
# Smoke test for .githooks/pre-commit. Builds a throwaway git repo, copies in the
# hook + the shared pattern file, stages probe content, and asserts the hook
# blocks (exit 1) or passes (exit 0) as expected. Covers the regressions found in
# review: credential coverage, leading-'+' content, and fail-closed denylist.
#
# Run:  .githooks/test-pre-commit.sh   (exit 0 = all cases passed)
set -uo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"            # repo root (this file lives in .githooks/)
hook="$src/.githooks/pre-commit"
patterns="$src/.github/leak-patterns.txt"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q
mkdir -p "$work/.githooks" "$work/.github"
cp "$hook" "$work/.githooks/pre-commit"; chmod +x "$work/.githooks/pre-commit"
cp "$patterns" "$work/.github/leak-patterns.txt"

pass=0 failcnt=0
# run_case <description> <expected: block|allow> <filename> <content> [denylist-content]
run_case() {
  desc="$1"; expect="$2"; file="$3"; content="$4"; denylist="${5-}"
  # Reset only the probe artifacts — never the copied-in hook / pattern file.
  # The hook reads .leak-denylist from the working tree, so it only needs to
  # exist on disk; just the probe file is staged.
  ( cd "$work"
    git reset -q >/dev/null 2>&1 || true
    rm -f "$file" .leak-denylist
    [ -n "$denylist" ] && printf '%s\n' "$denylist" > .leak-denylist
    printf '%s\n' "$content" > "$file"
    git add "$file" >/dev/null 2>&1 )

  out="$( cd "$work" && ./.githooks/pre-commit 2>&1 )" && got=allow || got=block

  if [ "$got" = "$expect" ]; then
    printf '  ok   %-48s (%s)\n' "$desc" "$got"; pass=$((pass + 1))
  else
    printf '  FAIL %-48s expected %s, got %s\n' "$desc" "$expect" "$got"; failcnt=$((failcnt + 1))
    printf '%s\n' "$out" | sed 's/^/        > /'   # show hook output to debug the mismatch
  fi
}

SK="sk-ant-abcdefghijklmnopqrstuvwxyz012345"

run_case "clean content"                 allow notes.md "just some ordinary prose"
run_case "credential (sk-ant)"           block notes.md "token: $SK"
run_case "github token"                  block notes.md "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
run_case "private IP 10/8"               block notes.md "db at 10.0.0.5 listens"
run_case "tailnet IP 100.64/10"          block notes.md "peer 100.64.1.2 up"
run_case "internal ticket LEO-<n>"       block notes.md "fixes LEO-1234"
run_case "leading-+ content w/ secret"   block notes.md "+$SK"
run_case "placeholder passes"            allow notes.md "use <tailnet-ip> and tailnet-name.ts.net"
run_case "denylist hit"                  block notes.md "host myhost-db online"  "myhost-db"
run_case "denylist clean"                allow notes.md "nothing to see"          "myhost-db"
run_case "invalid denylist regex"        block notes.md "anything"               "foo[bar"

# Invalid SHARED pattern file must also fail closed (it's the single source of
# truth for both scanners). Corrupt a copy, run, then restore.
( cd "$work"
  git reset -q >/dev/null 2>&1 || true
  rm -f notes.md .leak-denylist
  printf 'just text\n' > notes.md
  printf 'foo[bar\n' >> .github/leak-patterns.txt
  git add notes.md >/dev/null 2>&1 )
out="$( cd "$work" && ./.githooks/pre-commit 2>&1 )" && got=allow || got=block
cp "$patterns" "$work/.github/leak-patterns.txt"   # restore for any later use
if [ "$got" = block ]; then
  printf '  ok   %-48s (%s)\n' "invalid shared pattern file" "$got"; pass=$((pass + 1))
else
  printf '  FAIL %-48s expected block, got %s\n' "invalid shared pattern file" "$got"; failcnt=$((failcnt + 1))
  printf '%s\n' "$out" | sed 's/^/        > /'
fi

echo
if [ "$failcnt" -eq 0 ]; then
  echo "All $pass cases passed."
  exit 0
else
  echo "$failcnt case(s) FAILED ($pass passed)."
  exit 1
fi
