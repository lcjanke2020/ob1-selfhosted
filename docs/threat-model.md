# Threat model — one page

The security documentation in this repo is deliberately distributed: each doc owns the layer it describes. This page assembles the whole model in one place — assets, attackers, trust boundaries, defense layers, residual risk — and links to where each piece lives in depth: [`security-model.md`](security-model.md) (controls, roles, limitations), [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) (the public perimeter), [`three-qube-design.md`](../deploy/qubes/three-qube-design.md) (VM compartmentalization), and [`why-not-cloudflare.md`](why-not-cloudflare.md) (who can see plaintext). Nothing here is new; if this page and a linked doc ever disagree, the linked doc wins and the disagreement is a bug.

## Assets

- **The memory store** — the `thoughts` and `sessions` tables. Private by definition; protecting it is the reason this project exists. Highest value, and the reason the [three-qube split](../deploy/qubes/three-qube-design.md#problem) puts a VM boundary between it and the public edge.
- **Credentials** — the OAuth client secret (stored at claude.ai), the local `x-brain-key`, five Postgres role passwords, the Tailscale node identity. Blast radii: the two doors in [`security-model.md` § Trust boundaries](security-model.md#trust-boundaries), the DB roles in [§ Database layer](security-model.md#database-layer), the node identity in [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Audit integrity** — Caddy's access logs, `funnel_access_log`, `mcp_auth_events`: the evidence trail of what reached the doors — request metadata, reason-coded auth failures, and per-write door/`sub` attribution. It shows who knocked and what was written, not every read of the store: there is no per-tool or per-row read audit.

## Attackers and entry points

Each row names the *first* control an attacker meets; the linked doc describes what backs it up.

| Entry point | First control that stops it | Depth |
|---|---|---|
| Internet scanner on the Funnel hostname — CT-log discovery is assumed from day one, "nobody knows my URL" is not a control | Anthropic egress allowlist (`client_ip 160.79.104.0/21`) returns 403 before auth is even attempted; a CI guard fails any build that drops the CIDR | [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you) |
| Client *inside* the allowlisted range presenting an expired or forged token | RS256 verification with pinned issuer, audience, and algorithm; `exp` and `sub` required; fails closed, reason-coded to the audit table | [`security-model.md`](security-model.md#application-layer) |
| Client inside the range replaying a **stolen, still-valid** Bearer token | Honestly: nothing, until the token expires — there is no revocation or introspection. Exposure is bounded by the token lifetime set at your IdP; after the fact you have Caddy's request metadata and door/`sub` stamps on any writes it made — reads leave no application-level trace | [`security-model.md`](security-model.md#trust-boundaries) |
| Compromised OAuth tenant — the attacker can mint valid tokens | Full read/write **by design** — identity rests entirely on the tenant, and a validly-minted token trips no in-path control. Visibility, not detection: Caddy's request metadata plus the door/`sub` stamp on every write — a read-only attacker leaves no application-level trace | [`security-model.md`](security-model.md#trust-boundaries) |
| Leaked OAuth client secret (without tenant control) | The documented client enables only the code + refresh grants, so the secret alone mints no token without a login at the IdP. The exchange — and the evidence of its abuse — lives upstream between claude.ai and the IdP; this server never sees a failed exchange, only a `missing_credentials` probe | [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#failure-mode-catalog) |
| Compromised public edge (Caddy or tailscaled process) | On the Qubes path, a VM boundary: the ingress qube holds no memory store and no app credential — only an INSERT-only ingester role and a SELECT-only monitor role | [`three-qube-design.md`](../deploy/qubes/three-qube-design.md) |
| LAN or tailnet attacker against the local single-box install | Loopback-only binds — LAN exposure requires an explicit `tailscale serve` act; the `x-brain-key` is the sole door and is to be treated like a database password | [`security-model.md`](security-model.md#trust-boundaries) |
| Log-line injection at the log-ingester (it parses attacker-influenced access-log lines) | Its DB role can only INSERT into one table; it mounts Caddy's log volume read-only, so it can't tamper with the on-disk evidence either | [`security-model.md`](security-model.md#database-layer) |
| Supply chain: a drifted base image, or a pull request attacking CI | Version-pinned images (with `pull: true` on the perimeter image), the `--allow-env` drift guard, the allowlist-presence guard, the leak-gate scan; workflows run with read-only tokens | [`security-model.md`](security-model.md#supply-chain--process) |

## Trust boundaries by install path

- **Local compose** — one boundary: possession of the `x-brain-key` plus network reach. Anyone holding both has full read/write; there is no per-user identity on this door.
- **Tailnet / Funnel** — the public door is allowlist-then-OAuth; the private door is your tailnet plus the same JWT check. One host, so per-service container hardening ([`security-model.md` § Container layer](security-model.md#container-layer)) is the only intra-host boundary.
- **Qubes three-qube split** — the same doors, plus VM boundaries: ingress, app, and db each in their own qube. The paths to the db qube (app→db, plus the edge's two scoped observability paths) are enforced at three independent layers — Tailscale ACL, Qubes nftables, `pg_hba.conf` per-role-per-IP; the ingress→app HTTP path (`:8787`) has its own three — Tailscale ACL, the app qube's `DOCKER-USER` host-firewall rule, and the OAuth door itself. Detail: [`three-qube-design.md`](../deploy/qubes/three-qube-design.md#implemented-appdb-transport-firewall-scoped-tailnet).

Full statement of both doors: [`security-model.md` § Trust boundaries](security-model.md#trust-boundaries).

## Defense layers

One line per layer; each links to its section of [`security-model.md`](security-model.md).

- [**Network**](security-model.md#network-layer) — loopback-only binds; the Anthropic IP allowlist as the primary public perimeter, CI-guarded; XFF trusted only from the loopback proxy peer.
- [**Application**](security-model.md#application-layer) — refuses to boot with no auth door; pinned-everything JWT validation; boot-time JWKS probe; shaped auth failures that close a credential-status side-channel.
- [**Database**](security-model.md#database-layer) — five least-privilege roles (the app role cannot DELETE on `thoughts`; the ingester can only INSERT into one table) with an on-demand grants-drift assertion.
- [**Container**](security-model.md#container-layer) — the MCP server and log-ingester run non-root with `cap_drop: ALL` and a read-only rootfs; Caddy keeps the image's root user but runs with a genuinely empty capability set (a derived image strips the binary's file capability) on a read-only rootfs; reasoning inline where hardening is lighter.
- [**Audit**](security-model.md#audit-layer) — credential-redacted logs at format level, reason-coded auth-failure rows, a daily rollup retaining a year of trend data.
- [**Supply chain / process**](security-model.md#supply-chain--process) — pinned images, drift guards, and the leak gate.

## Who sees plaintext

With Funnel, TLS terminates on your own hardware: Tailscale's relays see connection metadata, and no payload in the routine path (the caveat behind that qualifier is the last residual risk below). Your hosted LLM provider sees everything the model reads and writes — that is inherent to pointing a hosted model at your memory store, and it is the honest cap on every other guarantee here. Your IdP sees identity and auth events only. Run local models against the tailnet door and no third party sees thought content at all — the configuration this project is built not to foreclose. The full comparison table (including the Cloudflare column): [`why-not-cloudflare.md` § Who can see what](why-not-cloudflare.md#who-can-see-what).

## Residual risks — accepted and documented

- **No per-user row-level security.** Both doors grant full read/write; `sub` attributes writes but doesn't partition them. Right for a personal store, wrong for multi-tenant. ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **Door attribution is last-writer-wins on dedupe.** Re-capturing byte-identical content through the other door updates the stored `door`/`sub` (metadata merges on conflict) — attribution reflects the most recent capture, not the first. ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **The superuser is reachable from the app qube** for remote DB admin — a deliberate trade-off giving a compromised app qube full DB admin, including an app→db OS pivot. Tracked in [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15); the migrator-role scope-down is the planned structural fix. ([`security-model.md` § Database layer](security-model.md#database-layer))
- **The ingress qube keeps one INSERT-only path to the db qube** while the log-ingester lives on the edge — a scoped, documented exception whose future home is an edge-local logs store ([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)). ([`three-qube-design.md` § Log-ingester placement](../deploy/qubes/three-qube-design.md#log-ingester-placement-decided-for-now))
- **A forgotten compose override can republish the backend's loopback port** — a container can't detect its own host-port mapping; consciously accepted. ([`funnel-mcp-perimeter.md`, limitations table](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **`/ready` is unauthenticated and `/caddy-health` is reachable from any source** — deliberate defense-in-depth reductions for health checking, with the residual exposure spelled out. ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **Funnel availability** rides Tailscale's infrastructure, bandwidth caps, and Let's Encrypt rate limits: monitored, not assumed. ([`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **Tailscale controls the `ts.net` domain** and the coordination plane — "no routine plaintext capability" is not "trustless"; CT-log monitoring is the detection control, and Tailnet Lock exists if the stronger guarantee is wanted. ([`why-not-cloudflare.md` § Honest caveats](why-not-cloudflare.md#honest-caveats-to-our-own-argument))

## Out of scope

The documented trust model itself is not a vulnerability: "any key-holder / any valid-JWT-holder has full read/write" is the design, and multi-tenant isolation is explicitly not a current goal. Believe you've found a way to *break* one of the properties above? Please use private reporting — see [SECURITY.md](../SECURITY.md).
