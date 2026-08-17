# Install path 2 — Tailnet, and optionally the public internet

This path takes the [local install](../compose-local/README.md) and puts it on
your tailnet — and, if you want claude.ai / Claude mobile to reach it, on the
public internet behind a hardened edge. It reuses
`../compose-local/docker-compose.yml` as the base; the files in this directory
only _add_ to it.

This directory is the **public Funnel + OAuth edge**. Auth here is **OAuth
(RS256 JWT) only** — both static and native `x-brain-key` verification are
disabled on a publicly-reachable deployment (that door lives only in the
[local install](../compose-local/README.md)). It adds Caddy (single `:9787`
listener that discriminates tailnet vs Funnel traffic — **Pattern Y**), removes
the MCP server's host port so Caddy is the only entry point, validates RS256
JWTs on the public door, enforces an Anthropic egress IP allowlist, and ships
observability (access logs → Postgres, daily rollups). This is what claude.ai
and Claude mobile need, since they reach MCP servers from Anthropic's cloud, not
from your device.

Prerequisite: Tailscale installed on the host, plus the base services from the
[local install](../compose-local/README.md) working. The public steps below
replace that guide's native-token client setup: set the `AUTH0_*` trio, and the
overlay clears `MCP_ACCESS_KEY` and disables native tokens regardless of copied
local values.

Interactive clients and
[headless service accounts](../../docs/service-account-oauth-client.md) use this
same OAuth verifier. Scheduled agents normally connect over the private tailnet
branch; the public Funnel branch remains restricted to Anthropic egress.

> **Just want tailnet reach, no public internet?** You don't need this
> directory. Front the [local install](../compose-local/README.md) (x-brain-key
> auth) with `sudo tailscale serve --bg --https=443 http://127.0.0.1:8787` and
> connect tailnet devices at `https://homebox.tailnet-name.ts.net/mcp` with the
> `x-brain-key` header — only WireGuard-authenticated tailnet peers (gated by
> your ACLs) can reach it. The rest of this guide is the public Funnel + OAuth
> door.

## Funnel + OAuth setup

### What changes

`docker-compose.pattern-b.yml` does three things:

1. **Removes mcp's host port mapping** (`ports: !reset null`) — the raw `:8787`
   becomes unreachable from the host, so a stray
   `tailscale funnel http://127.0.0.1:8787` physically cannot reach mcp past the
   Caddy perimeter (IP allowlist, body cap, logging). Requires compose v2.20+
   (the `!reset` YAML tag).
2. **Disables the complete `x-brain-key` door** — it blanks `MCP_ACCESS_KEY` and
   pins `ENABLE_NATIVE_TOKENS=false`. The base compose enables native tokens and
   may inherit a static key, so both overrides are required to make OAuth the
   only door even when an operator copies a working local `.env` onto a public
   box.
3. **Starts the `log-ingester` sidecar**, which tails Caddy's JSON access logs
   into Postgres (see Observability below).

The `caddy` service itself lives in the base compose file, gated behind the
`pattern-b` profile, with its build context and Caddyfile in this directory.

### OAuth provider setup (Auth0 shown; any RS256 issuer works)

All three of `AUTH0_ISSUER`, `AUTH0_JWKS_URI`, `AUTH0_AUDIENCE` must be set —
partial config throws at boot. The dashboard steps live in
`../compose-local/.env.example` next to the variables. The one irreversible
decision:

> `AUTH0_AUDIENCE` MUST equal your API Identifier byte-for-byte AND your public
> Funnel URL — `https://homebox.tailnet-name.ts.net/mcp`, no port. The
> Identifier is immutable once the API is created; getting it wrong means
> deleting and recreating the API.

The variable names are retained for compatibility, but any issuer that produces
the documented RS256 JWT profile can be used. Auth0 M2M, Okta API Services, the
generic subject mapping, and a browserless verification command are covered in
[OAuth service accounts](../../docs/service-account-oauth-client.md).

