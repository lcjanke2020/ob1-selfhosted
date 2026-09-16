# Security model

Passage vectors are dependent index data protected by forced RLS through their
canonical thought/session parent. Source changes invalidate vectors atomically;
audience moves immediately change their visibility. The app can read the active
embedding generation but cannot activate one. See the
[embedding migration contract](embedding-limits.md) for the owner-only offline
backfill, whole-corpus readiness gate and runtime/model identity boundary.

What this stack trusts, what it doesn't, and what each layer is allowed to do
after the layer above it fails. The companion doc
[`funnel-mcp-perimeter.md`](funnel-mcp-perimeter.md) covers the transferable
pattern for running _any_ MCP server behind Tailscale Funnel; the assembled
one-page view of the whole model is [`threat-model.md`](threat-model.md).

## Trust boundaries

The system supports native/static `x-brain-key` credentials and OAuth Bearer
credentials. At least one must be configured. Local Compose defaults to native
tokens; single-host Pattern B remains OAuth-only. Split Qubes can enable native
tokens on its tailnet branch after migration and proxy verification. The public
Funnel branch always requires OAuth and the Anthropic egress allowlist.

**Local single-box install.** Native tokens contain 256-bit random secrets, are
stored only as SHA-256 digests, and are checked on every request. Each has an
explicit stable `native:<id>` principal for personal memory; labels identify
writes independently of ownership. The static shared key remains supported, with
`MCP_ACCESS_KEY_PRINCIPAL` applying only to that static credential. Older native
tokens have no principal and fail closed for personal/sensitive scope. All
authenticated holders still share registered workspace/project audiences. See
[Native access tokens](native-access-tokens.md).

**Funnel / Qubes.** Public requests first pass the `160.79.104.0/21` Anthropic
IP allowlist, then verify an RS256 JWT with the configured issuer, audience,
expiry and admitted subject. Caddy removes `X-Brain-Key` and any caller-supplied
`X-OpenBrain-Tailnet` from that branch. On the private tailnet branch, OAuth
continues to work; optionally enabled native tokens additionally require Caddy's
replaced `X-OpenBrain-Tailnet: 1` marker and an absent Funnel header. The marker
is trusted only because the app has no untrusted direct route. It is not a
credential: an ingress or permitted qrexec caller is trusted to assert the
route, while the app still authenticates the token. The supplied Qubes Compose
omits the static key and pins the marker requirement on. PostgreSQL RLS
partitions personal rows by the verified OAuth subject or stored native
principal; neither path adds workspace/project membership ACLs.

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
  reaching mcp directly past the Caddy perimeter (IP allowlist, pre-auth Funnel
  body cap, logging).
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
- **Native credentials are confined per branch.** Caddy removes keys and caller
  markers publicly, replaces the marker privately, and forwards OAuth on either
  route. The backend requires that exact marker when configured for the trusted
  proxy, and rejects requests also carrying the Funnel header. The access-log
  filters redact both credential headers. Behavioral CI exercises the real
  Caddyfile's header forwarding, public IP denial and private routes; database
  tests pin missing-credential audit reasons and personal isolation.

### Application layer

- At least one auth door must be configured or the server refuses to boot —
  there is no accidental no-auth deployment. Native tokens are opt-in at the
  server and default on only in local compose; invalid flag values fail startup.
  When the legacy static credential is set, its minimum length of 32 is enforced
  at boot. Native tokens have a fixed format and 256-bit random secret;
  authentication hashes before a prefix-indexed lookup and uses a constant-time
  digest comparison, including a dummy comparison for unknown prefixes. Every
  request re-reads revocation state, and storage errors fail closed. The boot
  log states which doors are active and whether native credentials require the
  trusted proxy marker. Mixed doors without confinement produce a warning; that
  configuration is intended only for a private local install.
- Bearer validation pins issuer, audience, algorithm (RS256), and requires `exp`
  plus a bounded, non-empty, control-free string `sub`; verification fails
  closed before any source-marker stamping runs. Only after verification does a
  signed `gty=client-credentials` claim (including Auth0's default token
  profile)—or an admitted subject with `kind=service` for Auth0's RFC 9068
  profile or another issuer—select the `service` provenance label. That mapping
  changes neither authentication nor authorization.
