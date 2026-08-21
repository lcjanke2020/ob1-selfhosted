# Contributing

Thanks for your interest! Small, focused PRs are preferred. This repo documents
deployments that are actually running, so the bar for every change is: **the
docs must stay truthful about the system they describe.**

## First: enable the leak guard

This is a public repo developed against private infrastructure, so CI blocks any
commit containing credential material, private or CGNAT/tailnet IPs, real
tailnet hostnames, or internal tracker references — and a local pre-commit hook
mirrors the same pattern set so you find out before CI does. Enable it once per
clone:

```sh
git config core.hooksPath .githooks
```

If you run your own deployment from a fork, also seed your personal hostname
denylist (it stays local — the real file is gitignored):

```sh
cp .leak-denylist.example .leak-denylist
```

Everything else — custom denylist syntax, the intentional-commit bypass, the
hook's self-test — is in [`.githooks/README.md`](.githooks/README.md).

## Dev setup

Deno 2.9.4 — the version pinned in the server images and CI — is the canonical
toolchain for repository checks. Use that exact version because formatter output
and lint rules can change between Deno releases. The launcher and environment
drift checks also require Docker Compose because they audit Compose's rendered
model rather than maintaining a second merge implementation:

```sh
deno fmt --check
deno lint
cd server
deno task test              # unit tests + local Compose render; no containers/network
deno task check-allow-env   # checks Dockerfile + Compose Deno launchers
deno task check-compose-env # checks server/Compose/example environment parity
```

For compose or Caddyfile changes, sanity-check locally from the relevant
`deploy/*` directory with `docker compose config` (and see the CI gates below
for the deeper checks). Pattern B topology changes should also run
`nu scripts/check_pattern_b_compose.nu` from the repository root. Docs-only
changes need only the repository-wide Deno formatting check described below.

### Native Deno launchers

CI asks `docker compose config --no-interpolate` to render every documented
standalone and base-plus-override stack, then checks every effective service
whose `entrypoint` and/or `command` launches `deno run`, including launcher
defaults inherited from checked-in build Dockerfiles. Disabling interpolation
keeps launcher text controlled by runtime environment dynamic and therefore
fail-closed. Unresolved image defaults — including image-only services whose pin
is not on the reviewed non-Deno list — ambiguous shell positional arguments,
Node's `process.env` surface, and custom Deno config/import-map semantics also
fail closed; the checked-in `server/deno.json` imports are the explicit audited
policy.

