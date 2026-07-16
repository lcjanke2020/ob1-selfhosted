# Security model

What this stack trusts, what it doesn't, and what each layer is allowed to do after the layer above it fails. The companion doc [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) covers the transferable pattern for running *any* MCP server behind Tailscale Funnel; the assembled one-page view of the whole model is [`threat-model.md`](threat-model.md).

## Trust boundaries

The system has **two auth doors, chosen per deployment** — typically one, though the local single-box install may run both (it's the only place that's intended; the boot log warns when both are on). They're independently toggleable (`MCP_ACCESS_KEY` enables the static-key door; the three `AUTH0_*` vars enable the OAuth door), and the server refuses to boot with neither configured.

**Local single-box install (`x-brain-key`).** The simple shared-key door, intended for loopback/LAN (or your tailnet if you front it with `tailscale serve`). Anyone who can reach the box and present the `x-brain-key` gets **full read/write** to your thoughts and sessions. There is no per-user identity on this door — treat the key like a database password and your network ACLs as the firewall. This door exists only on the local install; the publicly-reachable deployments leave it off.

**Funnel / Qubes (OAuth-only).** The static key is removed entirely — the server does not accept an `x-brain-key` at all (a presented one is ignored, since no key is configured to match). Anyone on the internet who (a) originates from Anthropic's published egress range `160.79.104.0/21` and (b) presents a valid RS256 JWT with the configured issuer, audience, and an `exp` claim, gets full read/write. Identity rests entirely on your OAuth tenant's user management and client-credential hygiene. The JWT's `sub` is verified, required, and stamped onto every write — but it is **informational**: it attributes writes, it does not partition them. Collapsing to a single OAuth door on every publicly-reachable deployment removes a second static credential to rotate and leak; the local install keeps the `x-brain-key` door for environments where standing up an OAuth tenant isn't practical.

## Layered controls

### Network layer

- On the single-host install paths every service binds `127.0.0.1` only — the LAN can't reach any port directly; exposure is an explicit `tailscale serve`/`funnel` act. **Split-Qubes exception:** the app qube publishes `mcp` on `0.0.0.0:8787` (all host interfaces) so the ingress qube's Caddy can reach it across qubes. That port is kept private not by a loopback bind but by the Tailscale ACL (only the ingress qube may reach it) + the app qube's `DOCKER-USER` host-firewall rule (docker DNAT bypasses the Qubes `INPUT` chain) + mcp's OAuth — see the [Qubes README](../deploy/qubes/README.md).
- In Pattern B the override file **removes** mcp's host port (`ports: !reset null`). The raw backend is unreachable from the host, so a misconfigured `tailscale funnel` pointed at `:8787` fails closed instead of reaching mcp directly past the Caddy perimeter (IP allowlist, body cap, logging).
- **Primary public perimeter — the Anthropic IP allowlist.** Caddy's funnel branch enforces `client_ip 160.79.104.0/21` (XFF-resolved), with `trusted_proxies static private_ranges` + `trusted_proxies_strict` so forwarding headers are honored only from the loopback proxy peer. This is the *only* network-layer control between the public internet and the MCP server — non-Anthropic funnel traffic is `403`'d before the backend is touched. It must never be silently dropped; a CI guard (`.github/workflows/allowlist-guard.yml`) fails the build if the CIDR disappears from the Caddyfile. A tailnet client can't escalate into the funnel branch either: the discriminating `Tailscale-Funnel-Request` header is injected by `tailscaled` itself, not controllable by clients.
- **Credentials are not stripped per-branch.** The server decides per deployment which door it accepts: on the OAuth-only funnel/Qubes deployments `MCP_ACCESS_KEY` is unset, so a presented `x-brain-key` is ignored (no key to match); the local install accepts it. Either way the access-log `format filter` deletes both credential headers (`X-Brain-Key`, `Authorization`) so neither reaches disk. App-layer `requireAuth` is the load-bearing check.

### Application layer

- At least one auth door must be configured or the server refuses to boot — there is no accidental no-auth deployment. When the `x-brain-key` door is enabled, `MCP_ACCESS_KEY` minimum length 32 is enforced at boot; weak keys refuse to start. The boot log states which door(s) are active and warns if both are on (intended for the local install only — a public deployment should be OAuth-only).
- Bearer validation pins issuer, audience, algorithm (RS256), and requires `exp` and `sub` claims; verification fails closed before any source-marker stamping runs.
- A boot-time JWKS reachability probe (with an explicit wall-clock timeout that also caps every later refresh) surfaces a typo'd JWKS URI at startup rather than at the first attacker request.
- Auth-failure responses are deliberately shaped: **missing** credentials get HTTP 401 + `WWW-Authenticate` (RFC 6750 — what OAuth discovery needs), while **invalid** credentials get an HTTP 200 JSON-RPC error envelope so MCP clients don't tear down an established transport. Operator-facing messages are collapsed to a single "unauthorized" — the granular reason goes to the audit table, not to the caller, closing a credential-status side-channel.
- Captured content is hard-capped (100,000 UTF-8 bytes) on both `capture_thought` and `session_capture`.
- Session provenance (`source`, `source_node`) is stamped server-side from the transport; caller-supplied values are ignored.

