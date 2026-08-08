# ingress qube — Funnel + Caddy + log-ingester

The **ingress** (public-edge) qube of the
[three-qube split](../three-qube-design.md): it terminates the Tailscale Funnel
and runs Caddy (the header-discriminated perimeter) plus the log-ingester. It
reverse-proxies to the [app qube](../app-qube/)'s mcp over a dom0-policy-gated
qubes.ConnectTCP channel
([the ingress→app hop](#the-ingressapp-hop-qubesconnecttcp) below) and holds
**no** memory store and **no** app credential — only two observability
credentials: the INSERT-only ingester and the SELECT-only
[funnel monitor](#funnel-monitor-host-side-not-compose). The canonical Postgres
is on the [db qube](../db-qube/).

Build this qube with the shared bind-dirs / SELinux / systemd-persistence
mechanics from the [Qubes README](../README.md) first; this directory is the
ingress-qube-specific overlay.

## Run

```sh
cp .env.example .env && $EDITOR .env     # MCP_UPSTREAM (ConnectTCP forwarder), DB_HOST (db qube), ingester pw
docker compose up -d
```

`MCP_UPSTREAM` points at the
[ConnectTCP forwarder](#the-ingressapp-hop-qubesconnecttcp) on this qube's own
IP (`<this-qube-ip>:18787`), not at an app-qube network address — install the
forwarder below before expecting requests to complete.

Then expose Caddy publicly (host, not compose):

```sh
sudo tailscale serve  --https=443 off                          # vacate :443
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787   # single rule
```

[`docker-compose.yml`](docker-compose.yml) is self-contained — `caddy` +
`log-ingester`, plus a **parked** local `postgres` (profile `logs-future`) kept
on disk for a future local logs store but never started. Do **not** set
`COMPOSE_PROFILES` on this qube.

The stack runs under the operator account's **rootless** dockerd (see the
[Qubes README § Rootless docker](../README.md#rootless-docker-the-deployed-engine-posture)),
and reboot recovery is automatic: with `loginctl enable-linger user` the user
manager starts the rootless daemon at boot and `restart: unless-stopped` resumes
the containers; the Funnel rule persists in tailscaled's own state
(`/var/lib/tailscale` is bind-dir'd), so it needs no re-assert either. After a
reboot, verify rather than restart: `docker compose ps`, then the
[funnel monitor](#funnel-monitor-host-side-not-compose) log.

## The ingress→app hop (qubes.ConnectTCP)

Caddy does not proxy to an app-qube network address — the app qube's mcp
publishes `127.0.0.1:8787` only and has **no network-facing listener**. Instead,
a small host-side `socat` forwarder on this qube bridges Caddy to a qrexec
`qubes.ConnectTCP` channel that dom0 policy gates (same pattern as the optional
[GPU-offload transport](../gpu-offload-transport.md)):

```
caddy container ──(this qube's own IP :18787)──▶ socat  [ingress qube host]
                        └─ qubes.ConnectTCP+8787 (qrexec) ─▶ <app-qube> 127.0.0.1:8787
```

The forwarder binds the qube's **own IP** (`qubesdb-read /qubes-ip`): under
rootless docker the caddy container reaches its own host via slirp4netns — the
packet arrives on `lo`, which the qubes input chain accepts, so no firewall rule
is needed — while eth0/tailscale peers are covered by the qubes input
default-drop (nothing accepts `:18787`).

Install (the qube's **template** must have `socat`; `/usr` is template-provided,
so an AppVM-local install vanishes on reboot):

1. Stage the two files (root-owned, script `chmod +x`):
   [`ob1-mcp-forward.sh`](ob1-mcp-forward.sh) → `/rw/config/ob1-mcp-forward.sh`
   (set `<app-qube>` to your app qube's name) and
   [`ob1-mcp-forward.service`](ob1-mcp-forward.service) →
   `/rw/config/ob1-mcp-forward.service`.
2. Restage from `/rw/config/rc.local` each boot (`/etc/systemd` is wiped on
   AppVM reboot):

   ```sh
   if [ -f /rw/config/ob1-mcp-forward.service ]; then
     cp /rw/config/ob1-mcp-forward.service /etc/systemd/system/
     systemctl daemon-reload
     systemctl enable --now ob1-mcp-forward.service
   fi
   ```

3. dom0 policy (e.g. `/etc/qubes/policy.d/30-ob1-connecttcp.policy`) — the
   destination must be **explicit** (a call naming a target does not match an
   `@default` rule), and `autostart=no` keeps a proxied request from ever
   booting a halted app qube as a side effect:

   ```
   qubes.ConnectTCP +8787 <ingress-qube> <app-qube> allow autostart=no
   ```

   Lint it after editing (`qubes-policy-lint`, or the parser one-liner in
   [`../gpu-offload-transport.md`](../gpu-offload-transport.md#1-dom0-policy)).

4. Point `MCP_UPSTREAM` at `<this-qube-ip>:18787` in `.env` and recreate Caddy.

Verify: from this qube's host, `curl -s http://<this-qube-ip>:18787/health`
should return mcp's health JSON — that one request exercises the whole chain
(forwarder → qrexec policy → app-qube loopback publish). Then make a real
end-to-end request through the public door. On the **app** qube, `ss -tlnp` must
show `:8787` on `127.0.0.1` only; from any third qube, a connect to the app
qube's `:8787` times out (no listener exists).

**Rollback** (one line + one compose edit): set
`MCP_UPSTREAM=<app-qube-tailnet-ip>:8787`, republish mcp as `0.0.0.0:8787` in
the app-qube compose, and re-scope that wide bind (Tailscale ACL + a
`DOCKER-USER` rule) as the pre-ConnectTCP design did. The forwarder unit and
policy line can stay in place; they are inert while unused.

## Credentials (per-qube split)

This qube's `.env` holds **only** `OPENBRAIN_INGESTER_PASSWORD` (INSERT-only on
`funnel_access_log`), plus `MCP_UPSTREAM` and `DB_HOST`. It carries **no**
superuser or app password — the parked postgres references them as plain
`${VAR}`, left unset they interpolate empty and are never used (the service
never starts). The db qube's `pg_hba` must permit `openbrain_ingester` from
**this** qube's tailnet IP (see
[`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)).

The one other DB credential on this qube is the funnel monitor's SELECT-only
`OPENBRAIN_MONITOR_PASSWORD` — deliberately **not** in this `.env` (it never
enters a container environment) but in a host-side
`~/.config/funnel-monitor.env`, 0600. See
[Funnel monitor](#funnel-monitor-host-side-not-compose) below.

## Why the log-ingester writes across to the db qube

Caddy's access logs live here; the canonical Postgres lives on the db qube. For
now the ingester writes its `funnel_access_log` rows **across** to the db qube —
the one INSERT-only path this qube keeps to `:5432`. `funnel_access_log` is
request metadata only (timestamp, path, status, client IP — no thought content,
no credentials), so a popped edge writing to that one table is low-value. The
parked local `postgres` above is the documented future home for those logs,
which would sever this qube's last DB path (GH #12).

## Funnel monitor (host-side, not compose)

An alert-only host script
([`scripts/funnel_monitor.sh`](../../../scripts/funnel_monitor.sh)) probes the
db qube every 5 minutes as a dedicated SELECT-only role (`openbrain_monitor`,
readable table: `funnel_access_log` only — never reason-coded auth events or
thoughts) and appends to `~/funnel_monitor.log`: funnel request volume over the
window (alert above `VOLUME_THRESHOLD`, default 200) and newly ingested HTTP 401
responses at the public Funnel door (local alert at
`AUTH_FAILURE_BURST_THRESHOLD`, default 5). It **fails loud**: an
empty/non-numeric probe result — db qube unreachable, role or credential broken
— is itself an ALERT, so the monitor can't die silently while the timer looks
healthy.

Pushover delivery is opt-in (`PUSHOVER_ENABLED=1`). A successful interval with
at least `AUTH_FAILURE_BURST_THRESHOLD` new Funnel 401 rows (default 5) sends
one aggregate push; later qualifying intervals accumulate and roll up no more
often than `PUSHOVER_ROLLUP_SECONDS` (default 1800, 30 minutes). The row-id
cursor and pending count are atomically committed together under
`~/.local/state/funnel-monitor/` before delivery. A `flock` lock (from
util-linux, installed by default on the supported Qubes templates) serializes
timer and manual invocations across state load, queries, delivery, and final
commit. Delayed log-ingester rows are therefore not missed, a failed provider
call retains its count for retry, and a crash can at worst repeat an aggregate
alert. Turning delivery on does not replay activity observed while it was off.

This first-cut signal is deliberately narrow: the edge credential cannot read
`mcp_auth_events`, so reason-coded and tailnet-door credential rejections remain
in the central audit/rollup path rather than this alert. Successful intervals
below the burst threshold advance the cursor and do not enter a later rollup;
set the threshold to 1 if every newly ingested public-door 401 should qualify.

The provider-visible alert body is deliberately fixed and small: a generic
operator label, the aggregate Funnel 401-row count across qualifying burst
windows, and a statement that no request details are included. It never includes
a hostname, qube/container name, client IP, path, identity, request content, or
application/database/client credential. (Pushover necessarily receives its own
delivery token and user key as authentication form fields.) Pushover is
alert-only; the script never closes Funnel or changes firewall state.

**Provision the role** (once): on a fresh init, set `OPENBRAIN_MONITOR_PASSWORD`
before `db/00-roles.sh` runs; on an existing DB, run
[`scripts/upgrade-add-monitor-role.sh`](../../../scripts/upgrade-add-monitor-role.sh)
(compose) or the equivalent `CREATE ROLE` by hand on the db qube (see
[`../db-qube/README.md`](../db-qube/README.md)), then re-run
`db/02-observability.sql` for the grants and `db/03-grants-assertion.sql` to
verify them. The db qube's `pg_hba` must permit `openbrain_monitor` from
**this** qube's tailnet IP
([`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)).

**Upgrading a v3 deployment — install v4 here first, then replay the SQL.**
`db/02-observability.sql` revokes the monitor role's obsolete `mcp_auth_events`
access, converging this edge credential to the one-table contract. v3 probes
that table. Replaying the SQL while v3 is still installed therefore breaks its
second probe: the query returns `permission denied`, the probe reads as empty,
and every subsequent run logs `monitor probe FAILED` on the timer's cadence —
with the local auth-failure alarm effectively down for the whole gap. The
reverse order has no such window, because v4 never reads `mcp_auth_events` and
its `funnel_access_log` grant is unchanged, so it runs correctly against a
not-yet-converged database. Install v4 below, then replay
`db/02-observability.sql`, then verify with `db/03-grants-assertion.sql` —
ideally back to back in one window. This is the general rule for host-side
consumers in the split topology; see
[Upgrading an existing deployment](../app-qube/README.md#upgrading-an-existing-deployment).

**Install on this qube** (as the regular user, from the repo checkout):

```sh
mkdir -p ~/.config/systemd/user
cp scripts/funnel_monitor.sh ~/funnel_monitor.sh && chmod +x ~/funnel_monitor.sh
cp deploy/qubes/ingress-qube/funnel-monitor.env.example ~/.config/funnel-monitor.env
chmod 0600 ~/.config/funnel-monitor.env && $EDITOR ~/.config/funnel-monitor.env
cp deploy/qubes/ingress-qube/funnel-monitor.service ~/.config/systemd/user/
cp deploy/qubes/ingress-qube/funnel-monitor.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now funnel-monitor.timer
```

The script enforces that `~/.config/funnel-monitor.env` is a current-user-owned,
non-symlink regular file with no group/other permissions. Leave
`PUSHOVER_ENABLED=0` until the provider path below is ready. V4 sources this
file without exporting arbitrary entries so the database password cannot leak to
child tools. If an older deployment relied on a non-secret libpq variable such
as `PGSSLMODE`, export it from the service environment (for example, a systemd
user-unit drop-in) instead of adding it to this file. A malformed
`PUSHOVER_ENABLED` value emits a local alert and behaves as `0`; it never
suppresses the volume or local 401-burst probes.

### Optional Pushover delivery

Keep the application token and user key out of the sourced env file. Install
them as two separate, non-empty `0600` files, without trailing newlines:

```sh
umask 077
mkdir -p ~/.config/funnel-monitor
read -rs t && printf %s "$t" > ~/.config/funnel-monitor/pushover-token; unset t
read -rs u && printf %s "$u" > ~/.config/funnel-monitor/pushover-user; unset u
chmod 0600 ~/.config/funnel-monitor/pushover-token
chmod 0600 ~/.config/funnel-monitor/pushover-user
```

The script rejects symlinks, wrong ownership, empty files, CR/LF characters, and
any mode other than `0600`. At send time curl reads each secret directly from
its file, so neither value appears in process argv or logs.

Verify host egress before enabling delivery. This request sends no credential;
any HTTP status proves DNS/TLS reachability (the API root need not return 2xx):

```sh
curl -sS -o /dev/null -w 'Pushover probe HTTP %{http_code}\n' https://api.pushover.net
```

On Qubes, this host path is governed by the ingress qube's Qubes-firewall
policy, not a container `DOCKER-USER` chain. Then edit
`~/.config/funnel-monitor.env`, choose a generic `OB1_MONITOR_LABEL` such as
`ob1` (never an infrastructure name), tune the threshold if needed, and set
`PUSHOVER_ENABLED=1`. Run `~/funnel_monitor.sh` once and inspect its exit status
plus local log before relying on the timer. A live-fire acceptance test should
produce a controlled set of invalid-auth requests at or above the configured
threshold, confirm exactly one content-free push, and then confirm a second
qualifying interval is held for the rollup rather than pushed
request-by-request.

These are **user** units — linger must be on or the timer stops firing without
an open shell session; see the [Qubes README](../README.md) § user timers. Watch
it work with `tail -f ~/funnel_monitor.log` (a `vol=N funnel_401_rows=N` line
every 5 minutes; probe errors accumulate in `~/funnel_monitor.err`; successful
provider calls append only their aggregate count). Both files append
indefinitely — at 5-minute cadence that's slow, but on a long-lived qube add a
logrotate rule (or an occasional truncate) for the pair.

Future note: if the funnel logs ever move into this qube's parked local postgres
([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)), the volume
query's target moves with them too; both monitor queries would then be local and
the edge's central-DB SELECT path could be removed.

## Verify

```sh
docker compose config --services      # exactly: caddy, log-ingester  (NOT postgres)
docker compose up -d
curl -s http://127.0.0.1:9787/caddy-health   # → ok
```

The `"POSTGRES_PASSWORD" variable is not set. Defaulting to a blank string`
warnings on `config`/`up` are **expected** — they're the unset passwords of the
parked `logs-future` postgres, which never starts. That blankness is the point:
it's what keeps the superuser and app credentials off this qube.