- **Authorization is in-app, not delegated to the tenant.** After every
  cryptographic check passes, the verified `sub` must appear on the
  `oauth_auth.allowed_subject` table as an active row or the request is rejected
  — with the same uniform 401 as any other failure externally, and reason
  `subject_not_allowed` plus the verified subject on the audit row internally. A
  lookup error also returns that same 401, but enqueues `admission_unavailable`
  with no subject or database error details so operators can distinguish storage
  failures from bad tokens. Audit delivery remains best-effort; a database-wide
  outage can prevent the event from being stored. The list fails **closed**:
  with the OAuth door enabled and no active admission rows, every Bearer is
  rejected (the boot log warns loudly). This exists because "the tenant minted
  this token" and "the operator admits this account" are different questions: an
  IdP-side misconfiguration — an accidentally-enabled social connection, an
  unintended signup flow — mints perfectly valid tokens for accounts the
  operator never meant to admit, and tenant configuration must not be the only
  gate. Every request re-reads admission and revocation from the database. The
  operator-only `subject-admin` CLI changes admission using a dedicated role;
  the runtime cannot enroll subjects. Legacy environment lists never provide a
  fallback. See [migration and administration](oauth-subjects.md).
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
  — the question an incident review asks months later). Other denials (scanner
  noise, credential fumbles, admission lookup errors) keep 30 days, matched to
  the raw access log so a 401 and the request that produced it age out together.
  The long horizon is identity- and time-bounded, not size-bounded: those rows
  require a Bearer the tenant actually minted — which bounds **who** can grow
  the table, not how many rows a single credential can generate — so growth
  tracks legitimate use, an accepted storage trade-off. A stolen credential
  inflating it is loud in the very table it inflates (and in the edge burst
  alerts), and the horizon is a one-line operator lever in
  `db/summarize_auth_events.sql`. Only server-verified identity lands in the
  table — never as-presented credentials or header values.
- Captured content is hard-capped (100,000 UTF-8 bytes) on both
  `capture_thought` and `session_capture`; the REST gateway enforces the
  identical cap via the same shared schema module. Both REST and the MCP
  transport apply a shared 1 MiB request-body limit after authentication, so
  tailnet-direct, in-qube, and loopback callers remain bounded without a Caddy
  edge. Public Funnel traffic additionally meets Caddy's cap before it reaches
  application authentication.
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

