# Install path 2 — Tailnet, and optionally the public internet

This path takes the [local install](../compose-local/README.md) and puts it on your tailnet — and, if you want claude.ai / Claude mobile to reach it, on the public internet behind a hardened edge. It reuses `../compose-local/docker-compose.yml` as the base; the files in this directory only *add* to it.

This directory is the **public Funnel + OAuth edge**. Auth here is **OAuth (RS256 JWT) only** — there is no static `x-brain-key` on a publicly-reachable deployment (that door lives only in the [local install](../compose-local/README.md)). It adds Caddy (single `:9787` listener that discriminates tailnet vs Funnel traffic — **Pattern Y**), removes the MCP server's host port so Caddy is the only entry point, validates RS256 JWTs on the public door, enforces an Anthropic egress IP allowlist, and ships observability (access logs → Postgres, daily rollups). This is what claude.ai and Claude mobile need, since they reach MCP servers from Anthropic's cloud, not from your device.

Prerequisite: Tailscale installed on the host, plus the [local install](../compose-local/README.md) working (start there — all five setup steps apply unchanged). Leave `MCP_ACCESS_KEY` **unset** here and set the `AUTH0_*` trio instead.

> **Just want tailnet reach, no public internet?** You don't need this directory. Front the [local install](../compose-local/README.md) (x-brain-key auth) with `sudo tailscale serve --bg --https=443 http://127.0.0.1:8787` and connect tailnet devices at `https://homebox.tailnet-name.ts.net/mcp` with the `x-brain-key` header — only WireGuard-authenticated tailnet peers (gated by your ACLs) can reach it. The rest of this guide is the public Funnel + OAuth door.

## Funnel + OAuth setup

### What changes

`docker-compose.pattern-b.yml` does three things:

1. **Removes mcp's host port mapping** (`ports: !reset null`) — the raw `:8787` becomes unreachable from the host, so a stray `tailscale funnel http://127.0.0.1:8787` physically cannot reach mcp past the Caddy perimeter (IP allowlist, body cap, logging). Requires compose v2.20+ (the `!reset` YAML tag).
2. **Blanks `MCP_ACCESS_KEY`** (`MCP_ACCESS_KEY: ""`) — a backstop for the "leave it unset" instruction above. The base compose inherits `MCP_ACCESS_KEY: ${MCP_ACCESS_KEY:-}`, so copying a working local `.env` into this directory would otherwise re-open the static-key door on a public box; pinning it empty here makes OAuth the only door regardless.
3. **Starts the `log-ingester` sidecar**, which tails Caddy's JSON access logs into Postgres (see Observability below).

The `caddy` service itself lives in the base compose file, gated behind the `pattern-b` profile, with its build context and Caddyfile in this directory.

### OAuth provider setup (Auth0 shown; any RS256 issuer works)

All three of `AUTH0_ISSUER`, `AUTH0_JWKS_URI`, `AUTH0_AUDIENCE` must be set — partial config throws at boot. The dashboard steps live in `../compose-local/.env.example` next to the variables. The one irreversible decision:

> `AUTH0_AUDIENCE` MUST equal your API Identifier byte-for-byte AND your public Funnel URL — `https://homebox.tailnet-name.ts.net/mcp`, no port. The Identifier is immutable once the API is created; getting it wrong means deleting and recreating the API.

### Start the stack

Copy your filled-in `.env` into this directory (Pattern B needs the extra variables: the `AUTH0_*` trio and `OPENBRAIN_INGESTER_PASSWORD`), then either run with explicit flags:

```bash
cd deploy/compose-tailnet
docker compose --project-directory . \
               -f ../compose-local/docker-compose.yml \
               -f docker-compose.pattern-b.yml \
               --profile pattern-b up -d
```

…or uncomment `COMPOSE_FILE` + `COMPOSE_PROFILES` at the bottom of the `.env` so a bare `docker compose up -d` from this directory does the same thing. Both invocations are equivalent (and both are exercised by `docker compose config` in CI-less smoke tests — paths resolve per-file).

### Wire Tailscale

A single Funnel rule on `:443` fronts *both* tailnet and public traffic ( `tailscale serve` and `tailscale funnel` can't both bind `:443` for one hostname, and Anthropic's MCP client refuses non-default-HTTPS ports — Pattern Y's single listener is what reconciles those constraints):

```bash
# Vacate :443 if tailscale serve was bound there (e.g. tailnet-only use):
sudo tailscale serve --https=443 off

# Single Funnel rule. Caddy discriminates tailnet vs public via the
# Tailscale-Funnel-Request header that Tailscale injects only on
# funnel-originated traffic.
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787
```

Funnel must also be enabled per-device in your Tailscale admin console (Access Controls → the `funnel` node attribute). Verify with `tailscale funnel status`.

> **Funnel access is locked to Anthropic egress.** Caddy's `@anthropic_funnel` matcher enforces an allowlist of `160.79.104.0/21` — Anthropic's published egress range — so every funnel-originated request from anywhere else gets a `403` at the edge before reaching the MCP server. The check uses Caddy's `client_ip` matcher against the `X-Forwarded-For`-resolved origin (XFF is trusted only from the loopback proxy peer; a tailnet client can't spoof its way into the funnel branch because the funnel header itself is injected by `tailscaled`, not the client). If Anthropic announces additional ranges, extend the `client_ip` matcher in the `Caddyfile` (space-separated CIDRs) and `docker compose restart caddy`.

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