This is a drift guard for honest edits to checked-in launchers, not a sandbox
for deliberately adversarial pull-request syntax. Compose owns its YAML and
merge semantics; human review owns hostile checked-in source. Once the live-tree
verdict and honest-edit cases are stable, findings that require adversarial
construction default to a bounded follow-up instead of expanding the gate. See
[issue #76](https://github.com/lcjanke2020/ob1-selfhosted/issues/76) for that
stopping rule.

### Compose environment parity

[`check_compose_env.ts`](server/scripts/check_compose_env.ts) derives the MCP
server's supported keys from the same AST analysis as the launcher guard, then
uses `docker compose config` to render every canonical deployment with unique
sentinels. It rejects missing forwarding, unsupported extras, unreviewed
required/default changes, and drift between Compose's own variable inventory and
each `.env.example`.
[`compose_deployments.ts`](server/scripts/compose_deployments.ts) is the one
typed manifest for Compose files, documented stacks, active profiles, example
groups, capabilities, and reviewed exceptions;
[`compose_env_audit.ts`](server/scripts/compose_env_audit.ts) contains only pure
policy checks. The allow-env guard deliberately expands the three current local
overlays to all eight syntactically supported subsets, while parity checks only
the six documented local stacks plus the two standalone Qubes stacks. Every
exception carries a rationale, and unknown, conflicting, empty, or stale policy
fails. The launcher power set is derived from each Compose file's manifest
`kind`, so a newly classified overlay cannot remain invisible to the audit. The
`log-sink` and `token-admin` capabilities are also checked against services in
Compose's un-interpolated model; this keeps the profile-gated token tool
load-bearing without pretending it is active in a long-running deployment.

The local and Qubes app examples deliberately differ on
`METADATA_FALLBACK_POLICY`: the single-host quickstart preselects strict `off`,
while the security-separated Qubes app requires an explicit operator choice. The
parity check pins both values. Pattern B's separate sink/socket topology is
checked independently by
[`check_pattern_b_compose.nu`](scripts/check_pattern_b_compose.nu), keeping that
security contract — including the ingester's socket and INSERT-only role — out
of generic environment policy. Its OAuth trio is render-time required because
Pattern B disables every non-OAuth credential door. The `tools` profile remains
a one-shot operator command rather than a deployment shape; Compose's
un-interpolated model retains it for allow-env analysis, and a regression test
pins that oracle behavior.

The CI-certified project Compose floor is **2.38.2**, retained as the older
compatibility lane that exposed the original required-variable and
rendered-mount metadata differences. It is deliberately newer than the first
Compose release documenting an individual feature such as `!reset`; feature
availability alone is not the full rendered-contract guarantee. The current
supported line is pinned at **5.3.1**. The `compose-config.yml` workflow
downloads and checksum-verifies both exact Linux plugin binaries and runs the
same parity, launcher-permission, and Pattern B contracts in each matrix lane.
Separately, `ci.yml` intentionally runs the launcher audit once against the
GitHub runner's floating preinstalled Compose as a forward-compatibility smoke;
that unpinned lane does not define or extend the supported-version contract.

CI cannot inspect a systemd unit maintained only on a deployment host. Before
restarting such a unit, load the same environment file the unit uses and
validate the real `index.ts` import graph under the unit's **exact**
comma-separated allowlist:

```sh
set -a
. /path/to/openbrain.env
set +a
cd /path/to/ob1-selfhosted/server

deno run \
  --config scripts/deno.json \
  --lock scripts/deno.lock \
  --frozen \
  --allow-read=. \
  --allow-env=DB_HOST,DB_PORT,... \
  scripts/config_load_probe.ts
```

Copy the complete `--allow-env=` value from `ExecStart`; do not derive it by
grepping only variables assigned in the environment file. Keys with code
defaults still need Deno permission, as do the seven keys read internally by the
pinned Postgres driver. The probe checks all reachable source reads and the
explicit driver policy before importing `config.ts` for value validation.
Restart only after it prints `CONFIG AND ENTRYPOINT PERMISSIONS OK`; a missing
grant reports every key that must be added.

## The seven CI gates

| Gate                   | What fails it                                                                                                                                                                             | Reproduce locally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deno hygiene**       | Any tracked Deno-supported file that differs from canonical formatting, or any Deno lint diagnostic                                                                                       | `deno fmt --check && deno lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **CI**                 | A failing unit test, an unrestricted checked-in Deno launcher, or an env read not covered by a checked-in Dockerfile/Compose launcher's bounded list                                      | `cd server && deno task test && deno task check-allow-env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Compose config**     | A supported MCP key not forwarded by every relevant deployment, an unsupported extra, example-file drift, an unreviewed deployment difference, or a broken Pattern B sink/socket boundary | `cd server && deno task check-compose-env`, then from the repository root `nu scripts/check_pattern_b_compose.nu`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Leak gate**          | Any tracked file matching the shared pattern set (credentials, private/tailnet IPs, internal identifiers)                                                                                 | The pre-commit hook above; patterns in [`.github/leak-patterns.txt`](.github/leak-patterns.txt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Allowlist guard**    | The Anthropic egress CIDR disappearing from the active Caddyfile — a PR that removes it will be rejected; that's the point                                                                | Inspect `deploy/compose-tailnet/Caddyfile` for the `client_ip` allow + deny pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Caddyfile validate** | A Caddyfile that doesn't parse under the pinned Caddy image                                                                                                                               | [`scripts/validate_caddyfile.sh`](scripts/validate_caddyfile.sh) — validates a staged copy of the Caddyfile (SELinux-safe, `--network none`) under the image pinned by the perimeter Dockerfile's `FROM`, with the same official-image-only guard as [`caddy-validate.yml`](.github/workflows/caddy-validate.yml). Checking out a PR you haven't read? Run the canonical repo's copy of the script, not the PR's — trust the URL, not a remote name (in a fork checkout, `origin` is the fork), and hook-disable the fetch (with `core.hooksPath .githooks` set, the unread PR controls the hooks a plain fetch would run): `git -c core.hooksPath=/dev/null fetch https://github.com/lcjanke2020/ob1-selfhosted.git main && validator=$(git show FETCH_HEAD:scripts/validate_caddyfile.sh) && bash -c "$validator"` (the `&&` form fails closed if the extraction fails — don't substitute `bash <(git show …)`, which would silently run an empty script) |
| **DB init smoke test** | A `db/*.sql` change that breaks fresh init or violates the least-privilege assertions (e.g. the monitor role gains access to any relation beyond its two-table allowlist)                 | The full recipe is [`db-init.yml`](.github/workflows/db-init.yml): fresh init on a throwaway volume, a `pg_dump` as `openbrain_readonly`, the monitor role's real probes, and deliberate direct/PUBLIC/default grant-drift checks across schemas — run its steps against the compose-local stack; the assertions live in [`db/03-grants-assertion.sql`](db/03-grants-assertion.sql)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Five of the seven are path-filtered — a docs-only PR legitimately triggers only
the Deno hygiene and Leak gate workflows. Skipped checks on your PR are normal,
not a problem.

## What PRs are welcome

Explicitly invited:

- **A `deploy/compose-cloudflare/` variant.**
  [`docs/why-not-cloudflare.md`](docs/why-not-cloudflare.md) ends with a
  designed-but-never-built sketch and invites exactly this, following the
  structure of `deploy/compose-tailnet/`.
- **Import / migration recipes** — getting existing notes (ChatGPT exports,
  Obsidian vaults, plain markdown, …) into the `thoughts` store.
- **Upstream-compatible schema extensions.** The `thoughts` table layout
  deliberately stays compatible with upstream OB1; extensions that preserve that
  work here too.
- **Deployment-runbook fixes from real installs** — the gotcha you hit following
  a README is a bug in the README.
- **Observability improvements** to the summary/rollup tooling.

Likely rejected without prior discussion (open an issue first):

- Anything that weakens a perimeter guard (the allowlist, the auth-door boot
  requirement, log redaction) — including "just for development".
- A third auth door.
- Multi-tenant / row-level-security rework — a known, deliberate limitation;
  roadmap-scale, not PR-scale.

## Keep the security docs truthful

If your change moves a trust boundary or adds/removes a control, update
[`docs/security-model.md`](docs/security-model.md) and the one-page
[`docs/threat-model.md`](docs/threat-model.md) in the same PR. A security doc
that describes last month's system is worse than no doc.

## Licensing

This project is licensed [FSL-1.1-MIT](LICENSE.md). Contributions are accepted
under the same terms (inbound = outbound): by submitting a PR you agree your
contribution is licensed under FSL-1.1-MIT, including its conversion to MIT two
years after each release.

## Security issues

Never open a public issue for a vulnerability — use GitHub's private reporting
instead. See [SECURITY.md](SECURITY.md).
