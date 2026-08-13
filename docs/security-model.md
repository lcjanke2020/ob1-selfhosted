# Security model

What this stack trusts, what it doesn't, and what each layer is allowed to do
after the layer above it fails. The companion doc
[`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) covers the transferable
pattern for running _any_ MCP server behind Tailscale Funnel; the assembled
one-page view of the whole model is [`threat-model.md`](threat-model.md).

## Trust boundaries

The system has **two auth doors, chosen per deployment** — typically one, though
the local single-box install may run both (it's the only place that's intended;
the boot log warns when both are on). `ENABLE_NATIVE_TOKENS` and the legacy
`MCP_ACCESS_KEY` independently enable credential types on the local
`x-brain-key` door; the three `AUTH0_*` vars enable the OAuth door. The server
refuses to boot with neither door configured.

**Local single-box install (`x-brain-key`).** The private door is intended for
loopback/LAN (or your tailnet if you front it with `tailscale serve`). Its
default credentials are labeled native tokens: 256-bit random secrets shown
once, stored only as SHA-256 digests, looked up on every request, and revoked
independently. The static shared key remains a migration bridge. Anyone who can
reach the box and present any active credential can read/write registered
workspace and project audiences — treat every token like a database password and
your network ACLs as the firewall. Token labels are attribution, not per-user
identity, so personal spaces fail closed unless the operator binds the
deployment to one stable `MCP_ACCESS_KEY_PRINCIPAL`; every token holder then
acts as that same principal. See
[Native access tokens](native-access-tokens.md).

**Funnel / Qubes (OAuth-only).** The static key is empty and native token
verification is explicitly disabled — the server ignores every presented
`x-brain-key`. Public Funnel callers must originate from Anthropic's published
egress range `160.79.104.0/21`; private tailnet callers bypass that public
matcher. Both paths must present a valid RS256 JWT with the configured issuer,
audience, `exp`, and `sub`. The subject may represent an interactive user or a
[client-credentials service account](service-account-oauth-client.md); identity
rests entirely on OAuth tenant administration and credential hygiene. PostgreSQL
RLS partitions `personal` rows by the verified `sub`; workspace/project
audiences remain shared because this release has no membership ACL.

The complete audience union, seeded personal-only `sensitive` workspace, and
operator contract are in [Memory spaces](spaces.md). `sensitive` is access
control, not additional at-rest encryption: database administrators and backup
dumps can still read it.

## Layered controls

### Network layer

- Every OB1 container service binds `127.0.0.1` only — on the single-host
  install paths the LAN can't reach any port directly, and exposure is an
  explicit `tailscale serve`/`funnel` act. This now includes the split-Qubes app
  qube: its `mcp` publishes loopback only, and the ingress qube's Caddy reaches
  it over a dom0-policy-gated `qubes.ConnectTCP` channel (a socat forwarder on
  the ingress qube bridges Caddy to the qrexec call). There is no network-facing
  mcp listener to scope — an earlier revision published `0.0.0.0:8787` and
  scoped the wide bind with a Tailscale ACL grant plus a `DOCKER-USER`
  host-firewall rule that had to stay continuously correct; the qrexec transport
  removed that listener class entirely. See
  [the ingress→app hop](../deploy/qubes/ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp).
  The db qube's Postgres rides the same pattern: it binds **loopback only**, and
  the app qube reaches it through a host-side forwarder over a second
  dom0-policy-gated `qubes.ConnectTCP` channel
  ([the app→db hop](../deploy/qubes/app-qube/README.md#the-appdb-hop-qubesconnecttcp))
  — the tailnet listener and its three-layer ACL + nftables + `pg_hba`-source
  scoping are retired. The only deliberate **non-loopback listeners** left in
  the split topology are the host-side qrexec forwarders themselves, which bind
  their qube's own IP (reachable only from that qube's own workloads — the qubes
  input chain default-drops eth0/tailnet sources).
- In Pattern B the override file **removes** mcp's host port
  (`ports: !reset null`). The raw backend is unreachable from the host, so a
  misconfigured `tailscale funnel` pointed at `:8787` fails closed instead of
  reaching mcp directly past the Caddy perimeter (IP allowlist, body cap,
  logging).
- **Primary public perimeter — the Anthropic IP allowlist.** Caddy's funnel
  branch enforces `client_ip 160.79.104.0/21` (XFF-resolved), with
  `trusted_proxies static private_ranges` + `trusted_proxies_strict` so
  forwarding headers are honored only from the loopback proxy peer. This is the
  _only_ network-layer control between the public internet and the MCP server —
  non-Anthropic funnel traffic is `403`'d before the backend is touched. It must
  never be silently dropped; a CI guard
  (`.github/workflows/allowlist-guard.yml`) fails the build if the CIDR
  disappears from the Caddyfile. A tailnet client can't escalate into the funnel
  branch either: the discriminating `Tailscale-Funnel-Request` header is
  injected by `tailscaled` itself, not controllable by clients.
- **Credentials are not stripped per-branch.** The server decides per deployment
  which door it accepts: on OAuth-only Funnel/Qubes deployments `MCP_ACCESS_KEY`
  is unset and `ENABLE_NATIVE_TOKENS=false`, so every presented `x-brain-key` is
  ignored; the local install accepts configured native/static credentials.
  Either way the access-log `format filter` deletes both credential headers
  (`X-Brain-Key`, `Authorization`) so neither reaches disk. App-layer
  `requireAuth` is the load-bearing check.

### Application layer

- At least one auth door must be configured or the server refuses to boot —
  there is no accidental no-auth deployment. Native tokens are opt-in at the
  server and default on only in local compose; invalid flag values fail startup.
  When the legacy static credential is set, its minimum length of 32 is enforced
  at boot. Native tokens have a fixed format and 256-bit random secret;
  authentication hashes before a prefix-indexed lookup and uses a constant-time
  digest comparison, including a dummy comparison for unknown prefixes. Every
  request re-reads revocation state, and storage errors fail closed. The boot
  log states which door(s) are active and warns if the `x-brain-key` and OAuth
  doors are both on (intended for a private local install only).
- Bearer validation pins issuer, audience, algorithm (RS256), and requires `exp`
  plus a bounded, non-empty, control-free string `sub`; verification fails
  closed before any source-marker stamping runs. Only after verification does a
  signed `gty=client-credentials` claim (including Auth0's default token
  profile)—or an exact operator-configured subject for Auth0's RFC 9068 profile
  or another issuer—select the `service` provenance label. That mapping changes
  neither authentication nor authorization.
- **Authorization is in-app, not delegated to the tenant.** After every
  cryptographic check passes, the verified `sub` must appear on the
  `OAUTH_ALLOWED_SUBJECTS` allowlist or the request is rejected — with the same
  uniform 401 as any other failure externally, and reason `subject_not_allowed`
  plus the verified subject on the audit row internally. The list fails
  **closed**: with the OAuth door enabled and the list unset or empty, every
  Bearer is rejected (the boot log warns loudly). This exists because "the
  tenant minted this token" and "the operator admits this account" are different
  questions: an IdP-side misconfiguration — an accidentally-enabled social
  connection, an unintended signup flow — mints perfectly valid tokens for
  accounts the operator never meant to admit, and tenant configuration must not
  be the only gate. The `OAUTH_SERVICE_ACCOUNT_SUBJECTS` attribution list never
  grants access; a machine subject must also be allowlisted.
- A boot-time JWKS reachability probe (with an explicit wall-clock timeout that
  also caps every later refresh) surfaces a typo'd JWKS URI at startup rather
  than at the first attacker request.
- Auth-failure responses are uniform: **every** rejection — missing, invalid, or
  expired credentials — gets HTTP 401 + `WWW-Authenticate` (RFC 6750 / MCP
  authorization spec), with a JSON-RPC error envelope body for MCP id
  correlation. The transport-level 401 is what OAuth-capable clients key
  credential refresh and re-authorization off; an earlier revision answered
  tried-but-invalid credentials with HTTP 200 + envelope (a keep-alive theory)
  and stranded connectors after token expiry until a human reauthenticated.
  Operator-facing messages are collapsed to a single "unauthorized" — the
  granular reason goes to the audit table, not to the caller, closing a
  credential-status side-channel.
- **Both auth outcomes are audited, not just rejections.** Each auth decision
  enqueues one `mcp_auth_events` row recording, for admissions, the verified
  identity (`subject` for OAuth, `token_label` for native tokens), the door, the
  path, and the client IP — so "who accessed this server in the last N days" is
  answerable from local data rather than from the IdP's logs, up to the queue
  semantics that follow. The write is deliberately **best-effort telemetry
  through one shared queue, not a durable ledger**: fire-and-forget (Postgres
  latency never extends a response, and audit unavailability never denies
  service), with a single in-flight cap shared by BOTH outcomes. When inserts
  back up past that cap — sustained database distress, or request volume
  outrunning the queue (a sustained 401 flood is attacker-reachable and can
  saturate it) — events are dropped **regardless of outcome or identity**: a
  flood of denials can shed admission rows for unrelated identities arriving in
  the same window. The drop counter and its rate-limited warning evidence that a
  gap exists and how many events it swallowed; they cannot reconstruct which
  events — or whose — are missing. Two bounds remain hard: a boot-time schema
  probe refuses to start against a pre-audit table shape (a missed migration is
  a loud refusal, never a silent drop), and the gap is always self-announcing
  (counted + warned). The inverse design — blocking each request on a durable
  audit write — would hand the audit path a denial-of-service lever over the
  whole server; the opt-in fail-closed mode, and any per-outcome quota or
  reservation scheme, are tracked separately (GH #88).
- **Audit retention keys on verified identity.** Rows naming a real,
  tenant-minted identity keep 365 days: every allowed row, plus
  `subject_not_allowed` denials (which verified identity knocked and was refused
  — the question an incident review asks months later). Anonymous denials
  (scanner noise, credential fumbles) keep 30 days, matched to the raw access
  log so a 401 and the request that produced it age out together. The long
  horizon is identity- and time-bounded, not size-bounded: those rows require a
  Bearer the tenant actually minted — which bounds **who** can grow the table,
  not how many rows a single credential can generate — so growth tracks
  legitimate use, an accepted storage trade-off. A stolen credential inflating
  it is loud in the very table it inflates (and in the edge burst alerts), and
  the horizon is a one-line operator lever in `db/summarize_auth_events.sql`.
  Only server-verified identity lands in the table — never as-presented
  credentials or header values.
- Captured content is hard-capped (100,000 UTF-8 bytes) on both
  `capture_thought` and `session_capture`; the REST gateway enforces the
  identical cap via the same shared schema module, plus a 1 MiB request-body
  limit for tailnet-direct callers that have no Caddy edge in front of them.
- Session provenance (`source`, `source_node`) is stamped server-side from the
  credential context; caller-supplied values are ignored. Thought transport
  provenance (`metadata.source`, `door`, `sub`, `token_label`) and classifier
  provenance (`metadata.metadata_extraction`) are likewise server-stamped. OAuth
  user writes use `door=funnel`, OAuth machine writes use `door=service`, and
  native/static writes use `door=tailnet`; a native token's non-secret label is
  also stamped while the static key has `token_label=null`. These compatibility
  labels do not assert which Caddy socket carried the request. Optional thought
  `author` / `agent` / `repo` / `branch` values live under a
  [versioned `metadata.provenance.caller_asserted` contract](thought-provenance.md):
  authenticated input, but explicitly **not** verified identity.
- Every thought/session operation resolves one registered workspace before
  upstream embedding work, then installs its workspace, optional project,
  verified principal, and allowed visibility union as transaction-local
  PostgreSQL settings. Omission selects one configured default workspace, never
  every workspace. Unknown or misspelled scope fails validation; personal scope
  without a principal fails closed.
- The REST gateway (`/api/v1`) is opt-in (`ENABLE_REST_API`, default off) and
  sits behind the same `requireAuth` doors and audit path as `/mcp`. When the
  flag is unset — as on the Qubes deployment, which deliberately never sets it —
  the router is not mounted and the surface does not exist. On the Funnel
  deployment Caddy 404s `/api/v1*` on the public branch (same mechanism as
  `/ready`), so REST is tailnet-only even where enabled; auth failures on REST
  return a plain HTTP 401 JSON error instead of the MCP JSON-RPC envelope body,
  with the same collapsed "unauthorized" message.

### Database layer

Pattern B uses two disjoint clusters, each with least-privilege roles and drift
detection:

| Role                    | Privileges                                                                                                                                                                                                                                                                                                                                                                                           | Used by                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`              | superuser                                                                                                                                                                                                                                                                                                                                                                                            | init + DB admin (role provisioning / migrations) — never the app runtime. In the three-qube split it's reachable only through the app qube's dom0-gated ConnectTCP channel for remote admin — a deliberate trade-off (a compromised app qube then has full DB admin, including an app→db OS pivot via `COPY … TO/FROM PROGRAM`); see [db-qube/README.md](../deploy/qubes/db-qube/README.md) and [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15) |
| `openbrain_app`         | SELECT/INSERT/UPDATE on `thoughts` (+ scoped corpus auth-event/sessions grants); SELECT/INSERT-only on metadata-degradation history, SELECT/INSERT/DELETE on its pending-delivery outbox, SELECT/UPDATE on its singleton delivery ledger, and SELECT of only the four native-token verification fields; **no thought/history DELETE or token mutation**, no schema-wide DML, and no role memberships | MCP server, auth-event summary, metadata notification worker                                                                                                                                                                                                                                                                                                                                                                                                   |
| `openbrain_ingester`    | INSERT-only on `funnel_access_log`                                                                                                                                                                                                                                                                                                                                                                   | log-ingester sidecar on the separate log sink — it parses attacker-influenced log lines, so its database blast radius is one disposable table and the role name is rejected by the corpus                                                                                                                                                                                                                                                                      |
| `openbrain_monitor`     | SELECT on `funnel_access_log` only                                                                                                                                                                                                                                                                                                                                                                   | host-side funnel monitor ([`scripts/funnel_monitor.sh`](../scripts/funnel_monitor.sh)) on the separate sink; it cannot read even the aggregate table, much less a thought or reason-coded auth event                                                                                                                                                                                                                                                           |
| `openbrain_logs_rollup` | SELECT/DELETE on `funnel_access_log`; SELECT/INSERT/UPDATE/DELETE on `funnel_access_summary`                                                                                                                                                                                                                                                                                                         | target-pinned sink summary and retention job; no schema creation and no corpus presence                                                                                                                                                                                                                                                                                                                                                                        |
| `openbrain_token_admin` | Lists token ID/prefix/label/timestamps and executes fixed register/revoke functions; cannot read hashes, memories, or mutate the table directly                                                                                                                                                                                                                                                      | profile-gated one-shot `token-admin` CLI; `NOLOGIN` when no password is provisioned                                                                                                                                                                                                                                                                                                                                                                            |
| `openbrain_readonly`    | SELECT on everything + `BYPASSRLS` so full `pg_dump` works; no DML                                                                                                                                                                                                                                                                                                                                   | trusted backup job, humans with psql/DBeaver                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Where those roles live in every Pattern B deployment.** The corpus holds only
its own `postgres`, `openbrain_app`, `openbrain_readonly`, and
`openbrain_token_admin`. `openbrain_ingester`, `openbrain_monitor`, and
`openbrain_logs_rollup` are roles on a **separate cluster**: a socket-only
Funnel-log sink holding two request-metadata relations and nothing else
([`deploy/qubes/ingress-qube/README.md`](../deploy/qubes/ingress-qube/README.md#local-log-sink)).
The rollup name stays apart from `openbrain_app` so no sink credential can be
mistaken for a corpus credential.

The point is not the grants but the layer they sit at. Grants are enforced
_inside_ Postgres, above where a pre-auth wire-protocol or SCRAM-handshake flaw
would live; an INSERT-only role bounds a well-behaved client, not one that never
reaches the grant check. Moving the edge's store into a no-network sibling
cluster removes the route instead of narrowing what can be done over it. On a
single host this is a container/process boundary, not a VM boundary: host-root
compromise still reaches both volumes, but a compromised networkless ingester
has no database transport toward the corpus.

`db/06-spaces.sql` forces RLS on thoughts, sessions, and artifacts for the
application role. Missing transaction context matches no rows, personal rows
require the current trusted principal, and project/workspace rows must match the
resolved registered scope. The application cannot mutate the workspace registry.
Hybrid search's narrowly scoped `SECURITY DEFINER` candidate function uses fixed
SQL, returns IDs/ranks only, explicitly reapplies the audience, and revokes
PostgreSQL's default `PUBLIC` execute grant; returned content is rechecked
through the RLS-protected table. The trusted read-only backup role has SELECT
grants plus `BYPASSRLS`, which PostgreSQL's full `pg_dump` requires after it
sets `row_security=off`; it has no permissive RLS policy and no DML. The grants
assertion requires `openbrain_app` to have neither direct bypass flags nor any
role membership, closing both inherited-privilege and `SET ROLE` paths.

`db/07-metadata-degradation.sql` records only thought/capture identifiers,
finite outcome/reason codes, status, timestamp, and credential-scrubbed endpoint
identity—never thought content. The thought upsert and its event rows share one
transaction with a durable pending-delivery outbox enqueue. The application role
cannot update or delete history; it can consume committed outbox rows. The
single mutable state row contains only finite counts, cooldown state, and the
latest failed delivery-channel set. Owner-directed thought deletion nulls the
history link instead of erasing the audit or blocking deletion. The grant
assertion covers all three relations and the event sequence, including effective
`PUBLIC` access.

`db/08-access-tokens.sql` isolates credential material in `native_auth`. The
application role can perform only its bounded prefix/hash/revocation lookup; the
dedicated administrator lists non-secret metadata and mutates lifecycle state
only through two owner-controlled, fixed-search-path `SECURITY DEFINER`
functions. PostgreSQL's default `PUBLIC` function execution is revoked. The
grant assertion verifies exact column privileges, function ownership/config,
standalone role membership, sequence access, and backup visibility.

`db/01-schema.sql` actively REVOKEs historical broad grants (idempotent, safe on
live DBs), and `db/03-grants-assertion.sql` is a read-only invariant check you
can run any time — because init scripts only run on a fresh data directory, a
tightened grant **does not** reach an existing deployment by itself. Arc B
inverts the old monitor allowlist: the corpus assertion rejects either edge role
name, every `public.funnel_access_*` relation, matching `pg_hba_file_rules`, and
any HBA parse error that would make absence unprovable. The runbook archives
first; the archive-gated `db/09` migration then drops the old shape without
`CASCADE`. The separate sink assertion independently pins its exact roles,
relations, and grants. PostgreSQL grants function execution to `PUBLIC` by
default, so any future `SECURITY DEFINER` routine must revoke that default and
receive a separate security review.

### Container layer

- `mcp` and `log-ingester`: non-root user, `cap_drop: [ALL]`, `read_only: true`
  rootfs, size-capped tmpfs, `no-new-privileges`; Pattern B additionally gives
  the ingester `network_mode: none` and only the sink socket bind.
- `token-admin`: the same container hardening, profile-gated and one-shot. Only
  it receives the dedicated lifecycle password; the long-running MCP container
  never does.
- `caddy`: a derived image strips the binary's file capability so a genuinely
  empty capability set works; read-only rootfs; logs on a dedicated volume the
  ingester mounts **read-only** (a compromised ingester can't tamper with the
  on-disk audit evidence — its cursors live on a separate volume).
- `ollama`/`postgres`: `no-new-privileges`; lighter hardening where init or GPU
  paths need it, with the reasoning inline in the compose file.

### Audit layer

- Caddy redacts `Authorization`, `X-Brain-Key`, `Cookie`, `Set-Cookie`,
  `Proxy-Authorization` at format level from **both the per-handle access logs
  and the process-level error log** — the latter matters because `reverse_proxy`
  warnings otherwise serialize the full request header map (incl. a Bearer) to
  `docker logs`; the ingester additionally keeps only UA + Host from headers and
  strips query strings.
- Each auth decision enqueues a row into `mcp_auth_events` — reason-coded
  denials AND per-request admissions with the verified identity
  (fire-and-forget, with an in-flight cap so a 401 flood can't queue unbounded
  memory; best-effort semantics above — either outcome can drop under
  saturation).
- Successful writes carry the server-owned credential label and verified
  subject, distinguishing `service` machine identities from `funnel` user
  identities. Reads are covered at request-level granularity by the best-effort
  `mcp_auth_events` admission row (who authenticated, to which path, when —
  delivery gaps possible and self-announcing); there is no per-tool or per-row
  read audit in this release — Caddy retains request metadata only. Failed
  tokens are not classified as machine or user because their unverified claims
  are attacker-controlled.
- Every degraded classification appends history plus a transactional outbox row
  in the thought transaction. The optional Pushover/ntfy worker consumes only
  committed queue rows and selects finite codes and counts—never thought
  IDs/content or endpoint identity. A locked durable ledger coordinates
  replicas. Provider errors are redacted and failed channels from the latest
  attempt are recorded; delivery is at-least-once, so a crash after provider
  acceptance but before commit may duplicate an alert rather than lose one.
- On the split deployment, the optional ingress-host monitor counts newly
  ingested public-door 401 rows behind a monotonic row-ID cursor. A qualifying
  burst sends one Pushover notification; further qualifying burst windows
  accumulate into bounded rollups. A single-instance lock serializes cursor
  updates; cursor and pending count are atomically persisted before delivery,
  failed sends retain their count, and the alert body contains only a generic
  label plus the aggregate Funnel 401-row count—never IPs, paths, request
  content, identities, application/database/client credentials, or
  infrastructure names. Pushover's own delivery token and user key necessarily
  authenticate the provider request. The monitor is alert-only and never changes
  Funnel or firewall state.
- A daily rollup retains a year of trend data after raw rows age out at 30 days.

### Supply chain / process

- Base images pinned by version (`pgvector/pgvector:0.8.6-pg16`,
  `denoland/deno:2.9.4`, `caddy:2.11.3-alpine` with `pull: true` so a stale
  local cache can't feed an older base into the perimeter image; `ollama/ollama`
  pinned, not `:latest`).
- A CI guard (`server/scripts/check_allow_env.ts`) rejects unrestricted or
  dynamic checked-in Deno launchers and keeps Dockerfile/effective Compose-stack
  allowlists in lockstep with statically reachable env reads plus explicit
  out-of-tree dependency policies. Compose services inherit audited launcher
  defaults from their checked-in build Dockerfiles before overrides are applied;
  unresolved image defaults (image-only services need a reviewed non-Deno pin),
  Compose merge tags on launcher-relevant fields, and shell positional
  boundaries fail closed. The checked-in Deno import configuration is pinned as
  part of that audit, while custom config/import-map semantics and Node's
  `process.env` surface are rejected. Host-local systemd units are outside
  repository CI and require the documented real-entrypoint pre-restart probe in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md#native-deno-launchers).
- A leak-gate CI job greps every push for credential patterns and
  private-infrastructure identifiers.

## Known limitations

- **No workspace/project membership ACL yet.** Personal visibility is
  partitioned by verified/configured principal, but every authenticated caller
  may name any registered workspace or project and therefore shares those
  non-personal audiences. This supports today's single-user organization and a
  personal sensitive space, but is not complete multi-tenant authorization.
- **`sensitive` is not at-rest encryption.** The database owner and
  `openbrain_readonly` backup role can read personal rows; dumps include them.
  Disk, dump, and operator access remain part of the trusted boundary.
- **The application process/DB credential is trusted for scope.** RLS consumes
  transaction-local context installed by the server; a normal API/MCP caller
  cannot author it, but an attacker with `openbrain_app` SQL access can.
  Personal isolation protects callers from each other and catches missing
  predicates, not a compromised app tier.
- **Spaces do not alter model routing.** Sensitive content still reaches
  configured embedding/classification endpoints. A hosted fallback can therefore
  off-box it; use local endpoints and `METADATA_FALLBACK_POLICY=off` for a
  network-confined sensitive store.
- **Notification providers see operational metadata.** When explicitly enabled,
  Pushover/ntfy receives the operator-chosen label, timestamps, finite
  degradation classes/reasons, and counts; the ingress-host Pushover leg also
  reveals that an aggregate public-door auth-failure burst occurred and its
  Funnel 401-row count. Alert bodies send no thought content, thought IDs,
  endpoint identity, hostnames, client IPs, request paths/content, or
  application/database/client credentials. Each provider necessarily receives
  its own delivery credential; those credentials and an unguessable ntfy topic
  remain machine-local configuration and never enter alert bodies or logs.
- **Thought attribution is last-writer-wins on dedupe.** Re-capturing
  byte-identical content through another door updates the stored `door`/`sub`;
  supplying new caller provenance replaces the prior versioned claims object.
  Attribution reflects the most recent applicable capture, not the first, and
  one deduplicated row is not a contributor history. Omitting optional
  provenance preserves prior claims.
- **`/caddy-health` is reachable from any source** — required for the docker
  healthcheck; a public scanner can learn "Caddy is up" from it. Accepted as a
  minor info leak.
- **`/ready` is unauthenticated** — it returns DB _connectivity_ (not data), so
  it must never be served publicly: Caddy `404`s it on the funnel branch,
  leaving it reachable only from loopback, the container healthcheck, and
  tailnet-direct/in-qube callers. Previously a credential was required even from
  loopback; dropping it is a deliberate defense-in-depth reduction so uptime
  monitors and the in-container healthcheck can probe without a secret. Residual
  risk: a Caddy bypass or a misconfigured Qubes firewall would expose the "DB
  reachable?" signal. Network binding (loopback / Docker network) and the
  funnel-404 are the only controls.
- **Funnel availability caveats** — see the limitations table in
  [`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md).
- **Edge↔store isolation (Qubes path)** — resolved by the
  [three-qube split](../deploy/qubes/three-qube-design.md): Funnel + Caddy
  (ingress qube), mcp + Ollama (app qube), and Postgres (db qube) run in
  separate VMs, so a compromised public edge holds no memory store and no app
  credential. The ingress→app hop rides a dom0-policy-gated `qubes.ConnectTCP`
  channel (the app qube has no network-facing listener); the app→db hop rides a
  second such channel (the db qube's Postgres binds loopback only — no tailnet
  listener). Single-host Pattern B uses the same separate, socket-only log
  cluster and networkless ingester, but remains one host trust boundary rather
  than claiming Qubes-equivalent isolation.