claude.ai → Settings → Connectors → Add custom connector → URL `https://homebox.tailnet-name.ts.net/mcp` (no port) → Advanced: paste your OAuth application's client_id + client_secret → Connect → provider login + consent. Captures land with `metadata.door = 'funnel'` and `metadata.sub = <your OAuth sub>`.

If the connector fails after a successful consent screen, the most common cause is a client_secret paste mismatch — see the failure-mode catalog in [`docs/funnel-mcp-perimeter.md`](../../docs/funnel-mcp-perimeter.md).

> **Connecting a local Codex CLI instead?** That's a different client shape — a public PKCE client with no secret, authorized per Codex account, per machine. See [`docs/codex-oauth-client.md`](../../docs/codex-oauth-client.md).

## Observability (Pattern B)

Once Funnel is live, the box has a public surface for the first time — this stack measures it instead of guessing.

**What's logged**

- **Caddy JSON access logs** — every request to `:9787` lands in `funnel-access.log` or `tailnet-access.log` (named volume), rolled at 10 MB × 5 with a 30-day age cap.
- **`funnel_access_log`** — the log-ingester sidecar inserts one structured row per request (timestamp, socket, client IP, method, path, status, latency, size, truncated UA, host, protocol).
- **`mcp_auth_events`** — one row per 401 the MCP server returns, with a stable `reason` code (`invalid_brain_key`, `token_validation_failed`, `invalid_credentials`, `missing_credentials`) — the only way to tell "legitimate client, wrong credentials" from "blind scanner".
- **`funnel_access_summary`** — daily rollup: requests, unique IPs, p50/p95 latency, top paths and user agents per `(day, socket, status_class)`, retained 365 days.

**What's NOT logged:** no `Authorization`/`x-brain-key`/`Cookie` values (redacted by Caddy's `format filter` — if you ever see them on disk, the Caddyfile has drifted), no request bodies, no query strings, no JWT contents.

**Daily summary.** `scripts/funnel_daily_summary.sh` rolls up yesterday's rows, enforces retention, and writes a fenced-markdown report to `SUMMARY_DIR` (default `~/openbrain-funnel-summaries`; point it at a directory you replicate off-box for a free backup of the trail). Run it from cron or a systemd timer:

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
```

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
WHERE ts > (now() AT TIME ZONE 'UTC')::date
GROUP BY reason, middleware ORDER BY n DESC;
```

## Upgrading an existing deployment

Postgres only runs `db/` init scripts on a **fresh data directory** — schema changes after first deploy need manual application.

**New schema files** (observability, sessions) apply cleanly — both are idempotent:

```bash
# Set OPENBRAIN_INGESTER_PASSWORD in .env first (openssl rand -hex 24), then:
bash ../../scripts/upgrade-add-ingester-role.sh
docker compose exec -T postgres psql -U postgres -d openbrain < ../../db/02-observability.sql
docker compose exec -T postgres psql -U postgres -d openbrain < ../../db/04-sessions.sql
docker compose build mcp && docker compose up -d
```

Optional: the SELECT-only role for the host-side funnel monitor follows the same shape —
set `OPENBRAIN_MONITOR_PASSWORD` in `.env`, run `bash ../../scripts/upgrade-add-monitor-role.sh`,
then re-apply `db/02-observability.sql` as above for its grants.

The full `up -d` matters on the upgrade path: it creates services newly defined since the
last deploy (e.g. `log-ingester`) as well as recreating changed ones.

For an MCP code-only rollout with no schema or edge change, run
`docker compose build mcp && docker compose up -d --no-deps mcp` instead. This recreates the
MCP container without restarting Postgres, Ollama, Caddy, or the log ingester.

**Edits to existing init files** (a tightened grant, a new role) silently *don't* reach an already-initialized DB. The drift check is read-only and safe to run any time:

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain < ../../db/03-grants-assertion.sql
```

A non-zero exit means a grant drifted. Prefer a targeted fix (e.g. `REVOKE DELETE ON public.thoughts FROM openbrain_app;`). To re-sync wholesale, re-apply `01-schema.sql` → `02-observability.sql` → `03-grants-assertion.sql` **in order** — never `01` alone, since its REVOKE-all block strips observability grants until `02` restores them.

## Key rotation

This OAuth-only deployment has no `MCP_ACCESS_KEY` to rotate. Rotate the OAuth client secret in your provider's dashboard and re-paste it into claude.ai; nothing in this stack stores it.
