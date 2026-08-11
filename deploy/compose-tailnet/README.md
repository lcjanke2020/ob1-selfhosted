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
`METADATA_FALLBACK_POLICY`; Pattern B also needs the `AUTH0_*` trio and
`OPENBRAIN_INGESTER_PASSWORD`), then either run with explicit flags:

```bash
cd deploy/compose-tailnet
docker compose --project-directory . \
               -f ../compose-local/docker-compose.yml \
               -f docker-compose.pattern-b.yml \
               --profile pattern-b up -d
```

…or uncomment `COMPOSE_FILE` + `COMPOSE_PROFILES` at the bottom of the `.env` so
a bare `docker compose up -d` from this directory does the same thing. The two
forms are equivalent on both axes that matter: paths resolve per-file (both
forms are exercised by `docker compose config` in CI-less smoke tests), and
project identity is pinned by `COMPOSE_PROJECT_NAME` in the `.env` — so later
`exec`/`logs`/`ps`/`down` commands resolve the running stack whichever form
started it. A `.env` that predates the pin doesn't get that guarantee — see
§"Upgrading an existing deployment" before crossing forms.

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
> `docker compose restart caddy`.

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
stack measures it instead of guessing.

**What's logged**

- **Caddy JSON access logs** — every request to `:9787` lands in
  `funnel-access.log` or `tailnet-access.log` (named volume), rolled at 10 MB ×
  5 with a 30-day age cap.
- **`funnel_access_log`** — the log-ingester sidecar inserts one structured row
  per request (timestamp, socket, client IP, method, path, status, latency,
  size, truncated UA, host, protocol).
- **`mcp_auth_events`** — one row per auth decision the MCP server makes,
  enqueued best-effort (under backpressure either outcome can drop — counted and
  warned; see the security model's audit contract). Denied rows carry a stable
  `reason` code (`invalid_brain_key`, `token_validation_failed`,
  `subject_not_allowed`, `invalid_credentials`, `missing_credentials`) — the
  only way to tell "legitimate client, wrong credentials" from "blind scanner".
  Allowed rows carry the verified identity (`subject` / `token_label`), door,
  and path — the local answer to "who accessed this server", kept 365 days (as
  are `subject_not_allowed` denials, the identity-carrying refusals; anonymous
  denials keep 30).
- **`funnel_access_summary`** — daily rollup: requests, unique IPs, p50/p95
  latency, top paths and user agents per `(day, socket, status_class)`, retained
  365 days.

**What's NOT logged:** no `Authorization`/`x-brain-key`/`Cookie` values
(redacted by Caddy's `format filter` — if you ever see them on disk, the
Caddyfile has drifted), no request bodies, no query strings, no JWT contents.

**Daily summary.** `scripts/funnel_daily_summary.sh` rolls up completed days,
enforces retention, and atomically writes a fenced-markdown report to
`SUMMARY_DIR` (default `~/openbrain-funnel-summaries`; point it at a trusted
directory you replicate off-box for a backup of the trail). When using
Syncthing, add `/.funnel-summary-*` to the folder's `.stignore` so a staging
file left by a hard kill or host crash never replicates. Its default
`SUMMARY_BACKEND=compose` runs `psql` inside this single-host stack's Postgres
container. Run it from cron or a systemd timer:

```ini
# /etc/systemd/system/funnel-summary.service
[Unit]
Description=OB1 funnel observability daily summary
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo/deploy/compose-tailnet
ExecStart=/path/to/repo/scripts/funnel_daily_summary.sh

# /etc/systemd/system/funnel-summary.timer
[Timer]
OnCalendar=*-*-* 00:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

The three-qube deployment has no Postgres container on its app qube. It instead
ships a user service, timer, scoped environment template, and direct-Postgres
installation recipe in
[`deploy/qubes/app-qube/`](../qubes/app-qube/README.md#daily-funnel-rollup-and-retention-host-side).

**Ad-hoc queries** (the `openbrain_readonly` role can read all three tables):

```sql
-- What's hitting the funnel in the last hour?
SELECT host(client_ip) AS ip, status, path, COUNT(*) AS hits
FROM funnel_access_log
WHERE socket = 'funnel' AND ts > now() - interval '1 hour'
GROUP BY ip, status, path ORDER BY hits DESC LIMIT 20;

-- Why are we returning 401s today?
SELECT reason, middleware, COUNT(*) AS n
FROM mcp_auth_events
WHERE outcome = 'denied' AND ts > (now() AT TIME ZONE 'UTC')::date
GROUP BY reason, middleware ORDER BY n DESC;

-- Who was admitted today, through which door?
SELECT door, COALESCE(subject, token_label, '(static shared key)') AS identity,
       COUNT(*) AS n
FROM mcp_auth_events
WHERE outcome = 'allowed' AND ts > (now() AT TIME ZONE 'UTC')::date
GROUP BY door, identity ORDER BY n DESC;
```

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
docker compose exec -T postgres \
  psql -U postgres -d openbrain -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

If the result is older than `0.8.0`, first update the pgvector package or
Postgres image so it provides a current extension, then upgrade and verify the
database extension before restarting MCP:

```bash
docker compose exec -T postgres \
  psql -U postgres -d openbrain -c "ALTER EXTENSION vector UPDATE;"
docker compose exec -T postgres \
  psql -U postgres -d openbrain -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

**New schema files** (observability, sessions, hybrid search, spaces, metadata
degradation audit, native-token storage) apply cleanly and are idempotent. Run
the block below from this directory with the running stack's `.env` present —
that `.env` is what lets each `docker compose exec` resolve the running project
(§"Start the stack"). The spaces migration is not a cheap no-op on
reapplication; it rebuilds its fingerprint index each time:

```bash
# Set OPENBRAIN_INGESTER_PASSWORD in .env first (openssl rand -hex 24), then:
bash ../../scripts/upgrade-add-ingester-role.sh
docker compose exec -T postgres psql -U postgres -d openbrain < ../../db/02-observability.sql
docker compose exec -T postgres psql -U postgres -d openbrain < ../../db/04-sessions.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/05-hybrid-search.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/06-spaces.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/07-metadata-degradation.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/08-access-tokens.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/03-grants-assertion.sql
docker compose build mcp && docker compose up -d
```

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

Optional: the SELECT-only role for the host-side funnel monitor follows the same
shape — set `OPENBRAIN_MONITOR_PASSWORD` in `.env`, run
`bash ../../scripts/upgrade-add-monitor-role.sh`, then re-apply
`db/02-observability.sql` as above for its grants and run
`db/03-grants-assertion.sql` last to verify the completed catalog.

The full `up -d` matters on the upgrade path: it creates services newly defined
since the last deploy (e.g. `log-ingester`) as well as recreating changed ones.

For an MCP code-only rollout with no schema or edge change, run
`docker compose build mcp && docker compose up -d --no-deps mcp` instead. This
recreates the MCP container without restarting Postgres, Ollama, Caddy, or the
log ingester.

**Edits to existing init files** (a tightened grant, a new role) silently
_don't_ reach an already-initialized DB. The drift check is read-only and safe
to run any time:

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/03-grants-assertion.sql
```

A non-zero exit means a grant drifted. Prefer a targeted fix (e.g.
`REVOKE DELETE ON public.thoughts FROM openbrain_app;`). To re-sync wholesale,
re-apply `01-schema.sql` → `02-observability.sql`, apply any pending later
schema migrations (`04`, `05`, `06`, `07`, `08`, and future files), then run
`03-grants-assertion.sql` **last** — never `01` alone, since its REVOKE-all
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
