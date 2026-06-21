# Security model

What this stack trusts, what it doesn't, and what each layer is allowed to do after the layer above it fails. The companion doc [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) covers the transferable pattern for running *any* MCP server behind Tailscale Funnel.

## Trust boundaries

**Local install.** The perimeter is the loopback interface. Anyone with shell access to the box and the `x-brain-key` has full read/write.

**Pattern A (tailnet).** The perimeter is WireGuard authentication plus your Tailscale ACLs. Any tailnet member your ACLs allow to reach the box, who also holds the `x-brain-key`, gets **full read/write** to your thoughts and sessions. There is no per-user row-level security and no per-user identity on this door. Treat the key like a database password and the ACLs as the firewall.

**Pattern B (Funnel).** Tailnet path: same as Pattern A. Public path: anyone on the internet who (a) originates from Anthropic's published egress range `160.79.104.0/21` and (b) presents a valid RS256 JWT with the configured issuer, audience, and an `exp` claim, gets full read/write. Identity rests entirely on your OAuth tenant's user management and client-credential hygiene. The JWT's `sub` is verified, required, and stamped onto every write — but it is **informational**: it attributes writes, it does not partition them. Whether to collapse the two doors into a single OAuth door is a deliberately open design question; the dual-door shape keeps tailnet clients working when the OAuth provider is unreachable.

## Layered controls

### Network layer

- Every service binds `127.0.0.1` only. The LAN can't reach any port directly; exposure is an explicit `tailscale serve`/`funnel` act.
- In Pattern B the override file **removes** mcp's host port (`ports: !reset null`). The raw backend is unreachable from the host, so a misconfigured `tailscale funnel` pointed at `:8787` fails closed instead of bypassing Caddy.
- Caddy's funnel branch enforces the Anthropic IP allowlist using the `client_ip` matcher (XFF-resolved), with `trusted_proxies static private_ranges` + `trusted_proxies_strict` so forwarding headers are honored only from the loopback proxy peer. A tailnet client can't escalate into the funnel branch: the discriminating `Tailscale-Funnel-Request` header is injected by `tailscaled` itself, not controllable by clients.
- Each Caddy branch **strips the other branch's credential header** before proxying (funnel strips `x-brain-key`; tailnet strips `Authorization`). The inapplicable credential physically cannot reach the backend — a network-layer boundary, with app-layer `requireAuth` behind it as defense in depth.

### Application layer

- `MCP_ACCESS_KEY` minimum length 32 is enforced at boot; weak keys refuse to start.
- Bearer validation pins issuer, audience, algorithm (RS256), and requires `exp` and `sub` claims; verification fails closed before any source-marker stamping runs.
- A boot-time JWKS reachability probe (with an explicit wall-clock timeout that also caps every later refresh) surfaces a typo'd JWKS URI at startup rather than at the first attacker request.
- The server fail-fasts when OAuth is configured but the Pattern B override wasn't loaded (`ENABLE_OAUTH && !PATTERN_B`), catching the half-configured invocation that would leave the backend port published.
- Auth-failure responses are deliberately shaped: **missing** credentials get HTTP 401 + `WWW-Authenticate` (RFC 6750 — what OAuth discovery needs), while **invalid** credentials get an HTTP 200 JSON-RPC error envelope so MCP clients don't tear down an established transport. Operator-facing messages are collapsed to a single "unauthorized" — the granular reason goes to the audit table, not to the caller, closing a credential-status side-channel.
- Captured content is hard-capped (100,000 UTF-8 bytes) on both `capture_thought` and `session_capture`.
- Session provenance (`source`, `source_node`) is stamped server-side from the transport; caller-supplied values are ignored.

### Database layer

Four roles, least privilege, with drift detection:

| Role | Privileges | Used by |
|---|---|---|
| `postgres` | superuser | container init only — never the app |
| `openbrain_app` | SELECT/INSERT/UPDATE on `thoughts` (+ scoped observability/sessions grants); **no DELETE**, no schema-wide DML | MCP server, daily summary |
| `openbrain_ingester` | INSERT-only on `funnel_access_log` | log-ingester sidecar — it parses attacker-influenced log lines, so its blast radius is one table |
| `openbrain_readonly` | SELECT on everything | humans with psql/DBeaver |

`db/01-schema.sql` actively REVOKEs historical broad grants (idempotent, safe on live DBs), and `db/03-grants-assertion.sql` is a read-only invariant check you can run any time — because init scripts only run on a fresh data directory, a tightened grant **does not** reach an existing deployment by itself. The assertion is how you notice.

### Container layer

- `mcp` and `log-ingester`: non-root user, `cap_drop: [ALL]`, `read_only: true` rootfs, size-capped tmpfs, `no-new-privileges`.
- `caddy`: a derived image strips the binary's file capability so a genuinely empty capability set works; read-only rootfs; logs on a dedicated volume the ingester mounts **read-only** (a compromised ingester can't tamper with the on-disk audit evidence — its cursors live on a separate volume).
- `ollama`/`postgres`: `no-new-privileges`; lighter hardening where init or GPU paths need it, with the reasoning inline in the compose file.

### Audit layer

- Caddy redacts `Authorization`, `X-Brain-Key`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` from access logs at format level; the ingester additionally keeps only UA + Host from headers and strips query strings.
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
- **Funnel availability caveats** — see the limitations table in [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Edge↔store isolation (Qubes path)** — resolved by the [three-qube split](../deploy/qubes/three-qube-design.md): Funnel + Caddy (ingress qube), mcp + Ollama (app qube), and Postgres (db qube) run in separate VMs over a firewall-scoped tailnet, so a compromised public edge holds no memory store and no app credential. The single-host install paths still co-locate these by design (one trust boundary).
