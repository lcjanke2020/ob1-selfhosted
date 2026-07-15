# Threat model — one page

The security documentation in this repo is deliberately distributed: each doc owns the layer it describes. This page assembles the whole model in one place — assets, attackers, trust boundaries, defense layers, residual risk — and links to where each piece lives in depth: [`security-model.md`](security-model.md) (controls, roles, limitations), [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) (the public perimeter), [`three-qube-design.md`](../deploy/qubes/three-qube-design.md) (VM compartmentalization), and [`why-not-cloudflare.md`](why-not-cloudflare.md) (who can see plaintext). Nothing here is new; if this page and a linked doc ever disagree, the linked doc wins and the disagreement is a bug.

## Assets

- **The memory store** — the `thoughts` and `sessions` tables. Private by definition; protecting it is the reason this project exists. Highest value, and the reason the [three-qube split](../deploy/qubes/three-qube-design.md#problem) puts a VM boundary between it and the public edge.
- **Credentials** — the OAuth client secret (stored at claude.ai), the local `x-brain-key`, five Postgres role passwords, the Tailscale node identity. Enumerated with their blast radii in [`security-model.md`](security-model.md#database-layer).
- **Audit integrity** — Caddy's access logs, `funnel_access_log`, `mcp_auth_events`: the evidence trail that tells you whether either of the above was ever touched.

## Attackers and entry points

Each row names the *first* control an attacker meets; the linked doc describes what backs it up.

| Entry point | First control that stops it | Depth |
|---|---|---|
| Internet scanner on the Funnel hostname — CT-log discovery is assumed from day one, "nobody knows my URL" is not a control | Anthropic egress allowlist (`client_ip 160.79.104.0/21`) returns 403 before auth is even attempted; a CI guard fails any build that drops the CIDR | [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you) |
| Client *inside* the allowlisted range presenting a stolen, expired, or forged token | RS256 verification with pinned issuer, audience, and algorithm; `exp` and `sub` required; fails closed, reason-coded to the audit table | [`security-model.md`](security-model.md#application-layer) |
| Compromised OAuth tenant or leaked client secret | Full read/write **by design** — identity rests entirely on the tenant. Detection, not prevention: every failure is audited, every write is stamped with its door and verified `sub` | [`security-model.md`](security-model.md#trust-boundaries) |
| Compromised public edge (Caddy or tailscaled process) | On the Qubes path, a VM boundary: the ingress qube holds no memory store and no app credential — only an INSERT-only ingester role and a SELECT-only monitor role | [`three-qube-design.md`](../deploy/qubes/three-qube-design.md) |
| LAN or tailnet attacker against the local single-box install | Loopback-only binds — LAN exposure requires an explicit `tailscale serve` act; the `x-brain-key` is the sole door and is to be treated like a database password | [`security-model.md`](security-model.md#trust-boundaries) |
| Log-line injection at the log-ingester (it parses attacker-influenced access-log lines) | Its DB role can only INSERT into one table; it mounts Caddy's log volume read-only, so it can't tamper with the on-disk evidence either | [`security-model.md`](security-model.md#database-layer) |
| Supply chain: a drifted base image, or a pull request attacking CI | Version-pinned images (with `pull: true` on the perimeter image), the `--allow-env` drift guard, the allowlist-presence guard, the leak-gate scan; workflows run with read-only tokens | [`security-model.md`](security-model.md#supply-chain--process) |

## Trust boundaries by install path

- **Local compose** — one boundary: possession of the `x-brain-key` plus network reach. Anyone holding both has full read/write; there is no per-user identity on this door.
- **Tailnet / Funnel** — the public door is allowlist-then-OAuth; the private door is your tailnet plus the same JWT check. One host, so containers (non-root, dropped capabilities, read-only rootfs) are the only intra-host boundaries.
- **Qubes three-qube split** — the same doors, plus VM boundaries: ingress, app, and db each in their own qube, and each inter-qube path enforced at three independent layers (Tailscale ACL, Qubes nftables, `pg_hba.conf` per-role-per-IP). Detail: [`three-qube-design.md`](../deploy/qubes/three-qube-design.md#implemented-appdb-transport-firewall-scoped-tailnet).

Full statement of both doors: [`security-model.md` § Trust boundaries](security-model.md#trust-boundaries).

## Defense layers

One line per layer; each links to its section of [`security-model.md`](security-model.md).

- [**Network**](security-model.md#network-layer) — loopback-only binds; the Anthropic IP allowlist as the primary public perimeter, CI-guarded; XFF trusted only from the loopback proxy peer.
- [**Application**](security-model.md#application-layer) — refuses to boot with no auth door; pinned-everything JWT validation; boot-time JWKS probe; shaped auth failures that close a credential-status side-channel.
- [**Database**](security-model.md#database-layer) — five least-privilege roles (the app role cannot DELETE; the ingester can only INSERT into one table) with an on-demand grants-drift assertion.
- [**Container**](security-model.md#container-layer) — non-root, `cap_drop: ALL`, read-only rootfs on everything that touches requests; reasoning inline where hardening is lighter.
- [**Audit**](security-model.md#audit-layer) — credential-redacted logs at format level, reason-coded auth-failure rows, a daily rollup retaining a year of trend data.
- [**Supply chain / process**](security-model.md#supply-chain--process) — pinned images, drift guards, and the leak gate.

## Who sees plaintext

With Funnel, TLS terminates on your own hardware: Tailscale's relays see connection metadata, never payload. Your hosted LLM provider sees everything the model reads and writes — that is inherent to pointing a hosted model at your memory store, and it is the honest cap on every other guarantee here. Your IdP sees identity and auth events only. Run local models against the tailnet door and no third party sees thought content at all — the configuration this project is built not to foreclose. The full comparison table (including the Cloudflare column): [`why-not-cloudflare.md` § Who can see what](why-not-cloudflare.md#who-can-see-what).

## Residual risks — accepted and documented

- **No per-user row-level security.** Both doors grant full read/write; `sub` attributes writes but doesn't partition them. Right for a personal store, wrong for multi-tenant. ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **The superuser is reachable from the app qube** for remote DB admin — a deliberate trade-off giving a compromised app qube full DB admin, including an app→db OS pivot. Tracked in [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15); the migrator-role scope-down is the planned structural fix. ([`security-model.md` § Database layer](security-model.md#database-layer))
- **The ingress qube keeps one INSERT-only path to the db qube** while the log-ingester lives on the edge — a scoped, documented exception whose future home is an edge-local logs store ([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)). ([`three-qube-design.md` § Log-ingester placement](../deploy/qubes/three-qube-design.md#log-ingester-placement-decided-for-now))
- **A forgotten compose override can republish the backend's loopback port** — a container can't detect its own host-port mapping; consciously accepted. ([`funnel-mcp-perimeter.md`, limitations table](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **`/ready` is unauthenticated and `/caddy-health` is reachable from any source** — deliberate defense-in-depth reductions for health checking, with the residual exposure spelled out. ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **Funnel availability** rides Tailscale's infrastructure, bandwidth caps, and Let's Encrypt rate limits: monitored, not assumed. ([`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **Tailscale controls the `ts.net` domain** and the coordination plane — "no routine plaintext capability" is not "trustless"; CT-log monitoring is the detection control, and Tailnet Lock exists if the stronger guarantee is wanted. ([`why-not-cloudflare.md` § Honest caveats](why-not-cloudflare.md#honest-caveats-to-our-own-argument))

## Out of scope

The documented trust model itself is not a vulnerability: "any key-holder / any valid-JWT-holder has full read/write" is the design, and multi-tenant isolation is explicitly not a current goal. Believe you've found a way to *break* one of the properties above? Please use private reporting — see [SECURITY.md](../SECURITY.md).
