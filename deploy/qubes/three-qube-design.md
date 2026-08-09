# Design: ingress / app / db in three qubes

**Status: implemented — ingress, app, and db run in three qubes, each from its
own self-contained compose directory.** The dedicated DB qube is provisioned
([`db-qube/`](db-qube/)), the app→DB transport is wired (firewall-scoped tailnet
— see below), and the public edge (Funnel + Caddy) runs in its own ingress qube
reverse-proxying to the app qube's loopback-only mcp over a dom0-policy-gated
qubes.ConnectTCP channel (see
[Implemented: ingress→app transport](#implemented-ingressapp-transport-qubesconnecttcp--no-listener)).
Each role now has a self-contained per-qube compose file rather than a
`COMPOSE_FILE` override stack: [`app-qube/`](app-qube/) (mcp + Ollama) and
[`ingress-qube/`](ingress-qube/) (Caddy + log-ingester) — operator recipe in the
[Qubes README](README.md#splitting-the-stack-across-qubes). Kept as a design doc
because the reasoning — the threat model and the trust layers — is the
transferable part.

The edge is now app-stateless by construction: `ingress-qube/docker-compose.yml`
defines **only** Caddy + the log-ingester (and a parked-for-future local logs
DB), so the edge no longer starts the unused `mcp` + `ollama` it once did
([#13](https://github.com/lcjanke2020/ob1-selfhosted/issues/13) resolved) and
holds no app-role DB credential — only the INSERT-only ingester credential and
the SELECT-only funnel-monitor credential. The
[log-ingester](#log-ingester-placement-decided-for-now)'s placement is **decided
for now**: it stays on the ingress qube writing across to the db qube, with the
parked local Postgres on the ingress qube as its documented future home
([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)).

## Implemented: app→DB transport (firewall-scoped tailnet)

The DB qube runs Postgres natively and is reachable by just two scoped peers —
the app qube on the full app role, and (while the log-ingester runs on the edge)
the ingress qube on an INSERT-only observability role plus a SELECT-only monitor
role; see [Log-ingester placement](#log-ingester-placement-decided-for-now). The
app→DB transport — the primary, full-role path — is enforced in three
independent layers (the ingester and monitor paths reuse the same layers with
one extra grant/host line each):

1. **Tailscale ACL** — grants permit exactly `app-qube → db-qube:5432` (and, for
   the ingester, `ingress-qube → db-qube:5432`); every other tailnet peer is
   default-denied at the wire. The DB qube carries its own tag (e.g.
   `tag:ob1-db`) and nothing else routes to it.
2. **Qubes nftables** — the DB qube accepts inbound `tcp/5432` on `tailscale0`
   only (a `custom-input` rule reapplied after `tailscaled` by a one-shot unit,
   since `qubes-firewall.service` runs before the interface exists). No `:22` —
   there is no sshd; all admin is dom0 `qvm-run`.
3. **`pg_hba.conf`** — `scram-sha-256` host lines scoped per peer: the app +
   readonly roles and the **superuser** (for remote DB admin — a deliberate
   trade-off, see [db-qube/README.md](db-qube/README.md)) from the app qube's
   IP, the INSERT-only ingester and SELECT-only monitor roles from the ingress
   qube's IP. Every role is locked to exactly one peer IP.

PGDATA, `/etc/postgresql`, and `/var/lib/tailscale` are bind-dir'd into `/rw` so
the cluster, its hardened config, and the node identity survive reboots; the
cluster is started on boot (after `tailscale0` is up) from `rc.local`. For this
app→DB hop the more-isolated qrexec / `qubes.ConnectTCP` transport (no listener
at all) remains a tracked follow-up — the ingress→app hop has since adopted
exactly that pattern (next section), which is also its proof of concept here.

## Implemented: ingress→app transport (qubes.ConnectTCP — no listener)

The ingress→app hop originally mirrored the app→DB decision: mcp published
`0.0.0.0:8787` and three independent layers scoped the wide bind to the ingress
qube (Tailscale ACL grant, a `DOCKER-USER` host-firewall rule on the app qube,
and mcp's OAuth door). That design had a structural weakness the DB hop doesn't:
the listener's safety depended on firewall state that had to be **continuously
right** — docker recreates the `DOCKER-USER` chain on daemon restart, the rule
had to be re-inserted by a drop-in plus a boot one-shot, and an audit couldn't
verify the live iptables state without privileged access.

The hop now rides the qrexec transport instead, which removes the listener class
entirely:

- **mcp binds loopback only** (`127.0.0.1:8787` in
  [`app-qube/docker-compose.yml`](app-qube/docker-compose.yml)) — nothing
  listens on the app qube's eth0 or tailnet interface (`ss -tlnp` shows the
  loopback socket only). A third qube's probe still times out at the static
  qubes input default-drop; the design point is that reachability no longer
  depends on _mutable, docker-managed_ firewall state, and even a packet the
  firewall let through would find nothing listening.
- **A socat forwarder on the ingress qube**
  ([`ingress-qube/ob1-mcp-forward.sh`](ingress-qube/ob1-mcp-forward.sh)) binds
  that qube's own IP `:18787` and bridges each connection to
  `qrexec-client-vm <app-qube> qubes.ConnectTCP+8787`; Caddy's `MCP_UPSTREAM`
  targets it. (Own-IP, not a bridge gateway: under the deployed rootless docker,
  container→own-host-IP traffic arrives on `lo` — see the
  [Qubes README § Rootless docker](README.md#rootless-docker-the-deployed-engine-posture).)
- **dom0 policy gates the channel** —
  `qubes.ConnectTCP +8787 <ingress-qube> <app-qube> allow autostart=no`
  (explicit destination; `autostart=no` so a proxied request can never boot a
  halted app qube). This is the isolation layer: it names exactly one caller and
  one target, and it is enforced by dom0, not by state inside either qube.
- **mcp's OAuth door is unchanged** — every request arriving over the channel
  still authenticates.

The Tailscale ACL grant and the `DOCKER-USER` machinery are retired — there is
no wide bind left to scope. Rollback is documented (not yet exercised live):
repoint `MCP_UPSTREAM` at a direct app-qube address, republish `0.0.0.0:8787`,
and scope the re-opened bind with an ingress-only `custom-input` accept — under
rootless docker the published port is a plain host listener governed by the
qubes input chain, and the retired `DOCKER-USER` layer cannot see it
([ingress-qube README](ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp)).
The install steps, verification, and the forwarder files live in that README;
the same pattern documented for the GPU hop is in
[`gpu-offload-transport.md`](gpu-offload-transport.md).

## Problem

In the [baseline single-qube deployment](README.md), Tailscale Funnel, Caddy,
the MCP server, and Postgres are co-resident. The loopback-only binds and
container hardening narrow each component's network surface, but they share a
kernel and a filesystem: **a compromise of the public-facing edge is one step
from the memory store** — the highest-value asset on the box. docker-compose is
the right tool for co-locating services that share a trust boundary; it's the
wrong tool once the point is to put a VM boundary between two of them.

## Target shape

```
                        public internet (Anthropic egress only)
                                        │
┌─ ingress qube ─────────────────────── ▼ ──────┐
│  tailscaled (Funnel) + Caddy + log-ingester   │   no memory store; a parked
│  IP allowlist enforced here                   │   local logs DB; two scoped
└───────────────┬───────────────────────────────┘   obs-only paths to db qube *
                │  qubes.ConnectTCP +8787 (dom0 policy)
┌─ app qube ──── ▼ ──────────────────────────────┐
│  MCP server (+ Ollama) + encrypted backup      │  no network-facing listener;
└───────────────┬────────────────────────────────┘  reached ONLY over qrexec
                │  Postgres port only (scoped)
┌─ db qube ───── ▼ ──────────────────────────────┐
│  Postgres + pgvector, native install           │  the memory store; reached
│  loopback; scoped peers: app, ingester, monitor│  by app, ingester, monitor *
└─────────────────────────────────────────────────┘
```

\* Log-ingester placement is **decided for now**: it runs on the ingress qube
and writes across to the db qube, so the edge keeps that INSERT-only path — and
the host-side funnel monitor keeps a second, SELECT-only metadata path over the
same wire; the parked local logs DB on the ingress qube is the ingester path's
documented future home
([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)).

- **Ingress qube** — runs `tailscaled` (Funnel), Caddy, and the log-ingester,
  from a self-contained [`ingress-qube/`](ingress-qube/) compose that defines
  **only** those (plus a parked local logs DB), and the host-side
  [funnel monitor](ingress-qube/README.md#funnel-monitor-host-side-not-compose).
  It holds **no** Postgres memory store and **no** app credential — only two
  observability credentials (INSERT-only ingester, SELECT-only monitor) and
  their scoped paths to the db qube. The unused edge `mcp` + `ollama` the old
  override recipe once started are gone by construction
  ([#13](https://github.com/lcjanke2020/ob1-selfhosted/issues/13) resolved). The
  store itself is never on the edge; it lives in the db qube.
- **App qube** — the MCP server (+ Ollama), from [`app-qube/`](app-qube/). mcp
  binds loopback only; the ingress qube reaches it exclusively over the
  dom0-policy-gated qubes.ConnectTCP channel. As the trusted DB control-plane it
  holds the admin + app + readonly credentials and runs the encrypted off-box
  backup ([`app-qube/backup/`](app-qube/backup/)).
- **DB qube** — Postgres + pgvector, **out of docker-compose**, run natively (or
  as a single container). Reached by the app qube (the full app role) and —
  while the log-ingester lives on the edge — by the ingress qube on one
  INSERT-only observability role plus the monitor's SELECT-only metadata role;
  nothing else routes to it.

The minimum viable step, if the full split slips: get Postgres out of the
Funnel-exposed qube. Edge compromise ≠ memory-store compromise is most of the
value.

## Decision: app→DB transport

Two candidate mechanisms:

1. **qrexec with a custom service policy** — no network listener on the DB qube
   at all; the app qube invokes a policy-gated channel and the Postgres socket
   is proxied over it. Maximum isolation, most plumbing, least standard to debug
   under time pressure.
2. **Firewall-scoped network path** — the DB qube listens, but host firewall +
   Qubes firewall + (if the link rides the tailnet) ACL tags permit exactly one
   peer: the app qube. Default-deny everything else.

**Decision: firewall-scoped (option 2).** It captures ~95% of the isolation
benefit at a fraction of the qrexec complexity, composes with tag-based
default-deny policy you likely already run, and fails debuggable. The residual
delta — one TCP listener, locked to one peer — is acceptable for this asset
class. (The calculus came out differently for the ingress→app hop, whose old
wide bind needed continuously-correct docker firewall state to stay scoped; that
hop
[now runs option 1's qrexec pattern](#implemented-ingressapp-transport-qubesconnecttcp--no-listener),
which also de-risks a future migration of this DB hop.)

## Decision: DB qube construction

Postgres's data directory (`/var/lib/postgresql`) is **not** persisted by a
stock AppVM. Two clean options:

1. **AppVM + bind-dirs** _(chosen)_ — bind PGDATA into `/rw` (the same pattern
   as `/var/lib/tailscale` in the [single-qube runbook](README.md)); root stays
   on a shared minimal template. Smallest backup footprint (private volume
   only), centralized template updates.
2. **StandaloneVM** — simplest mental model, but full-root backups and
   independent patching forever.

Supporting choices:

- **Minimal template** (`debian-minimal` / `fedora-minimal`): install only
  Postgres, pgvector, and backup tooling. The DB qube's attack surface should be
  a database and nothing else.
- **All durable state on the private volume**, verified by a reboot, so
  `qvm-backup` captures everything.
- **Backup portability is a first-class requirement:** take a `qvm-backup` and
  _test-restore it_ before trusting it. Restore onto another machine requires
  the same template installed there — document the template dependency next to
  the backup. If a future hardware migration reuses the disks, the qube persists
  in place and restore is just insurance; if it's a clean reinstall, the
  backup→restore path _is_ the migration mechanism. Know which one you're
  planning for.
- **Provisioning posture:** the qube needs network briefly for package install;
  steady state is loopback + the one permitted app-qube peer. Park it
  net-restricted until the transport wiring lands.

## The trap: re-validate the edge after splitting

Splitting adds a second proxy hop (Funnel → ingress Caddy → app). Two things
that worked in the single-qube topology silently change meaning:

- **XFF trust.** The app qube must trust _only the ingress qube_ as an
  `X-Forwarded-For`-setting peer, or the real client IP is lost (or spoofable).
- **The IP allowlist.** Decide where it's enforced — the ingress Caddy is the
  natural spot — and re-verify both directions end-to-end under the new
  topology: a request from a non-allowlisted IP still gets `403`, and an
  allowlisted client still completes a real tool call.

This re-validation is the reason _not_ to rush the split right before you depend
on the endpoint: it touches the edge auth path, which deserves an unhurried test
pass.

## Log-ingester placement (settled: local sink)

The Pattern B **log-ingester** tails Caddy's access-log files and writes
`funnel_access_log` rows to Postgres. Caddy lives on the ingress qube, so the
ingester does too. The question was where its *database* lives.

It used to write **across** to the db qube, which left the ingress qube exactly
one path to `:5432` — the INSERT-only observability role, locked down by ACL +
host firewall + `pg_hba`. That was a deliberate, scoped exception, argued from
the low value of the data: `funnel_access_log` is request metadata only, so a
popped edge writing to that one table gains little.

**That argument was about the wrong layer.** Role grants are enforced *inside*
Postgres — above where a pre-auth wire-protocol or SCRAM-handshake flaw would
live. The narrowness of the grant bounds what a *well-behaved* client can do; it
does nothing about a client that never reaches the grant check. As long as the
internet-facing qube could open a socket to the corpus, it had a path toward it.

The ingester now writes to a **local sink on the ingress qube**: a Postgres
holding `funnel_access_log` and `funnel_access_summary` and nothing else,
reachable only over a unix socket (`listen_addresses=` empty,
`network_mode: none`, no published port). The ingress qube keeps **no** address
for, credential on, or firewall rule toward the db qube; the db qube's `pg_hba`
carries no line for it. Enforcement moved from a grant inside the database to
the absence of a route to it. See
[`ingress-qube/README.md` § Local log sink](ingress-qube/README.md#local-log-sink).

The cost is real and accepted: logs are fragmented across two databases, so
correlating a Funnel request with a thought write is no longer a SQL join. It
was always weak — `funnel_access_log` carries no thought or session id — and the
auth-side audit (`mcp_auth_events`) stays with the corpus. The daily rollup
splits along the same seam: each qube runs the half that owns its tables. The
rejected alternative, moving the ingester to the app qube, would have needed
Caddy's access logs to cross qubes. This resolves
[#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) as option 3.

## Acceptance criteria

- Funnel + Caddy run in a dedicated ingress qube with no memory store and no app
  state — **achieved**:
  [`ingress-qube/docker-compose.yml`](ingress-qube/docker-compose.yml) defines
  Caddy, the log-ingester, and the local log sink (the unused edge
  `mcp`/`ollama` are gone,
  [#13](https://github.com/lcjanke2020/ob1-selfhosted/issues/13)). The sink is a
  request-metadata store, not a memory store: two observability relations,
  enforced by an init-time assertion.
- MCP + Postgres in separate qubes; the app qube reaches the DB on the chosen
  transport (full app role), and **nothing else reaches it at all**.
- The ingress qube cannot reach any host other than the app qube's mcp, over the
  dom0-policy-gated qubes.ConnectTCP channel — **achieved without exception**
  since the log sink moved local
  ([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) option 3). The
  former INSERT-only carve-out to the db qube's `:5432` is gone: roles dropped,
  `pg_hba` lines removed, no address left in the edge's config. Verified by ACL
  + firewall + dom0-policy audit, not assumption.
- Backup/restore works against the relocated DB.
- The allowlist + XFF behavior re-verified under the two-hop topology.
- Your network-topology diagram updated — an isolation model that exists only in
  qube configs and not in documentation will drift.
