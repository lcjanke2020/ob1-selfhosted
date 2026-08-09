# Threat model — one page

The security documentation in this repo is deliberately distributed: each doc
owns the layer it describes. This page assembles the whole model in one place —
assets, attackers, trust boundaries, defense layers, residual risk — and links
to where each piece lives in depth: [`security-model.md`](security-model.md)
(controls, roles, limitations),
[`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) (the public perimeter),
[`three-qube-design.md`](../deploy/qubes/three-qube-design.md) (VM
compartmentalization), and [`why-not-cloudflare.md`](why-not-cloudflare.md) (who
can see plaintext). Nothing here is new; if this page and a linked doc ever
disagree, the linked doc wins and the disagreement is a bug.

## Assets

- **The memory store** — the `thoughts` and `sessions` tables. Private by
  definition; protecting it is the reason this project exists. Highest value,
  and the reason the
  [three-qube split](../deploy/qubes/three-qube-design.md#problem) puts a VM
  boundary between it and the public edge.
- **Credentials** — interactive OAuth client secrets, M2M service-account
  secrets held by scheduled agents, local native/static `x-brain-key`
  credentials, six Postgres role passwords, optional Pushover/ntfy delivery
  credentials, and the Tailscale node identity. Blast radii: the two verifiers
  in
  [`security-model.md` § Trust boundaries](security-model.md#trust-boundaries),
  the DB roles in [§ Database layer](security-model.md#database-layer),
  notification metadata in [§ Audit layer](security-model.md#audit-layer), and
  the node identity in [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Audit integrity** — Caddy's access logs, `funnel_access_log`,
  `mcp_auth_events`, and `metadata_degradation_events`: the evidence trail of
  what reached the doors and whether classification degraded — request metadata,
  reason-coded auth failures, content-free classifier events, and per-write
  door/`sub`/native-token-label attribution. It shows who knocked and what was
  written, not every read of the store: there is no per-tool or per-row read
  audit.

## Attackers and entry points

Each row names the _first_ control an attacker meets; the linked doc describes
what backs it up.

| Entry point                                                                                                                | First control that stops it                                                                                                                                                                                                                                                                                                                                                    | Depth                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Internet scanner on the Funnel hostname — CT-log discovery is assumed from day one, "nobody knows my URL" is not a control | Anthropic egress allowlist (`client_ip 160.79.104.0/21`) returns 403 before auth is even attempted; a CI guard fails any build that drops the CIDR                                                                                                                                                                                                                             | [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you)             |
| Client _inside_ the allowlisted range presenting an expired or forged token                                                | RS256 verification with pinned issuer, audience, and algorithm; `exp` and `sub` required; fails closed, reason-coded to the audit table                                                                                                                                                                                                                                        | [`security-model.md`](security-model.md#application-layer)                                   |
| Client inside the range replaying a **stolen, still-valid** Bearer token                                                   | Honestly: nothing, until the token expires — there is no revocation or introspection. The token reaches shared workspace/project audiences and the stolen subject's personal rows. Exposure is bounded by IdP token lifetime; writes carry door/`sub` stamps, while reads leave no application-level trace                                                                     | [`security-model.md`](security-model.md#trust-boundaries)                                    |
| Compromised OAuth tenant — the attacker can mint valid tokens                                                              | Full read/write **by design** — identity rests entirely on the tenant, and a validly-minted token trips no in-path control. Visibility, not detection: Caddy's request metadata plus the door/`sub` stamp on every write — a read-only attacker leaves no application-level trace                                                                                              | [`security-model.md`](security-model.md#trust-boundaries)                                    |
| Leaked interactive OAuth client secret (without tenant control)                                                            | The documented interactive client enables only the code + refresh grants, so the secret alone mints no token without a login at the IdP. The exchange — and the evidence of its abuse — lives upstream between the hosted connector and the IdP; this server never sees a failed exchange, only a `missing_credentials` probe                                                  | [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#failure-mode-catalog)                    |
| Leaked M2M client secret                                                                                                   | It can mint service tokens immediately; this is the intended capability of `client_credentials`. Use one client per agent, a short access-token lifetime, provider-side rotation/revocation, tailnet routing, and the verified `service`/`sub` write stamps to bound and investigate exposure. Already-issued JWTs remain valid until expiry because there is no introspection | [`service-account-oauth-client.md`](service-account-oauth-client.md#rotation-and-revocation) |
| Compromised public edge (Caddy or tailscaled process)                                                                      | On the Qubes path, a VM boundary: the ingress qube holds no memory store, no app credential, and no route to the database qube at all — its Funnel logs go to a local socket-only sink holding request metadata and nothing else                                                                                                                                               | [`three-qube-design.md`](../deploy/qubes/three-qube-design.md)                               |
| LAN or tailnet attacker against the local single-box install                                                               | Loopback-only binds — LAN exposure requires an explicit `tailscale serve` act; each native token is a database-password-equivalent bearer secret, independently revocable after detection                                                                                                                                                                                      | [`native-access-tokens.md`](native-access-tokens.md)                                         |
| Attacker replaying one stolen native token                                                                                 | The token works until the operator revokes its public prefix; then the next request fails because every request reads current revocation state. Its label identifies subsequent writes, while reads have no per-tool audit                                                                                                                                                     | [`native-access-tokens.md`](native-access-tokens.md#issue-list-and-revoke)                   |
| Log-line injection at the log-ingester (it parses attacker-influenced access-log lines)                                    | Its DB role can only INSERT into one table; it mounts Caddy's log volume read-only, so it can't tamper with the on-disk evidence either                                                                                                                                                                                                                                        | [`security-model.md`](security-model.md#database-layer)                                      |
| Supply chain: a drifted base image, or a pull request attacking CI                                                         | Version-pinned images (with `pull: true` on the perimeter image), the `--allow-env` drift guard, the allowlist-presence guard, the leak-gate scan; workflows run with read-only tokens                                                                                                                                                                                         | [`security-model.md`](security-model.md#supply-chain--process)                               |

## Trust boundaries by install path

- **Local compose** — one boundary: possession of any active native/static
  `x-brain-key` credential plus network reach. Native tokens separate rotation
  and write attribution, not authorization: every holder can use shared
  workspace/project audiences. Personal visibility is disabled unless the
  operator binds every holder to one deployment-wide `MCP_ACCESS_KEY_PRINCIPAL`.
- **Tailnet / Funnel** — the public door is allowlist-then-OAuth; the private
  door is your tailnet plus the same JWT check. One host, so per-service
  container hardening
  ([`security-model.md` § Container layer](security-model.md#container-layer))
  is the only intra-host boundary.
- **Qubes three-qube split** — the same doors, plus VM boundaries: ingress, app,
  and db each in their own qube. The paths to the db qube (app→db, plus the
  edge's two scoped observability paths) are enforced at three independent
  layers — Tailscale ACL, Qubes nftables, `pg_hba.conf` per-role-per-IP; the
  ingress→app hop rides a dom0-policy-gated `qubes.ConnectTCP` channel — mcp
  binds loopback only (no network listener at all), dom0 policy names the one
  permitted caller, and the OAuth door authenticates what arrives. Detail:
  [`three-qube-design.md`](../deploy/qubes/three-qube-design.md#implemented-ingressapp-transport-qubesconnecttcp--no-listener).

Full statement of both doors:
[`security-model.md` § Trust boundaries](security-model.md#trust-boundaries).

## Defense layers

One line per layer; each links to its section of
[`security-model.md`](security-model.md).

- [**Network**](security-model.md#network-layer) — loopback-only binds; the
  Anthropic IP allowlist as the primary public perimeter, CI-guarded; XFF
  trusted only from the loopback proxy peer.
- [**Application**](security-model.md#application-layer) — refuses to boot with
  no auth door; fresh hash/revocation lookup for native tokens;
  pinned-everything JWT validation; boot-time JWKS probe; shaped auth failures
  that close a credential-status side-channel.
- [**Database**](security-model.md#database-layer) — six least-privilege roles
  plus forced RLS on memory rows; missing audience context matches nothing, the
  app cannot DELETE thoughts or mutate token lifecycle state, the token
  administrator cannot read memories/hashes, and the ingester can only INSERT
  into one observability table.
- [**Container**](security-model.md#container-layer) — the MCP server and
  log-ingester run non-root with `cap_drop: ALL` and a read-only rootfs; Caddy
  keeps the image's root user but runs with a genuinely empty capability set (a
  derived image strips the binary's file capability) on a read-only rootfs;
  reasoning inline where hardening is lighter.
- [**Audit**](security-model.md#audit-layer) — credential-redacted logs,
  reason-coded auth failures, atomic content-free classifier-degradation
  history, optional first-occurrence/rollup notifications for classifier
  degradation and public-door 401 bursts, and a daily observability rollup
  retaining a year of trend data.
- [**Supply chain / process**](security-model.md#supply-chain--process) — pinned
  images, drift guards, and the leak gate.

## Who sees plaintext

With Funnel, TLS terminates on your own hardware: Tailscale's relays see
connection metadata, and no payload in the routine path (the caveat behind that
qualifier is the last residual risk below). Your hosted LLM provider sees
everything the model reads and writes — that is inherent to pointing a hosted
model at your memory store, and it is the honest cap on every other guarantee
here. Your IdP sees identity and auth events only. If explicitly enabled,
Pushover/ntfy sees only an operator label, timestamps, finite degradation
reasons/classes, aggregate classifier counts, and—for the Pushover ingress
monitor—that a public-door auth-failure burst occurred plus its Funnel 401-row
count. Alert bodies expose no thought content, endpoint identity, client IP,
path, request content, non-provider credential, or infrastructure name; each
provider necessarily receives its own delivery credential. Run local models
against the tailnet door and no third party sees thought content at all — the
configuration this project is built not to foreclose. The full comparison table
(including the Cloudflare column):
[`why-not-cloudflare.md` § Who can see what](why-not-cloudflare.md#who-can-see-what).

## Residual risks — accepted and documented

- **No workspace/project membership ACL.** Personal rows are partitioned by
  principal, but every authenticated caller can target any registered
  non-personal audience. This is not complete multi-tenant authorization.
  ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **`sensitive` is not additional encryption.** It prevents cross-principal
  application access, while database admins, the backup role, disks, and dumps
  remain trusted. ([`spaces.md`](spaces.md#the-seeded-sensitive-space))
- **The app tier is trusted to install scope.** Anyone with the `openbrain_app`
  SQL credential can forge transaction-local audience context; RLS protects
  normal callers and application query omissions, not a compromised MCP process.
  ([`spaces.md`](spaces.md#enforcement-and-search))
- **Configured model endpoints still see sensitive input.** Spaces do not bypass
  the embedder or classifier; choose `METADATA_FALLBACK_POLICY=off` when content
  cannot leave the network.
  ([`spaces.md`](spaces.md#the-seeded-sensitive-space))
- **Enabled notification providers see operational metadata.** The payload
  excludes thoughts, IDs, endpoints, client/request detail, and infrastructure
  identity, but the selected provider still learns the generic label, alert
  time, finite degradation classes/counts, and—when ingress Pushover alerts are
  enabled—the occurrence and aggregate size of public-door auth-failure bursts.
  ([`security-model.md` § Audit layer](security-model.md#audit-layer))
- **Ingress alert coverage is deliberately narrow.** The edge monitor sees only
  `funnel_access_log`: tailnet-door and reason-coded application auth failures
  remain outside this signal, and successful intervals below the configured
  public-door burst threshold advance the cursor without entering later rollups.
  Set the threshold to 1 when every newly ingested public-door 401 should
  qualify; use the central audit/rollup path for broader investigation.
  ([`security-model.md` § Audit layer](security-model.md#audit-layer))
- **Thought attribution is last-writer-wins on dedupe.** Re-capturing
  byte-identical content through another credential updates
  `door`/`sub`/`token_label`; explicit new caller provenance replaces the prior
  claims object. Native token labels are server-verified attribution but not
  authorization identity; author/agent/repo/branch values are validated caller
  assertions. One deduplicated row is not a contributor history.
  ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **The superuser is reachable from the app qube** for remote DB admin — a
  deliberate trade-off giving a compromised app qube full DB admin, including an
  app→db OS pivot. Tracked in
  [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15); the
  migrator-role scope-down is the planned structural fix.
  ([`security-model.md` § Database layer](security-model.md#database-layer))
- **The ingress qube keeps no path to the db qube.** It formerly held one
  INSERT-only exception; the Funnel log now goes to an edge-local socket-only
  sink, so the exception is removed rather than scoped
  ([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) resolved).
  Residual risk moves to that sink: popping the edge yields up to 30 days of
  request metadata, which is a subset of what owning the qube already gives.
  ([`three-qube-design.md` § Log-ingester placement](../deploy/qubes/three-qube-design.md#log-ingester-placement-settled-local-sink))
- **A forgotten compose override can republish the backend's loopback port** — a
  container can't detect its own host-port mapping; consciously accepted.
  ([`funnel-mcp-perimeter.md`, limitations table](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **`/ready` is unauthenticated and `/caddy-health` is reachable from any
  source** — deliberate defense-in-depth reductions for health checking, with
  the residual exposure spelled out.
  ([`security-model.md` § Known limitations](security-model.md#known-limitations))
- **Funnel availability** rides Tailscale's infrastructure, bandwidth caps, and
  Let's Encrypt rate limits: monitored, not assumed.
  ([`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md#what-funnel-doesnt-give-you))
- **Tailscale controls the `ts.net` domain** and the coordination plane — "no
  routine plaintext capability" is not "trustless"; CT-log monitoring is the
  detection control, and Tailnet Lock exists if the stronger guarantee is
  wanted.
  ([`why-not-cloudflare.md` § Honest caveats](why-not-cloudflare.md#honest-caveats-to-our-own-argument))

## Out of scope

The documented trust model itself is not a vulnerability: native/static-key
holders share one configured principal, and authenticated callers share every
registered non-personal audience until membership ACLs are added. Believe you've
found a way to break the personal RLS or another stated property above? Please
use private reporting — see [SECURITY.md](../SECURITY.md).
