# Design: ingress / app / db in three qubes

**Status: implemented — ingress, app, and db now run in three qubes.** The dedicated DB qube is provisioned, the app→DB transport is wired (firewall-scoped tailnet — see below), the compose stack pulls Postgres out via [`docker-compose.external-db.yml`](docker-compose.external-db.yml), and the public edge (Funnel + Caddy) now runs in its own ingress qube reverse-proxying to the app qube's mcp over the tailnet — the parameterized `MCP_UPSTREAM` upstream plus [`docker-compose.app-qube.yml`](docker-compose.app-qube.yml) (operator recipe in the [Qubes README](README.md#splitting-the-stack-across-qubes)). Kept as a design doc because the reasoning — the threat model and the trust layers — is the transferable part. One placement question remains open: [the log-ingester](#log-ingester-placement-open).

## Implemented: app→DB transport (firewall-scoped tailnet)

The DB qube runs Postgres natively and is reachable **only** from the app qube, enforced in three independent layers:

1. **Tailscale ACL** — a grant permits exactly `app-qube → db-qube:5432`; every other tailnet peer is default-denied at the wire. The DB qube carries its own tag (e.g. `tag:ob1-db`) and nothing else routes to it.
2. **Qubes nftables** — the DB qube accepts inbound `tcp/5432` on `tailscale0` only (a `custom-input` rule reapplied after `tailscaled` by a one-shot unit, since `qubes-firewall.service` runs before the interface exists). No `:22` — there is no sshd; all admin is dom0 `qvm-run`.
3. **`pg_hba.conf`** — `scram-sha-256` host lines for the app roles from the app qube's IP only; the superuser stays off the network.

PGDATA, `/etc/postgresql`, and `/var/lib/tailscale` are bind-dir'd into `/rw` so the cluster, its hardened config, and the node identity survive reboots; the cluster is started on boot (after `tailscale0` is up) from `rc.local`. The more-isolated qrexec / `qubes.ConnectTCP` transport (no listener at all) remains a tracked follow-up.

## Problem

In the [current single-qube deployment](README.md), Tailscale Funnel, Caddy, the MCP server, and Postgres are co-resident. The loopback-only binds and container hardening narrow each component's network surface, but they share a kernel and a filesystem: **a compromise of the public-facing edge is one step from the memory store** — the highest-value asset on the box. docker-compose is the right tool for co-locating services that share a trust boundary; it's the wrong tool once the point is to put a VM boundary between two of them.

## Target shape

```
                        public internet (Anthropic egress only)
                                        │
┌─ ingress qube ─────────────────────── ▼ ──────┐
│  tailscaled (Funnel) + Caddy (Pattern Y)      │   terminal node: no app
│  IP allowlist enforced here                   │   state, no DB, no secrets
└───────────────┬───────────────────────────────┘   beyond the Caddyfile
                │  MCP port only (scoped)
┌─ app qube ──── ▼ ──────────────────────────────┐
│  MCP server (+ Ollama, log-ingester)           │  reachable ONLY from the
└───────────────┬────────────────────────────────┘  ingress qube
                │  Postgres port only (scoped)
┌─ db qube ───── ▼ ──────────────────────────────┐
│  Postgres + pgvector, native install           │  no route from ingress
│  loopback + one permitted peer                 │  at all
└─────────────────────────────────────────────────┘
```

- **Ingress qube** — runs `tailscaled` (Funnel) and Caddy. No app state. A popped edge yields a proxy config and nothing else.
- **App qube** — the MCP server. Reachable only from the ingress qube, only on the MCP port.
- **DB qube** — Postgres + pgvector, **out of docker-compose**, run natively (or as a single container). Reachable only from the app qube. The ingress qube has no path to it at all.

The minimum viable step, if the full split slips: get Postgres out of the Funnel-exposed qube. Edge compromise ≠ memory-store compromise is most of the value.

## Decision: app→DB transport

Two candidate mechanisms:

1. **qrexec with a custom service policy** — no network listener on the DB qube at all; the app qube invokes a policy-gated channel and the Postgres socket is proxied over it. Maximum isolation, most plumbing, least standard to debug under time pressure.
2. **Firewall-scoped network path** — the DB qube listens, but host firewall + Qubes firewall + (if the link rides the tailnet) ACL tags permit exactly one peer: the app qube. Default-deny everything else.

