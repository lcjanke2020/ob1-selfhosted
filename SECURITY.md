# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please report it responsibly. **Do not open a public issue.**

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. Include a description, steps to reproduce, and any relevant files or links. Reports are acknowledged within a few days.

## Scope

This policy covers the contents of this repository: the MCP server (`server/`), database schema and roles (`db/`), the compose and Caddy deployment configurations (`deploy/`), and the CI workflows. Deployment-specific misconfigurations on your own infrastructure are out of scope, but reports that the *documented* setup leads to an insecure default are very much in scope.

## What counts

- Auth bypasses on either door (x-brain-key or OAuth), including Anthropic IP-allowlist circumvention, or an `x-brain-key` being accepted on an OAuth-only deployment
- Privilege escalation across the database roles (`openbrain_app` / `openbrain_ingester` / `openbrain_readonly`)
- Credential leakage into logs, error responses, or the observability tables
- CI workflows exploitable from a pull request
- Secrets accidentally committed to the repo

## What doesn't

- The documented trust model itself (e.g. "any key-holder has full read/write" — that's by design; see [docs/security-model.md](docs/security-model.md))
- Bugs without a security impact (open a regular issue)

## Local pre-commit leak guard

A `.githooks/pre-commit` hook blocks commits that would introduce credential/key material, a private or tailnet IP, an internal ticket id, or a denylisted hostname into tracked files — a courtesy mirror of the CI identifier scan for anyone running their own deployment from a fork. It reads the same pattern set as CI ([`.github/leak-patterns.txt`](.github/leak-patterns.txt)), so the local check and CI can't drift. It is opt-in per clone (`git config core.hooksPath .githooks`) and the real hostname denylist stays local (gitignored). See [`.githooks/README.md`](.githooks/README.md). This is convenience, not a security boundary — the project does not rely on obscurity.