> **Decide tenant membership control before the Funnel goes public.** Whoever
> can become a user of your tenant can request tokens for this API through any
> application that enables their connection and is authorized for it (allow-all
> is the documented default policy for a new API's user flows). For every login
> connection you enable: a Database connection needs **"Disable Sign Ups"**
> turned on (it ships off — sign-ups allowed); a Social connection has **no
> sign-up toggle at all** — everyone with that IdP's account already holds a
> credential your tenant will accept, so leave it disabled unless an Action
> deliberately restricts who may log in. The full trap catalog, the five-check
> audit, and the outcome-evidence Management API commands are in
> [Auth0 setup dangers](../../docs/auth0-setup-dangers.md).

> **`OAUTH_ALLOWED_SUBJECTS` is required in practice whenever the OAuth door is
> on.** Verification proves a token came from your tenant; this comma-separated
> allowlist of exact `sub` claims says which accounts you actually admit, so an
> IdP-side misconfiguration (an accidentally-open social connection, an
> unintended signup flow) cannot equal access. It fails CLOSED: left unset,
> every Bearer token is rejected and the boot log warns. Machine subjects need
> listing here too — the service-account mapping above is attribution only.

### Start the stack

Copy your filled-in `.env` into this directory (including the required
`METADATA_FALLBACK_POLICY`; Pattern B also needs the `AUTH0_*` trio,
`OPENBRAIN_INGESTER_PASSWORD`, `LOG_SINK_SUPERUSER_PASSWORD`,
`OPENBRAIN_LOGS_ROLLUP_PASSWORD`, and an absolute `LOG_SINK_SOCKET_DIR`) and
uncomment `COMPOSE_FILE` + `COMPOSE_PROFILES` at its bottom. Then either run
with explicit flags:

```bash
cd deploy/compose-tailnet
docker compose --env-file .env \
               --project-directory . \
               -f ../compose-local/docker-compose.yml \
               -f docker-compose.pattern-b.yml \
               --profile pattern-b up -d
```

…or let those two `.env` settings select the files and profile:

```bash
docker compose --env-file .env up -d
```

The two supported forms agree on file paths (resolved per-file), project
identity (pinned by `COMPOSE_PROJECT_NAME`), and interpolation source (the
explicit `.env`) — so later `exec`/`logs`/`ps`/`down` commands resolve the
running stack whichever form started it.

**The `--env-file .env` flag is load-bearing whenever Compose renders the model
(including `config`, `up`, and `build`). Do not shorten form 2 to a bare
`docker compose up -d`.** Without an explicit env file, `COMPOSE_FILE` makes
Compose resolve its _project directory_ to `deploy/compose-local` (the first
file's directory), then load that directory's `.env` as a second,
lower-precedence source. Any key absent from this directory can then silently
inherit the local install's value — including a future `:?`-guarded setting an
older tailnet `.env` does not know about. Naming the env file explicitly
suppresses that fallback: an absent or empty required value stays absent or
empty and fails closed. Running-project commands such as `exec`, `ps`, `logs`,
and `restart` do not interpolate service variables; they keep the flag as a
uniform convention, while this directory's `.env` supplies `COMPOSE_FILE` and
`COMPOSE_PROJECT_NAME` so they find the same stack.

A `.env` that predates the `COMPOSE_PROJECT_NAME` pin doesn't get the
project-identity guarantee: form 1 falls back to `compose-tailnet`, while form 2
falls back to `compose-local`. See §"Upgrading an existing deployment" before
crossing forms.

### Wire Tailscale

A single Funnel rule on `:443` fronts _both_ tailnet and public traffic (
`tailscale serve` and `tailscale funnel` can't both bind `:443` for one
hostname, and Anthropic's MCP client refuses non-default-HTTPS ports — Pattern
Y's single listener is what reconciles those constraints):

```bash
# Vacate :443 if tailscale serve was bound there (e.g. tailnet-only use):
sudo tailscale serve --https=443 off

# Single Funnel rule. Caddy discriminates tailnet vs public via the
# Tailscale-Funnel-Request header that Tailscale injects only on
# funnel-originated traffic.
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787
```

Funnel must also be enabled per-device in your Tailscale admin console (Access
Controls → the `funnel` node attribute). Verify with `tailscale funnel status`.

> **Funnel access is locked to Anthropic egress.** Caddy's `@anthropic_funnel`
> matcher enforces an allowlist of `160.79.104.0/21` — Anthropic's published
> egress range — so every funnel-originated request from anywhere else gets a
> `403` at the edge before reaching the MCP server. The check uses Caddy's
> `client_ip` matcher against the `X-Forwarded-For`-resolved origin (XFF is
> trusted only from the loopback proxy peer; a tailnet client can't spoof its
> way into the funnel branch because the funnel header itself is injected by
> `tailscaled`, not the client). If Anthropic announces additional ranges,
> extend the `client_ip` matcher in the `Caddyfile` (space-separated CIDRs) and
> `docker compose --env-file .env restart caddy`.

### Verify the OAuth door + allowlist

```bash
# OAuth discovery metadata (public by design, RFC 9728):
curl https://homebox.tailnet-name.ts.net/.well-known/oauth-protected-resource/mcp

# Funnel door without a token — 401 with a WWW-Authenticate header:
curl -i https://homebox.tailnet-name.ts.net/mcp

# A stale x-brain-key is NOT accepted here (OAuth-only) — also 401:
curl -i https://homebox.tailnet-name.ts.net/mcp -H "x-brain-key: anything"
```

### Connect claude.ai / Claude mobile

claude.ai → Settings → Connectors → Add custom connector → URL
`https://homebox.tailnet-name.ts.net/mcp` (no port) → Advanced: paste your OAuth
application's client_id + client_secret → Connect → provider login + consent.
Captures land with `metadata.door = 'funnel'` and
`metadata.sub = <your OAuth sub>`.

If the connector fails after a successful consent screen, the most common cause
is a client_secret paste mismatch — see the failure-mode catalog in
[`docs/funnel-mcp-perimeter.md`](../../docs/funnel-mcp-perimeter.md).

> **Connecting a local Codex CLI instead?** That's a different client shape — a
> public PKCE client with no secret, authorized per Codex account, per machine.
> See [`docs/codex-oauth-client.md`](../../docs/codex-oauth-client.md).
>
> **Connecting a local Kimi Code CLI?** Same public-PKCE shape, but registered
> exclusively through a time-boxed Dynamic Client Registration window (Kimi Code
> has no pre-registered-client option). See
> [`docs/kimi-code-oauth-client.md`](../../docs/kimi-code-oauth-client.md).

### Connect an unattended agent

Create a dedicated provider application using the OAuth `client_credentials`
grant, keep its secret in the agent's secret store, and connect over the
tailnet. Follow the complete
[service-account runbook](../../docs/service-account-oauth-client.md), including
the tracked headless smoke test. Successful machine writes land with
`metadata.door = 'service'` and `metadata.sub = <verified client subject>`;
interactive user writes remain `door = 'funnel'`.

## Observability (Pattern B)

Once Funnel is live, the box has a public surface for the first time — this
stack measures it without giving an edge parser a route to the corpus.

**Two clusters, no shared Funnel schema**

- **Corpus `postgres`** holds memories, sessions, and `mcp_auth_events`. It
  deliberately has no `funnel_access_*` relation and rejects the
  `openbrain_ingester` / `openbrain_monitor` role names.
- **`log-sink`** is plain `postgres:17-alpine` with exactly `funnel_access_log`
  and `funnel_access_summary`. It uses `network_mode: none`,
  `listen_addresses=`, no published port, and SCRAM on its shared unix socket.
  The ingester also has `network_mode: none` and reaches only that socket.
- Caddy JSON access logs still roll at 10 MB × 5 with a 30-day age cap.
  `mcp_auth_events` records the application-side auth decision separately,
  including verified identities on admitted requests.

The sink is intentionally disposable request metadata: raw rows retain 30 days
and daily aggregates 365. It has its own init-only superuser, INSERT-only
ingester, DML rollup, and optional one-table monitor credentials. None is passed
to the corpus container. Create the configured `LOG_SINK_SOCKET_DIR` before
first start and keep its absolute path short enough for a unix socket.

**What's NOT logged:** no `Authorization`/`x-brain-key`/`Cookie` values
(redacted by Caddy's `format filter`), no request bodies, no query strings, and
no JWT contents.

**Daily summaries.** The wrapper requires one explicit target; the target fixes
the SQL, role, database, Compose service, report prefix, and transport together:

```sh
# Funnel rows + 30d/365d sink retention
SUMMARY_TARGET=sink ../../scripts/funnel_daily_summary.sh

# Auth decisions + corpus retention
SUMMARY_TARGET=corpus ../../scripts/funnel_daily_summary.sh
```

Run them as separate cron/systemd jobs so one cluster's outage does not suppress
the other's retention pass. `SUMMARY_BACKEND=compose` is the default and enters
`log-sink` or `postgres` respectively. Reports land under `SUMMARY_DIR` (default
`~/openbrain-funnel-summaries`) as `funnel-summary-YYYYMMDD.md` and
`auth-events-summary-YYYYMMDD.md`. Exclude both hidden staging prefixes
(`/.funnel-summary-*` and `/.auth-events-summary-*`) from replication; final
reports have no leading dot. The Qubes split ships separate user units and
scoped env files in `deploy/qubes/{ingress-qube,app-qube}/`.

When `deploy/qubes/docker-compose.external-db.yml` parks the bundled corpus
service, keep the sink job on `SUMMARY_BACKEND=compose`, but configure the
corpus job with `SUMMARY_BACKEND=postgres`, the external `DB_HOST`, and its
scoped `OPENBRAIN_APP_PASSWORD`. There is intentionally no local `postgres`
container for the corpus target to enter in that overlay.

**Ad-hoc queries use the owning cluster.** For Funnel rows, enter the sink with
its rollup or monitor role:

```sh
docker compose --env-file .env exec -T log-sink sh -c \
  'PGPASSWORD="$OPENBRAIN_LOGS_ROLLUP_PASSWORD" exec psql -w -h /var/run/postgresql -U openbrain_logs_rollup -d "$POSTGRES_DB"'
```

Then query `funnel_access_log` / `funnel_access_summary`. Query
`mcp_auth_events` through the corpus's `openbrain_readonly` or app role. There
is no role that can join Funnel metadata to thoughts because no cluster contains
both relation sets.

The Caddy field discipline and report contents are detailed in
[Funnel MCP perimeter](../../docs/funnel-mcp-perimeter.md); the role and
transport boundary is in [Security model](../../docs/security-model.md).

## Upgrading an existing deployment

Postgres only runs `db/` init scripts on a **fresh data directory** — schema
changes after first deploy need manual application.

**Adopting the `COMPOSE_PROJECT_NAME` line** (stacks whose `.env` predates it):
set it to the name `docker compose ls` reports for your running stack, not
necessarily the example's default. A changed project name strands the running
containers and re-homes named volumes — including `postgres_data` — to a fresh,
empty project.

Filtered provenance search requires pgvector `0.8.0` or newer. Before updating
the MCP container against an existing data directory, check the installed
extension version:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d openbrain -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

If the result is older than `0.8.0`, first update the pgvector package or
Postgres image so it provides a current extension, then upgrade and verify the
database extension before restarting MCP:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d openbrain -c "ALTER EXTENSION vector UPDATE;"
docker compose --env-file .env exec -T postgres \
  psql -U postgres -d openbrain -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

**New schema files** (corpus observability, sessions, hybrid search, spaces,
metadata degradation audit, native-token storage) apply cleanly and are
idempotent. Arc B's `09` is intentionally different: it permanently removes the
legacy Funnel shape and refuses to run while either old table is nonempty.

For a pre-Arc-B Pattern B stack, first add fresh values for
`LOG_SINK_SUPERUSER_PASSWORD` and `OPENBRAIN_LOGS_ROLLUP_PASSWORD`, choose a
short absolute `LOG_SINK_SOCKET_DIR`, and keep/set fresh sink-only ingester and
optional monitor passwords. Then:

1. Stop the old log-ingester, build its new socket-only image, create the socket
   directory, start `log-sink`, recreate the ingester, and verify a new request
   row lands in `openbrain_logs`. The durable Caddy log plus existing cursor
   bridges the short cutover; the new sink does not replay already-consumed
   historical files. The sink becomes healthy only after its final assertion
   writes the durable init-completion marker.

   ```sh
   docker compose --env-file .env stop log-ingester
   docker compose --env-file .env build log-ingester
   mkdir -p /the/exact/absolute/path/set-as-LOG_SINK_SOCKET_DIR
   docker compose --env-file .env --profile pattern-b up -d --wait log-sink
   docker compose --env-file .env logs log-sink | grep -E 'invariants OK|init completion marker written'
   docker compose --env-file .env --profile pattern-b up -d --no-deps log-ingester
   ```

2. Export **both** corpus tables to trusted encrypted storage, record their row
   counts/checksum, and verify the archive (prefer a scratch restore). Follow
   the concrete archive procedure in
   [db-qube/README.md](../qubes/db-qube/README.md#retiring-the-ingress-qubes-old-access-existing-installs),
   substituting this container-local superuser path.
3. Explicitly `TRUNCATE public.funnel_access_log` and
   `public.funnel_access_summary` in the corpus. Do not skip the frozen summary
   just because the raw table is empty. Replace/update both
   `~/.config/funnel-summary.env` and `~/.config/funnel-monitor.env` for the new
   target/socket configuration before enabling their next timer occurrence; the
   retired knobs deliberately make stale files fail closed.

Now run the block below from this directory with the running stack's `.env`
present — its `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` values let each
migration command resolve the running project (§"Start the stack"). The flag
stays on those commands for invocation consistency; it becomes load-bearing on
the final `build` and `up`, which render the model. The spaces migration is not
a cheap no-op on reapplication; it rebuilds its fingerprint index each time:

```bash
docker compose --env-file .env exec -T postgres psql -U postgres -d openbrain < ../../db/02-observability.sql
docker compose --env-file .env exec -T postgres psql -U postgres -d openbrain < ../../db/04-sessions.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/05-hybrid-search.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/06-spaces.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/07-metadata-degradation.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/08-access-tokens.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/09-retire-corpus-funnel.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/10-thought-mutations.sql
docker compose --env-file .env exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/03-grants-assertion.sql
docker compose --env-file .env build mcp log-ingester && docker compose --env-file .env up -d
```

Upgrading to **1.22.0+**: `10-thought-mutations.sql` (superuser) adds the
append-only `thought_revisions` history and the `memory_scope.move_thought`
helper behind the new `update_thought` / `move_thought` tools and their REST
routes, and narrows `openbrain_app`'s `UPDATE` on `thoughts` to the content
columns (the grants assertion now rejects the old table-wide grant); the
server's boot probe refuses to start without it. See
[Memory spaces](../../docs/spaces.md#correcting-and-moving-thoughts).

Upgrading to **1.20.0+**: `02-observability.sql` in the block above now also
converges `mcp_auth_events` to the allowed+denied audit shape in place (the new
server's boot probe refuses the old denied-only shape, so don't skip it), and
the OAuth door additionally requires `OAUTH_ALLOWED_SUBJECTS` in `.env`
**before** the `up -d` — it fails closed, so rolling without it rejects every
Bearer token. See §"OAuth provider setup" above.

`05-hybrid-search.sql` backfills a stored text-search column under an
access-exclusive lock that is held through both regular GIN index builds until
commit, blocking searches and captures for the migration's duration. Use a full
application maintenance window on a large corpus, budget disk for the column
plus both indexes, and apply it before starting the hybrid-query server. The
updated server's boot probe refuses to start until both indexes exist. See
[Hybrid thought search](../../docs/hybrid-search.md) for the index and threshold
contracts.

`06-spaces.sql` requires PostgreSQL 15 or newer and must run as the `postgres`
superuser. It backfills existing thoughts/sessions into the `default` workspace,
rebuilds fingerprint uniqueness per audience, and forces RLS. It also takes
table locks, so keep the maintenance window active through it and apply it
before starting the scoped server. Reapplication requires the same lock window
and index headroom. The boot probe checks the registry, columns, indexes,
application policies, forced-RLS flags, and scoped search function. See
[Memory spaces](../../docs/spaces.md).

`07-metadata-degradation.sql` adds an append-only, content-free classification
audit, a transactional notification outbox, and the singleton delivery ledger.
It does not rewrite `thoughts` or build an index over that table. Apply it
before server 1.16.0; the boot probe refuses a partial catalog. See
[Metadata degradation monitoring](../../docs/metadata-degradation-monitoring.md)
for audit queries and optional Pushover/ntfy configuration.

`08-access-tokens.sql` is required by the server catalog probe, but the public
Pattern B override pins `ENABLE_NATIVE_TOKENS=false` and clears the static key,
so every `x-brain-key` remains rejected. Its dedicated administrator role may
remain `NOLOGIN` on this OAuth-only deployment. See
[Native access tokens](../../docs/native-access-tokens.md#existing-database-upgrade).

The two old role-upgrade helper names remain only as fail-closed tombstones.
Never run them to provision the corpus: sink roles are created exclusively by
`db/log-sink/00-log-sink-roles.sh` on a fresh `log-sink` data volume.

The full `up -d` matters on the upgrade path: it creates services newly defined
since the last deploy (e.g. `log-ingester`) as well as recreating changed ones.

For an MCP code-only rollout with no schema or edge change, run:

```bash
docker compose --env-file .env build mcp && \
  docker compose --env-file .env up -d --no-deps mcp
```

This recreates the MCP container without restarting Postgres, Ollama, Caddy, or
the log ingester.

**Edits to existing init files** (a tightened grant, a new role) silently
_don't_ reach an already-initialized DB. The drift check is read-only and safe
to run any time as a database superuser (needed for HBA-file inspection):

```bash
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/03-grants-assertion.sql
```

A non-zero exit means a grant drifted. Prefer a targeted fix (e.g.
`REVOKE DELETE ON public.thoughts FROM openbrain_app;`). To re-sync wholesale,
re-apply `01-schema.sql` → `02-observability.sql`, apply any pending later
schema migrations (`04`, `05`, `06`, `07`, `08`, `09`, and future files), then
run `03-grants-assertion.sql` **last** — never `01` alone, since its REVOKE-all
block strips observability grants until `02` restores them.

To retire the unused historical thought-search RPC without a full schema replay,
run
`DROP FUNCTION IF EXISTS match_thoughts(vector, double precision, integer, jsonb);`
as the database owner during the next maintenance window.

## Key rotation

This OAuth-only deployment has no `MCP_ACCESS_KEY` to rotate. Rotate interactive
client secrets in the provider and re-paste them into the hosted connector.
Rotate each M2M secret in the provider and the corresponding agent secret store,
verify the new credential, then revoke the old one; nothing in this stack stores
either secret. Already-issued JWTs remain valid until expiration because the
server performs local verification rather than introspection.
