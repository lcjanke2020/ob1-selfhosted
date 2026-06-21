# ingress qube — Funnel + Caddy + log-ingester

The **ingress** (public-edge) qube of the [three-qube split](../three-qube-design.md): it
terminates the Tailscale Funnel and runs Caddy (the header-discriminated perimeter) plus the
log-ingester. It reverse-proxies to the [app qube](../app-qube/)'s mcp over the tailnet and
holds **no** memory store and **no** app credential — only the INSERT-only ingester
credential. The canonical Postgres is on the [db qube](../db-qube/).

Build this qube with the shared bind-dirs / SELinux / systemd-persistence mechanics from the
[Qubes README](../README.md) first; this directory is the ingress-qube-specific overlay.

## Run

```sh
cp .env.example .env && $EDITOR .env     # MCP_UPSTREAM (app qube), DB_HOST (db qube), ingester pw
docker compose up -d
```

Then expose Caddy publicly (host, not compose):

```sh
sudo tailscale serve  --https=443 off                          # vacate :443
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787   # single rule
```

[`docker-compose.yml`](docker-compose.yml) is self-contained — `caddy` + `log-ingester`,
plus a **parked** local `postgres` (profile `logs-future`) kept on disk for a future local
logs store but never started. Do **not** set `COMPOSE_PROFILES` on this qube.

## Credentials (per-qube split)

This qube's `.env` holds **only** `OPENBRAIN_INGESTER_PASSWORD` (INSERT-only on
`funnel_access_log`), plus `MCP_UPSTREAM` and `DB_HOST`. It carries **no** superuser or app
password — the parked postgres references them as plain `${VAR}`, left unset they interpolate
empty and are never used (the service never starts). The db qube's `pg_hba` must permit
`openbrain_ingester` from **this** qube's tailnet IP (see [`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)).

## Why the log-ingester writes across to the db qube

Caddy's access logs live here; the canonical Postgres lives on the db qube. For now the
ingester writes its `funnel_access_log` rows **across** to the db qube — the one INSERT-only
path this qube keeps to `:5432`. `funnel_access_log` is request metadata only (timestamp,
path, status, client IP — no thought content, no credentials), so a popped edge writing to
that one table is low-value. The parked local `postgres` above is the documented future home
for those logs, which would sever this qube's last DB path (GH #12).

## Verify

```sh
docker compose config --services      # exactly: caddy, log-ingester  (NOT postgres)
docker compose up -d
curl -s http://127.0.0.1:9787/caddy-health   # → ok
```

The `"POSTGRES_PASSWORD" variable is not set. Defaulting to a blank string` warnings on
`config`/`up` are **expected** — they're the unset passwords of the parked `logs-future`
postgres, which never starts. That blankness is the point: it's what keeps the superuser and
app credentials off this qube.