### Database layer

Five roles, least privilege, with drift detection:

| Role | Privileges | Used by |
|---|---|---|
| `postgres` | superuser | init + DB admin (role provisioning / migrations) — never the app runtime. In the three-qube split it's reachable from the app qube's IP only for remote admin — a deliberate trade-off (a compromised app qube then has full DB admin, including an app→db OS pivot via `COPY … TO/FROM PROGRAM`); see [db-qube/README.md](../deploy/qubes/db-qube/README.md) and [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15) |
| `openbrain_app` | SELECT/INSERT/UPDATE on `thoughts` (+ scoped observability/sessions grants); **no DELETE**, no schema-wide DML | MCP server, daily summary |
| `openbrain_ingester` | INSERT-only on `funnel_access_log` | log-ingester sidecar — it parses attacker-influenced log lines, so its blast radius is one table |
| `openbrain_monitor` | SELECT on `funnel_access_log` + `mcp_auth_events` only | host-side funnel monitor ([`scripts/funnel_monitor.sh`](../scripts/funnel_monitor.sh)) — its credential sits on the internet-adjacent edge, so it reads request metadata but can never reach a thought. Optional, like the ingester |
| `openbrain_readonly` | SELECT on everything | humans with psql/DBeaver |

`db/01-schema.sql` actively REVOKEs historical broad grants (idempotent, safe on live DBs), and `db/03-grants-assertion.sql` is a read-only invariant check you can run any time — because init scripts only run on a fresh data directory, a tightened grant **does not** reach an existing deployment by itself. The assertion is how you notice.

### Container layer

- `mcp` and `log-ingester`: non-root user, `cap_drop: [ALL]`, `read_only: true` rootfs, size-capped tmpfs, `no-new-privileges`.
- `caddy`: a derived image strips the binary's file capability so a genuinely empty capability set works; read-only rootfs; logs on a dedicated volume the ingester mounts **read-only** (a compromised ingester can't tamper with the on-disk audit evidence — its cursors live on a separate volume).
- `ollama`/`postgres`: `no-new-privileges`; lighter hardening where init or GPU paths need it, with the reasoning inline in the compose file.

### Audit layer

- Caddy redacts `Authorization`, `X-Brain-Key`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` at format level from **both the per-handle access logs and the process-level error log** — the latter matters because `reverse_proxy` warnings otherwise serialize the full request header map (incl. a Bearer) to `docker logs`; the ingester additionally keeps only UA + Host from headers and strips query strings.
- Every 401 inserts a reason-coded row into `mcp_auth_events` (fire-and-forget, with an in-flight cap so a 401 flood can't queue unbounded memory).
- A daily rollup retains a year of trend data after raw rows age out at 30 days.

### Supply chain / process

- Base images pinned by version (`pgvector/pgvector:pg16`, `denoland/deno:2.3.3`, `caddy:2.11.3-alpine` with `pull: true` so a stale local cache can't feed an older base into the perimeter image; `ollama/ollama` pinned, not `:latest`).
- A CI guard (`server/scripts/check_allow_env.ts`) keeps the Dockerfile's `--allow-env` list in lockstep with every `Deno.env.get` in the code — drift here is a silent boot failure.
- A leak-gate CI job greps every push for credential patterns and private-infrastructure identifiers.

## Known limitations

- **No per-user RLS.** Both doors grant full read/write; `sub` attributes but doesn't partition. Fine for a personal memory store; wrong for multi-tenant.
- **Door attribution is last-writer-wins on dedupe.** Re-capturing byte-identical content through the other door updates the stored `door`/`sub` (metadata merges on conflict) — attribution reflects the most recent capture, not the first.
- **`/caddy-health` is reachable from any source** — required for the docker healthcheck; a public scanner can learn "Caddy is up" from it. Accepted as a minor info leak.
- **`/ready` is unauthenticated** — it returns DB *connectivity* (not data), so it must never be served publicly: Caddy `404`s it on the funnel branch, leaving it reachable only from loopback, the container healthcheck, and tailnet-direct/in-qube callers. Previously a credential was required even from loopback; dropping it is a deliberate defense-in-depth reduction so uptime monitors and the in-container healthcheck can probe without a secret. Residual risk: a Caddy bypass or a misconfigured Qubes firewall would expose the "DB reachable?" signal. Network binding (loopback / Docker network) and the funnel-404 are the only controls.
- **Funnel availability caveats** — see the limitations table in [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Edge↔store isolation (Qubes path)** — resolved by the [three-qube split](../deploy/qubes/three-qube-design.md): Funnel + Caddy (ingress qube), mcp + Ollama (app qube), and Postgres (db qube) run in separate VMs over a firewall-scoped tailnet, so a compromised public edge holds no memory store and no app credential. The single-host install paths still co-locate these by design (one trust boundary).
