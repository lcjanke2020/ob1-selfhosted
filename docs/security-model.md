# Security model

What this stack trusts, what it doesn't, and what each layer is allowed to do after the layer above it fails. The companion doc [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) covers the transferable pattern for running *any* MCP server behind Tailscale Funnel; the assembled one-page view of the whole model is [`threat-model.md`](threat-model.md).

## Trust boundaries

The system has **two auth doors, chosen per deployment** — typically one, though the local single-box install may run both (it's the only place that's intended; the boot log warns when both are on). They're independently toggleable (`MCP_ACCESS_KEY` enables the static-key door; the three `AUTH0_*` vars enable the OAuth door), and the server refuses to boot with neither configured.

**Local single-box install (`x-brain-key`).** The simple shared-key door, intended for loopback/LAN (or your tailnet if you front it with `tailscale serve`). Anyone who can reach the box and present the `x-brain-key` can read/write registered workspace and project audiences — treat the key like a database password and your network ACLs as the firewall. The shared key is not a per-user identity, so personal spaces fail closed unless the operator binds the deployment to one stable `MCP_ACCESS_KEY_PRINCIPAL`; every key holder then acts as that same principal. This door exists only on the local install; the publicly-reachable deployments leave it off.

**Funnel / Qubes (OAuth-only).** The static key is removed entirely — the server does not accept an `x-brain-key` at all (a presented one is ignored, since no key is configured to match). Anyone on the internet who (a) originates from Anthropic's published egress range `160.79.104.0/21` and (b) presents a valid RS256 JWT with the configured issuer, audience, `exp`, and `sub` may use registered workspace/project audiences. Identity rests entirely on your OAuth tenant's user management and client-credential hygiene. PostgreSQL RLS partitions `personal` rows by the verified `sub`; workspace/project audiences remain shared because this release has no membership ACL. Collapsing to a single OAuth door on every publicly-reachable deployment removes a second static credential to rotate and leak; the local install keeps the `x-brain-key` door for environments where standing up an OAuth tenant isn't practical.

The complete audience union, seeded personal-only `sensitive` workspace, and
operator contract are in [Memory spaces](spaces.md). `sensitive` is access
control, not additional at-rest encryption: database administrators and backup
dumps can still read it.

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
- Auth-failure responses are uniform: **every** rejection — missing, invalid, or expired credentials — gets HTTP 401 + `WWW-Authenticate` (RFC 6750 / MCP authorization spec), with a JSON-RPC error envelope body for MCP id correlation. The transport-level 401 is what OAuth-capable clients key credential refresh and re-authorization off; an earlier revision answered tried-but-invalid credentials with HTTP 200 + envelope (a keep-alive theory) and stranded connectors after token expiry until a human reauthenticated. Operator-facing messages are collapsed to a single "unauthorized" — the granular reason goes to the audit table, not to the caller, closing a credential-status side-channel.
- Captured content is hard-capped (100,000 UTF-8 bytes) on both `capture_thought` and `session_capture`; the REST gateway enforces the identical cap via the same shared schema module, plus a 1 MiB request-body limit for tailnet-direct callers that have no Caddy edge in front of them.
- Session provenance (`source`, `source_node`) is stamped server-side from the transport; caller-supplied values are ignored. Thought transport provenance (`metadata.source`, `door`, `sub`) and classifier provenance (`metadata.metadata_extraction`) are likewise server-stamped. Optional thought `author` / `agent` / `repo` / `branch` values live under a [versioned `metadata.provenance.caller_asserted` contract](thought-provenance.md): authenticated input, but explicitly **not** verified identity.
- Every thought/session operation resolves one registered workspace before upstream embedding work, then installs its workspace, optional project, verified principal, and allowed visibility union as transaction-local PostgreSQL settings. Omission selects one configured default workspace, never every workspace. Unknown or misspelled scope fails validation; personal scope without a principal fails closed.
- The REST gateway (`/api/v1`) is opt-in (`ENABLE_REST_API`, default off) and sits behind the same `requireAuth` doors and audit path as `/mcp`. When the flag is unset — as on the Qubes deployment, which deliberately never sets it — the router is not mounted and the surface does not exist. On the Funnel deployment Caddy 404s `/api/v1*` on the public branch (same mechanism as `/ready`), so REST is tailnet-only even where enabled; auth failures on REST return a plain HTTP 401 JSON error instead of the MCP JSON-RPC envelope body, with the same collapsed "unauthorized" message.

