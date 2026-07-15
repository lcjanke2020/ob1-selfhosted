# ingress qube — Funnel + Caddy + log-ingester

The **ingress** (public-edge) qube of the [three-qube split](../three-qube-design.md): it
terminates the Tailscale Funnel and runs Caddy (the header-discriminated perimeter) plus the
log-ingester. It reverse-proxies to the [app qube](../app-qube/)'s mcp over the tailnet and
holds **no** memory store and **no** app credential — only two observability credentials:
the INSERT-only ingester and the SELECT-only [funnel monitor](#funnel-monitor-host-side-not-compose).
The canonical Postgres is on the [db qube](../db-qube/).

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

The compose project is **not** auto-started on reboot. To bring it back automatically, add
`docker compose -f /path/to/ingress-qube/docker-compose.yml up -d` to `rc.local`, or run it
by hand after a reboot (and re-assert the Funnel rule below).

## Credentials (per-qube split)

This qube's `.env` holds **only** `OPENBRAIN_INGESTER_PASSWORD` (INSERT-only on
`funnel_access_log`), plus `MCP_UPSTREAM` and `DB_HOST`. It carries **no** superuser or app
password — the parked postgres references them as plain `${VAR}`, left unset they interpolate
empty and are never used (the service never starts). The db qube's `pg_hba` must permit
`openbrain_ingester` from **this** qube's tailnet IP (see [`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)).

The one other DB credential on this qube is the funnel monitor's SELECT-only
`OPENBRAIN_MONITOR_PASSWORD` — deliberately **not** in this `.env` (it never enters a
container environment) but in a host-side `~/.config/funnel-monitor.env`, 0600. See
[Funnel monitor](#funnel-monitor-host-side-not-compose) below.

## Why the log-ingester writes across to the db qube

Caddy's access logs live here; the canonical Postgres lives on the db qube. For now the
ingester writes its `funnel_access_log` rows **across** to the db qube — the one INSERT-only
path this qube keeps to `:5432`. `funnel_access_log` is request metadata only (timestamp,
path, status, client IP — no thought content, no credentials), so a popped edge writing to
that one table is low-value. The parked local `postgres` above is the documented future home
for those logs, which would sever this qube's last DB path (GH #12).

## Funnel monitor (host-side, not compose)

An alert-only host script ([`scripts/funnel_monitor.sh`](../../../scripts/funnel_monitor.sh))
probes the db qube every 5 minutes as a dedicated SELECT-only role (`openbrain_monitor`,
readable tables: `funnel_access_log` + `mcp_auth_events` — request metadata, never thoughts)
and appends to `~/funnel_monitor.log`: funnel request volume over the window (alert above
`VOLUME_THRESHOLD`, default 200) and auth failures excluding `missing_credentials` (alert
above 0). It **fails loud**: an empty/non-numeric probe result — db qube unreachable, role
or credential broken — is itself an ALERT, so the monitor can't die silently while the
timer looks healthy.

**Provision the role** (once): on a fresh init, set `OPENBRAIN_MONITOR_PASSWORD` before
`db/00-roles.sh` runs; on an existing DB, run
[`scripts/upgrade-add-monitor-role.sh`](../../../scripts/upgrade-add-monitor-role.sh)
(compose) or the equivalent `CREATE ROLE` by hand on the db qube
(see [`../db-qube/README.md`](../db-qube/README.md)), then re-run `db/02-observability.sql`
for the grants. The db qube's `pg_hba` must permit `openbrain_monitor` from **this** qube's
tailnet IP ([`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)).

**Install on this qube** (as the regular user, from the repo checkout):

```sh
cp scripts/funnel_monitor.sh ~/funnel_monitor.sh && chmod +x ~/funnel_monitor.sh
cp deploy/qubes/ingress-qube/funnel-monitor.env.example ~/.config/funnel-monitor.env
chmod 0600 ~/.config/funnel-monitor.env && $EDITOR ~/.config/funnel-monitor.env
mkdir -p ~/.config/systemd/user
cp deploy/qubes/ingress-qube/funnel-monitor.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now funnel-monitor.timer
```

These are **user** units — linger must be on or the timer stops firing without an open
shell session; see the [Qubes README](../README.md) § user timers. Watch it work with
`tail -f ~/funnel_monitor.log` (a `vol=N auth_failures=N` line every 5 minutes; probe
errors accumulate in `~/funnel_monitor.err`).

Future note: if the funnel logs ever move into this qube's parked local postgres
([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)), the volume query's target
moves with them while auth events stay on the central DB — the monitor env would then need
per-metric DB targets.

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