**Decision: firewall-scoped (option 2).** It captures ~95% of the isolation benefit at a fraction of the qrexec complexity, composes with tag-based default-deny policy you likely already run, and fails debuggable. The residual delta — one TCP listener, locked to one peer — is acceptable for this asset class.

## Decision: DB qube construction

Postgres's data directory (`/var/lib/postgresql`) is **not** persisted by a stock AppVM. Two clean options:

1. **AppVM + bind-dirs** *(chosen)* — bind PGDATA into `/rw` (the same pattern as `/var/lib/tailscale` in the [single-qube runbook](README.md)); root stays on a shared minimal template. Smallest backup footprint (private volume only), centralized template updates.
2. **StandaloneVM** — simplest mental model, but full-root backups and independent patching forever.

Supporting choices:

- **Minimal template** (`debian-minimal` / `fedora-minimal`): install only Postgres, pgvector, and backup tooling. The DB qube's attack surface should be a database and nothing else.
- **All durable state on the private volume**, verified by a reboot, so `qvm-backup` captures everything.
- **Backup portability is a first-class requirement:** take a `qvm-backup` and *test-restore it* before trusting it. Restore onto another machine requires the same template installed there — document the template dependency next to the backup. If a future hardware migration reuses the disks, the qube persists in place and restore is just insurance; if it's a clean reinstall, the backup→restore path *is* the migration mechanism. Know which one you're planning for.
- **Provisioning posture:** the qube needs network briefly for package install; steady state is loopback + the one permitted app-qube peer. Park it net-restricted until the transport wiring lands.

## The trap: re-validate the edge after splitting

Splitting adds a second proxy hop (Funnel → ingress Caddy → app). Two things that worked in the single-qube topology silently change meaning:

- **XFF trust.** The app qube must trust *only the ingress qube* as an `X-Forwarded-For`-setting peer, or the real client IP is lost (or spoofable).
- **The IP allowlist.** Decide where it's enforced — the ingress Caddy is the natural spot — and re-verify both directions end-to-end under the new topology: a request from a non-allowlisted IP still gets `403`, and an allowlisted client still completes a real tool call.

This re-validation is the reason *not* to rush the split right before you depend on the endpoint: it touches the edge auth path, which deserves an unhurried test pass.

## Log-ingester placement (open)

The Pattern B **log-ingester** tails Caddy's access-log files and writes `funnel_access_log` rows to Postgres. Caddy lives on the ingress qube; Postgres lives on the db qube — so wherever the ingester runs, it bridges to one of them. The current deployment runs it on the **ingress** qube, next to Caddy, which means the ingress qube keeps exactly **one** path to the db qube: the INSERT-only observability role on `:5432`, locked to the db qube by ACL + host firewall + `pg_hba`. This is a deliberate, scoped exception to the "ingress reaches only the app qube" target below — not an oversight. `funnel_access_log` is request metadata only (timestamp, path, status, client IP; no thought content, no credentials), so a popped ingress writing to that one table is low-value.

The cleaner end state moves the ingester to the **app** qube, leaving the ingress qube with no DB path at all — but that needs Caddy's access logs to cross from the ingress qube to the app qube (a shared/forwarded log path, or Caddy emitting to a destination the app qube reads). A third option is a perimeter logs-only Postgres on the ingress qube (loopback-only), which fully severs ingress→db at the cost of fragmenting logs across two databases. Picking the end state is tracked in [#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12).

## Acceptance criteria

- Funnel + Caddy run in a dedicated ingress qube with no app state or DB present.
- MCP + Postgres in separate qubes; the app qube reaches the DB on the chosen transport; nothing else can.
- The ingress qube cannot reach any host other than the app qube's MCP port — **plus**, while the log-ingester runs there, the INSERT-only observability role on the db qube's `:5432` (the documented exception above — see [Log-ingester placement](#log-ingester-placement-open) / [#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)). Verified by ACL + firewall audit, not assumption.
- Backup/restore works against the relocated DB.
- The allowlist + XFF behavior re-verified under the two-hop topology.
- Your network-topology diagram updated — an isolation model that exists only in qube configs and not in documentation will drift.