### Database layer

Five roles, least privilege, with drift detection:

| Role | Privileges | Used by |
|---|---|---|
| `postgres` | superuser | init + DB admin (role provisioning / migrations) — never the app runtime. In the three-qube split it's reachable from the app qube's IP only for remote admin — a deliberate trade-off (a compromised app qube then has full DB admin, including an app→db OS pivot via `COPY … TO/FROM PROGRAM`); see [db-qube/README.md](../deploy/qubes/db-qube/README.md) and [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15) |
| `openbrain_app` | SELECT/INSERT/UPDATE on `thoughts` (+ scoped observability/sessions grants); SELECT/INSERT-only on metadata-degradation history, SELECT/INSERT/DELETE on its transient outbox, and SELECT/UPDATE on its singleton delivery ledger; **no thought/history DELETE**, no schema-wide DML, and no role memberships | MCP server, daily summary, metadata notification worker |
| `openbrain_ingester` | INSERT-only on `funnel_access_log` | log-ingester sidecar — it parses attacker-influenced log lines, so its blast radius is one table |
| `openbrain_monitor` | SELECT on `funnel_access_log` + `mcp_auth_events` only | host-side funnel monitor ([`scripts/funnel_monitor.sh`](../scripts/funnel_monitor.sh)) — its credential sits on the internet-adjacent edge, so it reads request metadata but can never reach a thought. Optional, like the ingester |
| `openbrain_readonly` | SELECT on everything + `BYPASSRLS` so full `pg_dump` works; no DML | trusted backup job, humans with psql/DBeaver |

`db/06-spaces.sql` forces RLS on thoughts, sessions, and artifacts for the application role. Missing transaction context matches no rows, personal rows require the current trusted principal, and project/workspace rows must match the resolved registered scope. The application cannot mutate the workspace registry. Hybrid search's narrowly scoped `SECURITY DEFINER` candidate function uses fixed SQL, returns IDs/ranks only, explicitly reapplies the audience, and revokes PostgreSQL's default `PUBLIC` execute grant; returned content is rechecked through the RLS-protected table. The trusted read-only backup role has SELECT grants plus `BYPASSRLS`, which PostgreSQL's full `pg_dump` requires after it sets `row_security=off`; it has no permissive RLS policy and no DML. The grants assertion requires `openbrain_app` to have neither direct bypass flags nor any role membership, closing both inherited-privilege and `SET ROLE` paths.

`db/07-metadata-degradation.sql` records only thought/capture identifiers,
finite outcome/reason codes, status, timestamp, and credential-scrubbed endpoint
identity—never thought content. The thought upsert and its event rows share one
transaction with a transient outbox enqueue. The application role cannot update
or delete history; it can consume committed outbox rows. The single mutable
state row contains only finite counts, cooldown state, and the latest failed
delivery-channel set. Owner-directed thought deletion nulls the history link
instead of erasing the audit or blocking deletion. The grant assertion covers
all three relations and the event sequence, including effective `PUBLIC`
access.

`db/01-schema.sql` actively REVOKEs historical broad grants (idempotent, safe on live DBs), and `db/03-grants-assertion.sql` is a read-only invariant check you can run any time — because init scripts only run on a fresh data directory, a tightened grant **does not** reach an existing deployment by itself. Its monitor check scans every non-system application relation across schemas, rejects default ACLs that would grant future relations to the monitor or `PUBLIC`, and permits only the two observability tables, so future relation grants fail closed without extending a denylist. The assertion is how you notice. This invariant is relation-scoped: PostgreSQL grants function execution to `PUBLIC` by default, so any future `SECURITY DEFINER` routine must revoke that default and receive a separate security review.

### Container layer

- `mcp` and `log-ingester`: non-root user, `cap_drop: [ALL]`, `read_only: true` rootfs, size-capped tmpfs, `no-new-privileges`.
- `caddy`: a derived image strips the binary's file capability so a genuinely empty capability set works; read-only rootfs; logs on a dedicated volume the ingester mounts **read-only** (a compromised ingester can't tamper with the on-disk audit evidence — its cursors live on a separate volume).
- `ollama`/`postgres`: `no-new-privileges`; lighter hardening where init or GPU paths need it, with the reasoning inline in the compose file.