| Role                    | Privileges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Used by                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`              | superuser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | init + DB admin (role provisioning / migrations) — never the app runtime. In the three-qube split it's reachable only through the app qube's dom0-gated ConnectTCP channel for remote admin — a deliberate trade-off (a compromised app qube then has full DB admin, including an app→db OS pivot via `COPY … TO/FROM PROGRAM`); see [db-qube/README.md](../deploy/qubes/db-qube/README.md) and [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15) |
| `openbrain_app`         | SELECT/INSERT on `thoughts` plus UPDATE of its content columns only (`content`, `embedding`, `content_fingerprint`, `metadata`, `updated_at` — never `workspace_id`/`project_id`/`visibility`/`owner_subject`); scoped session grants; SELECT/INSERT-only on `mcp_auth_events`, `thought_revisions` (append-only, head-gated RLS), and metadata-degradation history; SELECT/INSERT/DELETE on its pending-delivery outbox; SELECT/UPDATE on its singleton delivery ledger; EXECUTE on exactly three reviewed `memory_scope` helpers (audience predicate, search candidates, and the audience-move `SECURITY DEFINER`); and SELECT of only the five native-token verification fields; **no auth-event UPDATE/DELETE, thought/history DELETE, or token mutation**, no schema-wide DML, and no role memberships | MCP server, metadata notification worker                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `openbrain_auth_rollup` | Direct `public` schema USAGE with no grantable ACL from any grantor, plus non-delegable SELECT/DELETE on `mcp_auth_events` only; no INSERT/UPDATE, sequence access, relation/sequence default ACL, database/schema `CREATE`, other corpus relation access, privileged-function execution, unsafe cluster attributes, or role memberships                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | target-pinned corpus auth-event report and retention job                                                                                                                                                                                                                                                                                                                                                                                                       |
| `openbrain_ingester`    | INSERT-only on `funnel_access_log`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | log-ingester sidecar on the separate log sink — it parses attacker-influenced log lines, so its database blast radius is one disposable table and the role name is rejected by the corpus                                                                                                                                                                                                                                                                      |
| `openbrain_monitor`     | SELECT on `funnel_access_log` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | host-side funnel monitor ([`scripts/funnel_monitor.sh`](../scripts/funnel_monitor.sh)) on the separate sink; it cannot read even the aggregate table, much less a thought or reason-coded auth event                                                                                                                                                                                                                                                           |
| `openbrain_logs_rollup` | SELECT/DELETE on `funnel_access_log`; SELECT/INSERT/UPDATE/DELETE on `funnel_access_summary`; database `TEMPORARY` for its transaction-local projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | target-pinned sink summary and retention job; no persistent object/schema creation and no corpus presence                                                                                                                                                                                                                                                                                                                                                      |
| `openbrain_logs_backup` | SELECT on `funnel_access_summary` only; inherits database CONNECT only, with no raw-table, DML, sequence, TEMPORARY, or schema-creation privilege                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | optional fixed qrexec producer for the encrypted aggregate backup; absent when that backup is not installed                                                                                                                                                                                                                                                                                                                                                    |
| `openbrain_token_admin` | Lists native-token and OAuth-subject metadata and executes fixed credential lifecycle functions; cannot read hashes, memories, or mutate tables directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | profile-gated one-shot `token-admin` / `subject-admin` CLIs; `NOLOGIN` when no password is provisioned                                                                                                                                                                                                                                                                                                                                                         |
| `openbrain_readonly`    | SELECT on everything + `BYPASSRLS` so full `pg_dump` works; no DML and no role memberships (including non-inheriting memberships reachable through `SET ROLE`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | trusted backup job, humans with psql/DBeaver                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Where those roles live in every Pattern B deployment.** The corpus holds only
its own `postgres`, `openbrain_app`, `openbrain_auth_rollup`,
`openbrain_readonly`, and `openbrain_token_admin`. `openbrain_ingester`,
`openbrain_monitor`, `openbrain_logs_rollup`, and optional
`openbrain_logs_backup` are roles on a **separate cluster**: a socket-only
Funnel-log sink whose only application data tables are two permanent
request-metadata tables (supporting sequences/indexes are outside that count)
([`deploy/qubes/ingress-qube/README.md`](../deploy/qubes/ingress-qube/README.md#local-log-sink)).
Their required/optional status, relation grants, and managed database
capabilities are single-sourced in
[`db/log-sink/role-contract.json`](../db/log-sink/role-contract.json); the
DB-init preflight validates the unavoidable SQL, runtime, Compose, CI, and
runbook literals against it. The rollup name stays apart from `openbrain_app` so
no sink credential can be mistaken for a corpus credential.

The point is not the grants but the layer they sit at. Grants are enforced
_inside_ Postgres, above where a pre-auth wire-protocol or SCRAM-handshake flaw
would live; an INSERT-only role bounds a well-behaved client, not one that never
reaches the grant check. Moving the edge's store into a no-network sibling
cluster removes the route instead of narrowing what can be done over it. On a
single host this is a container/process boundary, not a VM boundary: host-root
compromise still reaches both volumes, but a compromised networkless ingester
has no database transport toward the corpus.

Catalog checks are actor-relative. **E (runtime-enforced)** means PostgreSQL or
network policy denies the named non-superuser actor even when no assertion runs;
**G (trusted deployment gate)** means an untampered final assertion aborts the
documented init, migration, or adoption workflow; **D (detection-only)** means a
trusted standalone rerun reports current drift; and **O (out of scope)** means
no authorization guarantee is claimed.

| Actor or condition                                     | Corpus cluster                                                                                                                            | Log-sink cluster                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Honest post-deployment configuration drift             | **D** when a trusted operator runs the assertion; no continuous attestation                                                               | **D** on a trusted standalone rerun; the existing marker does not attest current state                                               |
| Compromised cluster-local least-privilege runtime role | **E:** app RLS, column/ACL, role-attribute/membership, token isolation, and reviewed routine grants                                       | **E:** exact ingester, rollup, optional-monitor, and aggregate-only backup grants; no persistent CREATE, membership, or grant option |
| Trusted migration/admin mistake                        | **G:** the completed-catalog check refuses handoff after a partial or widened migration                                                   | **G:** the assertion runs last on upgrade; fresh-init/adoption markers remain unreachable until it passes                            |
| Full database superuser                                | **O** as an authorization boundary; a separately trusted rerun can only **D** ordinary grant/attribute/topology drift, not catalog tamper | **O** as an authorization boundary; a separately trusted rerun can **D** ordinary grant/attribute/topology drift                     |

The repository deliberately retains no catalog-tamper fixture or assertion arm.
Those shapes remain **O**, not **D**; the detection labels above cover only the
ordinary catalog state explicitly inspected by the checked-in assertions.
Retired catalog-tamper evidence is kept outside the repository and cannot enter
init, adoption, upgrade, CI, or completion-marker paths.

These grants bound object reach, not misuse inside an allowed surface: a
compromised ingester can forge or flood raw request rows, the monitor can read
all retained raw request metadata, and the rollup can delete raw rows or rewrite
summaries. Availability and integrity within those capabilities remain outside
the database-role boundary.

`db/06-spaces.sql` forces RLS on thoughts, sessions, and artifacts for the
application role. Missing transaction context matches no rows, personal rows
require the current trusted principal, and project/workspace rows must match the
resolved registered scope. The application cannot mutate the workspace registry.
Hybrid search's narrowly scoped `SECURITY DEFINER` candidate function uses fixed
SQL, returns IDs/ranks only, explicitly reapplies the audience, and revokes
PostgreSQL's default `PUBLIC` execute grant; returned content is rechecked
through the RLS-protected table. The trusted read-only backup role has SELECT
grants plus `BYPASSRLS`, which PostgreSQL's full `pg_dump` requires after it
sets `row_security=off`; it has no permissive RLS policy, DML, or role
membership. Rejecting membership matters even when `INHERIT FALSE` keeps an
effective-privilege probe read-only, because the login may still `SET ROLE` into
the carrier and use its DML. The grants assertion pins all five unsafe
cluster-level attributes off for `openbrain_app` and forbids any role
membership, closing direct, inherited-privilege, and `SET ROLE` paths. The
backup role keeps only its required `BYPASSRLS`, with the other four unsafe
attributes off, and likewise remains standalone.

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

`db/08-access-tokens.sql` isolates credential material in `native_auth`;
`db/14-native-token-principals.sql` adds stable per-token principals and
requires an explicit principal in the restricted registration function. The
application role can perform only its bounded prefix/hash/revocation lookup; the
dedicated administrator lists non-secret metadata and mutates lifecycle state
only through two owner-controlled, fixed-search-path `SECURITY DEFINER`
functions. PostgreSQL's default `PUBLIC` function execution is revoked. The
grant assertion verifies exact column privileges, function ownership/config,
standalone role membership, sequence access, and backup visibility.

`db/10-thought-mutations.sql` makes one function the only application path that
can change a thought's audience, and closes that by grant rather than by policy:
the application role's `UPDATE` on `thoughts` is narrowed to the content
columns, so `workspace_id`/`project_id`/`visibility`/`owner_subject` are not
writable by `openbrain_app` at all (RLS alone would still admit an in-workspace
re-scope under the union read scope the server installs). The audience-move
helper, `memory_scope.move_thought`, is table-owner-owned with a fixed
`search_path`, executable only by `openbrain_app` (PUBLIC revoked), and
re-implements every guarantee the RLS policy would otherwise provide — the
caller must already see the row under the installed audience (an invisible row
returns nothing rather than an error), the target must be a registered,
shape-valid audience, personal-only workspaces accept only personal rows, and a
personal owner is stamped from the transaction-local principal, never from an
argument. Deduplication is enforced on the canonical fingerprint — derived on
the fly for legacy rows without one, on both sides of the comparison, and
persisted on the row that moves — and a collision, found up front or landing
between the check and the write, is reported as an outcome, never as an index
error. Content updates use no privileged path at all. Both write the prior state
to `public.thought_revisions`, which is append-only to the application role and
readable only when the head thought is readable, so a thought moved to a
narrower audience takes its history with it. Revision values and actor
attribution are nevertheless supplied by the trusted application tier; the
database prevents rewriting or erasing genuine rows but does not attest that
every insert describes a real mutation. The grants assertion pins the
column-scoped grant, the function's definer/owner/config shape and grantee set,
and the history table's grants and forced policy; the boot probe requires the
function and the table.

`db/11-session-update-grants.sql` closes the corresponding session-side gap.
Session recapture addresses a row through its current exact audience and can
replace only authorable/provenance content; `workspace_id`, `project_id`,
`visibility`, `owner_subject`, `id`, and `created_at` are not UPDATE-capable by
`openbrain_app`. Artifact reconciliation remains a qualified DELETE followed by
INSERTs, so the app receives no artifact UPDATE at all—especially not on the
audience-bearing `session_pk` parent link. The completed-catalog assertion pins
both ACL shapes, the DB-init smoke proves direct re-scoping/re-parenting fails
while production capture/status paths pass, and the boot probe refuses to serve
against the historical broad grants. There is deliberately no privileged
session-move helper today.

`db/12-auth-audit-grants.sql` separates auth-decision production from retention.
`openbrain_app` can SELECT/INSERT `mcp_auth_events` but cannot UPDATE or DELETE
landed evidence. The standalone `openbrain_auth_rollup` role gets non-delegable
SELECT/DELETE on that table only and direct `public` schema USAGE, so hardened
deployments need not retain PostgreSQL's default PUBLIC USAGE. Every direct
schema-USAGE ACL must be non-delegable, including rows issued by an alternate
grantor, and no default ACL may grant the rollup access to future relations or
sequences. It has no sequence, database/schema `CREATE`, other corpus relation,
or privileged-function access. The completed-catalog assertion pins the app,
readonly, and rollup sides of the split and scans for membership, grant-option,
future-default, persistent-object, and sideways-access drift; the server boot
probe mirrors that boundary against post-deployment drift. The idempotent
migration converges owner-issued direct grants, but deliberately does not guess
at cluster memberships, impersonate alternate grantors, or rewrite defaults
owned by arbitrary roles; the read-only assertion identifies those sources and
reports the explicit revocation to perform.

`db/01-schema.sql` actively REVOKEs historical broad grants (idempotent, safe on
live DBs), and `db/03-grants-assertion.sql` is a read-only **superuser** check.
It is **G** when the trusted workflow runs it last and **D** when an operator
runs it later; superuser is needed to inspect `pg_hba_file_rules`, not because
the assertion can constrain that actor. Because init scripts only run on a fresh
data directory, a tightened grant **does not** reach an existing deployment by
itself. The corpus check rejects all three sink-only role names, every
`public.funnel_access_*` relation, current and standing default table/sequence
grants to `PUBLIC`, matching HBA rules, and regex/`@file` HBA user tokens whose
exclusion of sink roles cannot be proven. Any HBA parse error likewise fails
closed. The HBA view reads the installed file; operators still reload separately
before restoring service. The runbook archives first; the archive-gated `db/09`
migration then locks both canonical tables before its emptiness check and drops
the old shape without `CASCADE`.

The separate sink assertion is likewise **G/D**, while the exact ACLs and role
capabilities it validates are **E** against its least-privilege clients. The
fresh-init/adoption marker proves that a trusted completed-catalog check passed
once; it is not continuous catalog attestation. System-schema OID fingerprints
are intentionally not part of readiness: a full superuser can modify stock
catalogs, skip or replace the assertion, and undo its result. PostgreSQL grants
function execution to `PUBLIC` by default, so any future application
`SECURITY DEFINER` routine must revoke that default and receive a separate
security review.

### Container layer

- `mcp` and `log-ingester`: non-root user, `cap_drop: [ALL]`, `read_only: true`
  rootfs, size-capped tmpfs, `no-new-privileges`; Pattern B additionally gives
  the ingester `network_mode: none` and only the sink socket bind.
- `token-admin` and `subject-admin`: the same container hardening, profile-gated
  and one-shot. Only it receives the dedicated lifecycle password; the
  long-running MCP container never does.
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
- The request-path `openbrain_app` role can SELECT/INSERT those rows but cannot
  UPDATE or DELETE them. A separate `openbrain_auth_rollup` credential has
  SELECT/DELETE on that table alone for the bounded retention/report job; it
  cannot delegate that access, create persistent corpus objects, insert,
  rewrite, or access the rest of the corpus. The completed-catalog assertion and
  server boot probe pin the split.
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
  out-of-tree dependency policies. The guard delegates YAML merge, override,
  tag, null, anchor, include, and extends semantics to
  `docker compose config --no-interpolate`, then resolves audited launcher
  defaults from checked-in build Dockerfiles. Unresolved image defaults
  (image-only services need a reviewed non-Deno pin) and shell positional
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
- **Revision attribution is application-trusted, not database-attested.**
  `openbrain_app` can append to `thought_revisions`; the service supplies the
  prior-state payload and `changed_by_*` actor fields. Append-only grants mean a
  compromised app credential cannot rewrite or erase genuine history, but it can
  append fabricated rows or attribution. Deriving those fields from custom
  transaction-local GUCs would not change that boundary because the app role can
  set the same GUCs. A stronger design would revoke direct history INSERT and
  couple revision creation to owner-controlled mutation functions or triggers,
  while also solving how PostgreSQL receives non-forgeable request identity.
  That complexity is deliberately deferred unless multi-tenant, compliance, or
  incident-response requirements make database-enforced provenance necessary.
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
