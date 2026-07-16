# Contributing

Thanks for your interest! Small, focused PRs are preferred. This repo documents deployments that are actually running, so the bar for every change is: **the docs must stay truthful about the system they describe.**

## First: enable the leak guard

This is a public repo developed against private infrastructure, so CI blocks any commit containing credential material, private or CGNAT/tailnet IPs, real tailnet hostnames, or internal tracker references — and a local pre-commit hook mirrors the same pattern set so you find out before CI does. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

If you run your own deployment from a fork, also seed your personal hostname denylist (it stays local — the real file is gitignored):

```sh
cp .leak-denylist.example .leak-denylist
```

Everything else — custom denylist syntax, the intentional-commit bypass, the hook's self-test — is in [`.githooks/README.md`](.githooks/README.md).

## Dev setup

Deno 2.x is the only toolchain needed for server work:

```sh
cd server
deno task test              # hermetic unit tests — no database, no network
deno task check-allow-env   # the same --allow-env drift guard CI runs
```

For compose or Caddyfile changes, sanity-check locally from the relevant `deploy/*` directory with `docker compose config` (and see the CI gates below for the deeper checks). Docs-only changes need no toolchain at all.

## The five CI gates

| Gate | What fails it | Reproduce locally |
|---|---|---|
| **CI** | A failing unit test, or a `Deno.env.get` not covered by the Dockerfile's `--allow-env` list | `cd server && deno task test && deno task check-allow-env` |
| **Leak gate** | Any tracked file matching the shared pattern set (credentials, private/tailnet IPs, internal identifiers) | The pre-commit hook above; patterns in [`.github/leak-patterns.txt`](.github/leak-patterns.txt) |
| **Allowlist guard** | The Anthropic egress CIDR disappearing from the active Caddyfile — a PR that removes it will be rejected; that's the point | Inspect `deploy/compose-tailnet/Caddyfile` for the `client_ip` allow + deny pair |
| **Caddyfile validate** | A Caddyfile that doesn't parse under the pinned Caddy image | From the repo root: `docker run --rm -v "$PWD:/work:ro" -w /work "$(awk '$1=="FROM"{print $2; exit}' deploy/compose-tailnet/caddy/Dockerfile)" caddy validate --adapter caddyfile --config deploy/compose-tailnet/Caddyfile` — the image is derived from the perimeter Dockerfile's `FROM`, exactly as [`caddy-validate.yml`](.github/workflows/caddy-validate.yml) does. On SELinux-enforcing hosts (Fedora/Qubes) run it against a staged copy of the two files with `:ro,z` — `:z` relabels the mount source, which you don't want on your checkout |
| **DB init smoke test** | A `db/*.sql` change that breaks fresh init or violates the least-privilege assertions (e.g. the monitor role must never be able to read `thoughts`) | The full recipe is [`db-init.yml`](.github/workflows/db-init.yml): fresh init on a throwaway volume, a `pg_dump` as `openbrain_readonly`, and the monitor role's real probes incl. the thoughts-denial check — run its steps against the compose-local stack; the assertions live in [`db/03-grants-assertion.sql`](db/03-grants-assertion.sql) |

Four of the five are path-filtered — a docs-only PR legitimately triggers only the Leak gate. Skipped checks on your PR are normal, not a problem.

## What PRs are welcome

Explicitly invited:

- **A `deploy/compose-cloudflare/` variant.** [`docs/why-not-cloudflare.md`](docs/why-not-cloudflare.md) ends with a designed-but-never-built sketch and invites exactly this, following the structure of `deploy/compose-tailnet/`.
- **Import / migration recipes** — getting existing notes (ChatGPT exports, Obsidian vaults, plain markdown, …) into the `thoughts` store.
- **Upstream-compatible schema extensions.** The `thoughts` table layout deliberately stays compatible with upstream OB1; extensions that preserve that work here too.
- **Deployment-runbook fixes from real installs** — the gotcha you hit following a README is a bug in the README.
- **Observability improvements** to the summary/rollup tooling.

Likely rejected without prior discussion (open an issue first):

- Anything that weakens a perimeter guard (the allowlist, the auth-door boot requirement, log redaction) — including "just for development".
- A third auth door.
- Multi-tenant / row-level-security rework — a known, deliberate limitation; roadmap-scale, not PR-scale.

## Keep the security docs truthful

If your change moves a trust boundary or adds/removes a control, update [`docs/security-model.md`](docs/security-model.md) and the one-page [`docs/threat-model.md`](docs/threat-model.md) in the same PR. A security doc that describes last month's system is worse than no doc.

## Licensing

This project is licensed [FSL-1.1-MIT](LICENSE.md). Contributions are accepted under the same terms (inbound = outbound): by submitting a PR you agree your contribution is licensed under FSL-1.1-MIT, including its conversion to MIT two years after each release.

## Security issues

Never open a public issue for a vulnerability — use GitHub's private reporting instead. See [SECURITY.md](SECURITY.md).
