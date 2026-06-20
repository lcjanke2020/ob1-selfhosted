# Git hooks

## `pre-commit` — leak guard

Blocks a commit if it introduces, into staged content:

- anything matching the **shared leak-gate pattern set** — credential/key material
  (`sk-…`, `ghp_…`, `AKIA…`, PEM private keys, `tskey-…`, Slack/JWT tokens, …),
  private/tailnet IPs (`10/8`, `192.168/16`, `172.16/12`, `100.64/10`), real
  `*.ts.net` tailnet names, and internal refs (`LEO-<n>`, private tracker links); or
- any **custom string** you list in a local `.leak-denylist` (e.g. your real hostnames).

The built-in set is **the same file the CI gate reads** —
[`.github/leak-patterns.txt`](../.github/leak-patterns.txt) — so the local hook and
CI can't drift. It's a courtesy mirror, not a security control (this project doesn't
rely on obscurity), just a way to keep a clone from accidentally shipping a secret or
home-network specifics before CI catches it.

> Patterns are kept portable across GNU grep (CI) and BSD grep (macOS), so the hook
> behaves the same on a Mac clone as it does in CI.

### Enable (once per clone)

```sh
git config core.hooksPath .githooks
```

Git does not auto-run hooks shipped in a clone, so each contributor opts in with that one command.

### Custom hostname/string denylist (stays local)

Copy the example and add your own internal hostnames — **the real list is gitignored and never committed**:

```sh
cp .leak-denylist.example .leak-denylist
$EDITOR .leak-denylist
```

One extended-regex per line; a full-line (optionally indented) `#` is a comment — a
`#` mid-line is part of the pattern. Matching is case-insensitive. If `.leak-denylist`
is absent, the shared built-in checks still run (the hostname check is skipped with a
note); a **malformed** regex in the file blocks the commit with a clear message rather
than silently disabling the check.

### Bypass

For an intentional commit (e.g. documenting a public CIDR), skip the hook:

```sh
git commit --no-verify
```

### Verify the hook

A self-contained smoke test builds a throwaway repo and checks the block/allow
behaviour (credentials, IPs, leading-`+` content, denylist, malformed regex):

```sh
.githooks/test-pre-commit.sh
```