### Audit layer

- Caddy redacts `Authorization`, `X-Brain-Key`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` at format level from **both the per-handle access logs and the process-level error log** — the latter matters because `reverse_proxy` warnings otherwise serialize the full request header map (incl. a Bearer) to `docker logs`; the ingester additionally keeps only UA + Host from headers and strips query strings.
- Every 401 inserts a reason-coded row into `mcp_auth_events` (fire-and-forget, with an in-flight cap so a 401 flood can't queue unbounded memory).
- Every degraded classification appends history plus a transactional outbox row in the thought transaction. The optional Pushover/ntfy worker consumes only committed queue rows and selects finite codes and counts—never thought IDs/content or endpoint identity. A locked durable ledger coordinates replicas. Provider errors are redacted and failed channels from the latest attempt are recorded; delivery is at-least-once, so a crash after provider acceptance but before commit may duplicate an alert rather than lose one.
- A daily rollup retains a year of trend data after raw rows age out at 30 days.

### Supply chain / process

- Base images pinned by version (`pgvector/pgvector:pg16`, `denoland/deno:2.9.4`, `caddy:2.11.3-alpine` with `pull: true` so a stale local cache can't feed an older base into the perimeter image; `ollama/ollama` pinned, not `:latest`).
- A CI guard (`server/scripts/check_allow_env.ts`) keeps the Dockerfile's `--allow-env` list in lockstep with every `Deno.env.get` in the code — drift here is a silent boot failure.
- A leak-gate CI job greps every push for credential patterns and private-infrastructure identifiers.

## Known limitations

- **No workspace/project membership ACL yet.** Personal visibility is partitioned by verified/configured principal, but every authenticated caller may name any registered workspace or project and therefore shares those non-personal audiences. This supports today's single-user organization and a personal sensitive space, but is not complete multi-tenant authorization.
- **`sensitive` is not at-rest encryption.** The database owner and `openbrain_readonly` backup role can read personal rows; dumps include them. Disk, dump, and operator access remain part of the trusted boundary.
- **The application process/DB credential is trusted for scope.** RLS consumes transaction-local context installed by the server; a normal API/MCP caller cannot author it, but an attacker with `openbrain_app` SQL access can. Personal isolation protects callers from each other and catches missing predicates, not a compromised app tier.
- **Spaces do not alter model routing.** Sensitive content still reaches configured embedding/classification endpoints. A hosted fallback can therefore off-box it; use local endpoints or disable that fallback for a network-confined sensitive store.
- **Notification providers see operational metadata.** When explicitly enabled, Pushover/ntfy receives the operator-chosen label, timestamps, finite degradation classes/reasons, and counts. It receives no thought content, thought ID, endpoint identity, hostname, or credential from the server-generated payload. Delivery credentials and an unguessable ntfy topic remain machine-local secrets.
- **Thought attribution is last-writer-wins on dedupe.** Re-capturing byte-identical content through another door updates the stored `door`/`sub`; supplying new caller provenance replaces the prior versioned claims object. Attribution reflects the most recent applicable capture, not the first, and one deduplicated row is not a contributor history. Omitting optional provenance preserves prior claims.
- **`/caddy-health` is reachable from any source** — required for the docker healthcheck; a public scanner can learn "Caddy is up" from it. Accepted as a minor info leak.
- **`/ready` is unauthenticated** — it returns DB *connectivity* (not data), so it must never be served publicly: Caddy `404`s it on the funnel branch, leaving it reachable only from loopback, the container healthcheck, and tailnet-direct/in-qube callers. Previously a credential was required even from loopback; dropping it is a deliberate defense-in-depth reduction so uptime monitors and the in-container healthcheck can probe without a secret. Residual risk: a Caddy bypass or a misconfigured Qubes firewall would expose the "DB reachable?" signal. Network binding (loopback / Docker network) and the funnel-404 are the only controls.
- **Funnel availability caveats** — see the limitations table in [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Edge↔store isolation (Qubes path)** — resolved by the [three-qube split](../deploy/qubes/three-qube-design.md): Funnel + Caddy (ingress qube), mcp + Ollama (app qube), and Postgres (db qube) run in separate VMs over a firewall-scoped tailnet, so a compromised public edge holds no memory store and no app credential. The single-host install paths still co-locate these by design (one trust boundary).
