# Git hooks

## `pre-commit` — leak guard

Blocks a commit if it introduces, into tracked content:

- a **Tailscale CGNAT IP** (the `100.64/10` range — your tailnet addresses),
- an **internal ticket reference** (`LEO-` followed by a number — reference a GitHub issue instead), or
- any **custom string** you list in a local `.leak-denylist` (e.g. your real hostnames).

It's a courtesy mirror of the repo's CI identifier scan — not a security control (this project doesn't rely on obscurity), just a way to keep a clone from accidentally shipping home-network specifics.

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

One extended-regex per line; `#` starts a comment. If `.leak-denylist` is absent, the built-in IP and ticket checks still run (the hostname check is skipped with a note).

### Bypass

For an intentional commit (e.g. documenting a public CIDR), skip the hook:

```sh
git commit --no-verify
```
