# ingress qube — Funnel + Caddy + log-ingester

The **ingress** (public-edge) qube of the
[three-qube split](../three-qube-design.md): it terminates the Tailscale Funnel
and runs Caddy (the header-discriminated perimeter), the log-ingester, and a
[local log sink](#local-log-sink). It reverse-proxies to the
[app qube](../app-qube/)'s mcp over a dom0-policy-gated qubes.ConnectTCP channel
([the ingress→app hop](#the-ingressapp-hop-qubesconnecttcp) below) and holds
**no** memory store and **no** app credential.

**This qube has no network path to the [db qube](../db-qube/) at all** — no
address for it, no credential on it, no firewall rule toward it. Its three
database credentials are all for the local sink, whose entire contents are
Funnel request metadata. The canonical Postgres remains on the db qube, reached
only by the app qube.

Build this qube with the shared bind-dirs / SELinux / systemd-persistence
mechanics from the [Qubes README](../README.md) first; this directory is the
ingress-qube-specific overlay.

## Run

```sh
install -d -m 0755 ~/ob1-log-sink/run    # the log sink's socket dir — keep the path SHORT (see below)
cp .env.example .env && $EDITOR .env     # MCP_UPSTREAM (ConnectTCP forwarder), LOG_SINK_* + role passwords
docker compose up -d
```

### Existing sink upgrade: coordinate the schema and installed rollup

Postgres skips every `initdb.d` mount on an existing `log_sink_data` volume. The
host timer runs installed copies at `~/funnel_daily_summary.sh` and
`~/summarize_funnel.sql`, not the checkout. The old SQL fails after the new
column lands, and the new SQL fails before it lands, so treat them as one
maintenance window: stop the writer and summary job, refresh both installed
copies, reapply the idempotent schema/grant owner, stream the generated-column
migration through the current container, and run the completed-catalog
assertion:

```sh
docker compose stop log-ingester
systemctl --user stop funnel-summary.timer funnel-summary.service

install -m 0755 ../../../scripts/funnel_daily_summary.sh ~/funnel_daily_summary.sh
install -m 0644 ../../../db/summarize_funnel.sql          ~/summarize_funnel.sql

docker compose exec -T --user postgres log-sink sh -eu -c '
  PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -w \
    -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-openbrain_logs}" -v ON_ERROR_STOP=1 -f -
' < ../../../db/log-sink/01-log-sink.sql

docker compose exec -T --user postgres log-sink sh -eu -c '
  PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -w \
    -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-openbrain_logs}" -v ON_ERROR_STOP=1 -f -
' < ../../../db/log-sink/02-log-sink-status-class.sql

docker compose exec -T --user postgres log-sink sh -eu -c '
  PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -w \
    -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-openbrain_logs}" -v ON_ERROR_STOP=1 -f -
' < ../../../db/log-sink/02-log-sink-assertion.sql
```

Reapplying `01-log-sink.sql` also grants database `TEMPORARY` directly to
`openbrain_logs_rollup`, so the new transaction-local projection works even when
a hardened installation has revoked PostgreSQL's stock `PUBLIC` default. The
migration then takes an access-exclusive table lock with a 10-second timeout,
adds one stored generated column, and backfills retained rows in one
transaction. A busy sink fails without a partial change; leave `log-ingester`
stopped and retry. A second successful run is a no-op. Do not recreate the
service or restart the writer unless the assertion prints `invariants OK`.

If the volume already has its completion marker, recreate the sink and then
continue at
[Finish either upgrade path](#finish-either-existing-sink-upgrade-path):

```sh
docker compose --env-file .env up -d --no-deps --force-recreate --wait log-sink
```

If it predates the marker, keep the writer stopped and continue with the
adoption step below; restart it only after the marker-gated recreate succeeds.

### Older sink upgrade: adopt the pre-marker volume

This step applies only when `log_sink_data` was initialized by a release that
predates `.openbrain-log-sink-init-complete`. **After updating the checkout but
before any `docker compose up` that would recreate `log-sink`**, first apply the
schema/grant replay and status-class migration above, leave the old healthy
container running, and execute:

```sh
../../../scripts/adopt-log-sink-marker.sh
docker compose --env-file .env up -d --no-deps --force-recreate --wait log-sink
```

The helper does not trust the old container's init log or old mounted assertion.
It streams the current
[`02-log-sink-assertion.sql`](../../../db/log-sink/02-log-sink-assertion.sql)
into that running container as the database superuser, verifies that the server
behind its unix socket uses the same `PGDATA`, and creates the marker as the
`postgres` OS user only after every current invariant passes. It makes no schema
or row changes. A partial or drifted sink exits nonzero and remains unmarked, so
the new entrypoint will continue to refuse it. Correct the drift and rerun the
helper; never substitute `touch` or create the marker yourself. It does not run
migrations, which is why the schema/grant replay and status-class step must
precede it.

The helper defaults to this Compose directory and its `.env`. Set
`COMPOSE_DIR=/absolute/path/to/the/running/project` only if the checkout and
running project are deliberately elsewhere. If the marker-gated definition was
already recreated and is refusing the old volume, do not delete the volume:
restore/start the previous Compose definition against that same volume, run the
helper while it is healthy, and then recreate with the current definition.

#### Finish either existing-sink upgrade path

With the current `log-sink` running on the migrated, marker-gated volume, run
the newly installed rollup once in the foreground. Only after it exits zero,
re-enable the timer and restart ingestion:

```sh
FUNNEL_SUMMARY_ENV_FILE=$HOME/.config/funnel-summary.env bash ~/funnel_daily_summary.sh
systemctl --user enable --now funnel-summary.timer
docker compose up -d --no-deps log-ingester
systemctl --user list-timers funnel-summary.timer --no-pager
```

If the foreground run fails, leave both the timer and writer stopped, correct
the installation or catalog, and rerun it. This keeps a mixed SQL/schema pair
from silently disabling summary retention overnight.

There is no `DB_HOST` here any more: the Funnel access log is written to a
[local sink](#local-log-sink) on this qube, so the internet-facing edge holds no
address for — and no route to — the db qube.

`MCP_UPSTREAM` points at the
[ConnectTCP forwarder](#the-ingressapp-hop-qubesconnecttcp) on this qube's own
IP (`<this-qube-ip>:18787`), not at an app-qube network address — install the
forwarder below before expecting requests to complete.

Then expose Caddy publicly (host, not compose):

```sh
sudo tailscale serve  --https=443 off                          # vacate :443
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787   # single rule
```

[`docker-compose.yml`](docker-compose.yml) is self-contained — `caddy`,
`log-ingester`, and `log-sink` (this qube's own socket-only Postgres; see
[Local log sink](#local-log-sink)).

The stack runs under the operator account's **rootless** dockerd (see the
[Qubes README § Rootless docker](../README.md#rootless-docker-the-deployed-engine-posture)),
and reboot recovery is automatic: `loginctl enable-linger user` — persisted by
the `/var/lib/systemd/linger` bind-dir, without which the flag lasts exactly one
boot — makes the user manager start the rootless daemon at boot, and
`restart: unless-stopped` resumes the containers; the Funnel rule persists in
tailscaled's own state (`/var/lib/tailscale` is bind-dir'd), so it needs no
re-assert either. After a reboot, verify rather than restart — and verify from
outside before any interactive login (a login starts the user manager and masks
a broken linger): probe the public door, then `docker compose ps` and the
[funnel monitor](#funnel-monitor-host-side-not-compose) log.

This qube's boot-time root-side work lives in the shipped
[`rc.local`](rc.local): it starts tailscaled, re-asserts rootful docker off
(same block and rationale as the app qube's — this is the public edge, where the
root-equivalent `docker` group matters most), applies
[`qubes-firewall-user-script`](qubes-firewall-user-script) via the
[`ob1-ingress-firewall.service`](ob1-ingress-firewall.service) one-shot (a
tailnet SSH accept plus a **conservative** `:443` accept — neither serving door
actually needs an inbound rule on current Tailscale: Funnel rides tailscaled's
outbound tunnel, and tailnet-direct `serve` traffic is netstack-intercepted
inside tailscaled before it reaches the input chain; see the script header), and
restages the ConnectTCP forwarder unit below.

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

1. Stage this qube's boot + firewall files under `/rw/config/` (all root-owned;
   scripts `chmod +x`). `rc.local` restages + enables both units at every boot
   (`/etc/systemd` is wiped on AppVM reboot) and logs a WARNING to
   `/var/log/ob1-ingress-boot.log` if a file is missing:

   | File                                                               | Install at                                   |
   | ------------------------------------------------------------------ | -------------------------------------------- |
   | [`ob1-mcp-forward.sh`](ob1-mcp-forward.sh) — set `APP_QUBE=` first | `/rw/config/ob1-mcp-forward.sh` (+x)         |
   | [`ob1-mcp-forward.service`](ob1-mcp-forward.service)               | `/rw/config/ob1-mcp-forward.service`         |
   | [`qubes-firewall-user-script`](qubes-firewall-user-script)         | `/rw/config/qubes-firewall-user-script` (+x) |
   | [`ob1-ingress-firewall.service`](ob1-ingress-firewall.service)     | `/rw/config/ob1-ingress-firewall.service`    |
   | [`rc.local`](rc.local)                                             | `/rw/config/rc.local` (+x)                   |

   After the first boot (or a manual `sudo sh /rw/config/rc.local`), verify:
   `systemctl status ob1-ingress-firewall ob1-mcp-forward` both active, and
   `/var/log/ob1-ingress-firewall.log` showing each accept added (or "already
   present; skipping").

2. dom0 policy (e.g. `/etc/qubes/policy.d/30-ob1-connecttcp.policy`) — the
   destination must be **explicit** (a call naming a target does not match an
   `@default` rule), and `autostart=no` keeps a proxied request from ever
   booting a halted app qube as a side effect:

   ```
   qubes.ConnectTCP +8787 <ingress-qube> <app-qube> allow autostart=no
   ```

   Lint it after editing (`qubes-policy-lint`, or the parser one-liner in
   [`../gpu-offload-transport.md`](../gpu-offload-transport.md#1-dom0-policy)).

3. Point `MCP_UPSTREAM` at `<this-qube-ip>:18787` in `.env` and recreate Caddy.

Verify: from this qube's host, `curl -s http://<this-qube-ip>:18787/health`
should return mcp's health JSON — that one request exercises the whole chain
(forwarder → qrexec policy → app-qube loopback publish). Then make a real
end-to-end request through the public door. On the **app** qube, `ss -tlnp` must
show `:8787` on `127.0.0.1` only — that is the check that proves no
network-facing listener exists. (A third qube's probe of the app qube's `:8787`
times out, but that timeout is the qubes input default-drop doing its work, not
proof of the missing socket — a listener behind the drop would time out
identically. The `ss` line is the socket proof; the drop means even a probe is
never answered.)

**Rollback** (documented; not exercised live): set
`MCP_UPSTREAM=<app-qube-tailnet-ip>:8787` here, republish mcp as `0.0.0.0:8787`
in the app-qube compose, and scope the re-opened wide bind on the app qube:

- a `custom-input` accept for the ingress peer only — under **rootless** docker
  a published port is a plain host listener governed by the qubes input chain
  (default-drop), so without this accept the rollback fails closed. Immediate
  (root — nft mutation needs it):

  ```sh
  sudo nft add rule ip qubes custom-input iifname "tailscale0" \
    ip saddr <ingress-qube-tailnet-ip> tcp dport 8787 ct state new accept
  ```

  **Make it survive a reboot**: the live rule alone dies with the ruleset — the
  app qube's boot applier re-runs its `qubes-firewall-user-script`, which
  carries no `:8787` rule — so for any rollback longer than the current boot,
  also add the same `nft add rule …` line (with the concrete ingress IP) to the
  app qube's `/rw/config/qubes-firewall-user-script` before its `exit 0`, then
  `sudo systemctl restart ob1-app-firewall.service` and check
  `/var/log/ob1-app-firewall.log`. Remove that line again when rolling forward
  to ConnectTCP — it is the one piece of rollback state that would otherwise
  linger.

  (This accept replaces the retired rootful design's `DOCKER-USER` rule, which
  cannot see rootless-published traffic. One improvement over the old shape: a
  `custom-input` rule isn't flushed by docker daemon restarts, so the "firewall
  state must stay continuously right" weakness does not return.)
- the Tailscale ACL grant ingress→app:8787, if it was removed after cutover.

The forwarder unit and policy line can stay in place; they are inert while
unused.

## Credentials (per-qube split)

Every credential on this qube belongs to the **local sink**. None of them
authenticates against the db qube, and the db qube's
[`pg_hba`](../db-qube/pg_hba.snippet.conf) deliberately carries no line for this
qube at all.

| Credential                       | Lives in                      | Role on the sink                         |
| -------------------------------- | ----------------------------- | ---------------------------------------- |
| `LOG_SINK_SUPERUSER_PASSWORD`    | `.env`                        | init only — creates the roles and schema |
| `OPENBRAIN_INGESTER_PASSWORD`    | `.env`                        | INSERT on `funnel_access_log`            |
| `OPENBRAIN_LOGS_ROLLUP_PASSWORD` | `.env` + `funnel-summary.env` | table DML + database `TEMPORARY`         |
| `OPENBRAIN_MONITOR_PASSWORD`     | `.env` + `funnel-monitor.env` | SELECT on `funnel_access_log` only       |

The `.env` copy of a role password is what **creates** the role at container
init; the `~/.config/*.env` copy is what the host-side job **authenticates**
with. They must match, which is why the monitor password now appears in both
places (before the sink, the role was created on the db qube and this qube only
ever held the client half).

Note what is _not_ here: no `POSTGRES_PASSWORD`, no `OPENBRAIN_APP_PASSWORD`,
and no variable whose name contains `APP`. The sink's DML role is
`openbrain_logs_rollup` precisely so that a secret on the internet-facing qube
can never be confused with, or copy-pasted from, an app-role secret.

The two host-side credentials stay out of container environments entirely, in
0600 files (`~/.config/funnel-monitor.env`, `~/.config/funnel-summary.env`).

## Local log sink

Caddy's access logs live here, so their store does too. The `log-sink` service
is this qube's own Postgres, holding `funnel_access_log` and
`funnel_access_summary` and **nothing else** — no thoughts, no
`mcp_auth_events`, no pgvector.

The checked [role contract](../../../db/log-sink/role-contract.json) names the
required `openbrain_ingester` and `openbrain_logs_rollup` identities plus the
optional `openbrain_monitor`, their exact relation grants, and the rollup's
database `TEMPORARY` capability. CI validates every unavoidable SQL, Compose,
script, and primary-runbook literal against that manifest before starting a
database fixture.

Earlier revisions kept the ingester writing **across** to the db qube on
`:5432`, documented as a deliberate scoped exception
([#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) option 2) on the
grounds that `funnel_access_log` is request metadata only. The exception is now
removed rather than justified (option 3). The reason is a layering one: role
grants are enforced **inside** Postgres, above the layer a pre-auth
wire-protocol or SCRAM-handshake flaw would live at. While a socket on the db
qube was reachable from the internet-facing qube, a popped edge had a path
toward the corpus regardless of how narrow its grants were. Enforcement now sits
below anything this qube can reach.

What an attacker gains by owning this cluster is a strict subset of what owning
the qube already gives them: Caddy's access logs are on the same disk.

**Socket only, three ways.** `listen_addresses=` is empty, so Postgres opens no
TCP socket; `network_mode: none` leaves both containers with only `lo`; and no
port is published. The check that proves it is on the **host**:

```bash
ss -tlnp | grep 5432          # → nothing
log_sink_container="$(docker compose ps -q log-sink)"
if [[ -z "$log_sink_container" || "$log_sink_container" == *$'\n'* ]]; then
  echo "expected exactly one running log-sink container" >&2
  exit 1
fi
docker inspect "$log_sink_container" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'   # → none
```

**Data posture: disposable.** 30-day raw, 365-day aggregate (the same retention
the central store enforced), and **no backup**. Losing this cluster costs
request metadata that was already this qube's to lose; adding the perimeter to
the backup pipeline would create a new data path _out_ of it, which is the
opposite of the point. Plan on rebuilding it rather than restoring it.

**One consequence, stated plainly.** Funnel access logs and the thought corpus
are now separate databases, so "which requests preceded this thought write" is
no longer a SQL join. That query was always weak — `funnel_access_log` carries
no thought or session id, so the correlation was timestamp-and-client-IP
guesswork — and the auth-side audit (`mcp_auth_events`) stays next to the corpus
where it is written. If you need the correlation, you need a log shipper from
this qube to the db qube, which is exactly the network path this design removes.

### Gotchas that cost real debugging time

- **The stock postgres image trusts every local connection.** Its default
  `pg_hba.conf` carries `local all all trust`, so _anything_ that can reach the
  socket may connect as **any** role — including the superuser — with no
  password. On a socket-only deployment that silently makes the INSERT-only
  ingester grant decorative. The sink sets
  `POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256`, and `docker-entrypoint.sh`
  exports `PGPASSWORD` during init specifically so that works. Verify it rather
  than assuming — a wrong password must be refused:

  ```sh
  PGPASSWORD=wrong psql -h ~/ob1-log-sink/run -U openbrain_monitor -d openbrain_logs -c 'select 1'
  # → FATAL: password authentication failed
  ```

- **A failed first init stays failed.** The stock image writes `PG_VERSION`
  before running `initdb.d`, so an ordinary restart can skip the script that
  failed and start a partial schema. This deployment writes
  `.openbrain-log-sink-init-complete` only after the final assertion, checks it
  in both the entrypoint and healthcheck, and refuses a pre-existing data
  directory without it. Inspect the first-init logs; never create the marker by
  hand. The only supported exception is the assertion-gated adoption helper
  above for a healthy volume created before the marker existed. For a genuinely
  new/disposable sink whose first init failed, remove and recreate only its
  `log_sink_data` volume after correcting the cause.

- **Keep the socket directory path short.** A unix socket path is capped at 107
  bytes (`sun_path`), and it is the **host** path that counts for the host-side
  monitor and rollup. A deep directory fails at _connect_ time with
  `Unix-domain socket path … is too long`, not at mount time.

- **No `chown` is needed, and trying to clean up by hand will fail.** The
  postgres entrypoint chowns `/var/run/postgresql` to its own user on every
  start, which under rootless docker lands on a subuid while leaving the
  directory `o+rx` and the socket `0777` — so your account can still connect.
  The flip side: leftover socket files are owned by that subuid, so a plain `rm`
  from your shell gets `Operation not permitted`. Remove them from a container
  (`docker run --rm -v ~/ob1-log-sink/run:/x alpine rm -f /x/.s.PGSQL.5432*`) or
  just let the next start reuse the directory.

- **`docker compose up -d --build` rebuilds Caddy too**, because its `build`
  block sets `pull: true` — a fresh base layer produces a new image, which
  forces a recreate and briefly drops the public door. When you only mean to
  touch the log path, name the services:
  `docker compose up -d --build log-sink log-ingester`.

- **A unix connect needs three Deno permissions, not two.** Deno describes it as
  `unix:<path>` and requires `--allow-net` for it _in addition to_
  `--allow-read` and `--allow-write`. Handled in
  [`server/Dockerfile.ingester`](../../../server/Dockerfile.ingester); it
  matters if you fork the image.

## Funnel monitor (host-side, not compose)

An alert-only host script
([`scripts/funnel_monitor.sh`](../../../scripts/funnel_monitor.sh)) probes the
**local sink** every 5 minutes as a dedicated SELECT-only role
(`openbrain_monitor`, readable table: `funnel_access_log` only — it cannot even
read `funnel_access_summary`) and appends to `~/funnel_monitor.log`: funnel
request volume over the window (alert above `VOLUME_THRESHOLD`, default 200) and
newly ingested HTTP 401 responses at the public Funnel door (local alert at
`AUTH_FAILURE_BURST_THRESHOLD`, default 5). It **fails loud**: an
empty/non-numeric probe result — sink down, role or credential broken — is
itself an ALERT, so the monitor can't die silently while the timer looks
healthy.

`DB_HOST` in `~/.config/funnel-monitor.env` is an absolute **path** now, not an
address: an absolute value makes psql use a unix socket, which is the only way
to reach the sink. No script change was needed — that is libpq's own convention.

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

**Provision the role**: nothing to do by hand. Set `OPENBRAIN_MONITOR_PASSWORD`
in this qube's `.env` before the sink's first `up`, and
[`db/log-sink/00-log-sink-roles.sh`](../../../db/log-sink/00-log-sink-roles.sh)
creates the role with its single grant. Leave the variable unset and the sink
creates no monitor role at all — the monitor is optional. Put the **same value**
in `~/.config/funnel-monitor.env`, which is what the script authenticates with.

To add the monitor to a sink that is already initialized, create the role by
hand (init scripts only run on a fresh data directory) and re-run the assertion:

Run from this qube's compose directory (`deploy/qubes/ingress-qube/`). The
socket demands scram auth even from the superuser — the entrypoint unsets
PGPASSWORD after init, and `compose exec` does not read `.env` — so the
superuser password, database, and role are pulled from `.env` and forwarded
explicitly. The assertion file lives in the repo, three levels up.

```sh
# Derive the configured values from .env (defaults match .env.example).
export PGPASSWORD="$(sed -n 's/^LOG_SINK_SUPERUSER_PASSWORD=//p' .env)"
SINK_SUPER="$(sed -n 's/^LOG_SINK_SUPERUSER=//p' .env)"; SINK_SUPER="${SINK_SUPER:-postgres}"
SINK_DB="$(sed -n 's/^LOG_SINK_DB=//p' .env)"; SINK_DB="${SINK_DB:-openbrain_logs}"
docker compose exec -T -e PGPASSWORD log-sink \
  psql -U "$SINK_SUPER" -d "$SINK_DB" -v ON_ERROR_STOP=1 <<'SQL'
  CREATE ROLE openbrain_monitor LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'PUT-THE-PASSWORD-HERE';
  GRANT USAGE ON SCHEMA public TO openbrain_monitor;
  GRANT SELECT ON funnel_access_log TO openbrain_monitor;
SQL
# The `< file` redirection reads from the HOST, relative to this directory, so
# point it at the repo checkout three levels up.
docker compose exec -T -e PGPASSWORD log-sink \
  psql -U "$SINK_SUPER" -d "$SINK_DB" -v ON_ERROR_STOP=1 \
  -f - < ../../../db/log-sink/02-log-sink-assertion.sql   # must print "invariants OK"
unset PGPASSWORD
```

**Repointing the monitor at a different database resets its cursor — do it
deliberately.** The monitor tracks the highest `funnel_access_log.id` it has
seen, in `~/.local/state/funnel-monitor/state`
(`<last-row-id> <last-push-epoch> <pending-auth-failures>`). A new sink's
sequence starts at 1, so a cursor carried over from another cluster is _higher_
than anything the new one can produce. The script treats that as a restore and
**refuses to advance**, logging
`monitor probe FAILED (funnel row id moved
backwards)` every interval — correct
fail-loud behaviour, and a permanent alarm until you clear it. Zero the cursor
once, after cutting over:

```sh
printf '0 0 0\n' > ~/.local/state/funnel-monitor/state
systemctl --user start funnel-monitor.service
tail -1 ~/funnel_monitor.log        # → vol=N funnel_401_rows=N, no ALERT
```

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

Both of the monitor's queries are now local, against the sink — the edge's
central-DB SELECT path is gone, which is what
[#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) anticipated.

## Daily rollup and retention (host-side, not compose)

The sink's retention is not automatic — it is enforced by the same daily job the
central store used, now running here against the socket.
[`db/summarize_funnel.sql`](../../../db/summarize_funnel.sql) recomputes each
day's aggregates into `funnel_access_summary`, finalizes and deletes raw rows
past 30 days, and drops summary rows past 365. **Without this timer the raw
table grows without bound.**

The companion half — `mcp_auth_events` retention and its report — runs on the
[app qube](../app-qube/README.md) against the corpus, because that is where mcp
writes it. Each qube runs the half that owns its tables; neither can see the
other's. Single-host Pattern B installs use the same two-target separation.

Install (as the regular user, from the repo checkout):

```sh
mkdir -p ~/.config/systemd/user
install -m 0755 scripts/funnel_daily_summary.sh ~/funnel_daily_summary.sh
install -m 0644 db/summarize_funnel.sql          ~/summarize_funnel.sql
install -m 0600 deploy/qubes/ingress-qube/funnel-summary.env.example ~/.config/funnel-summary.env
$EDITOR ~/.config/funnel-summary.env     # DB_HOST socket + OPENBRAIN_LOGS_ROLLUP_PASSWORD
install -d -m 0700 ~/openbrain-funnel-summaries
install -m 0644 deploy/qubes/ingress-qube/funnel-summary.service ~/.config/systemd/user/
install -m 0644 deploy/qubes/ingress-qube/funnel-summary.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
```

Run it once in the foreground before trusting the timer, then enable it:

```sh
FUNNEL_SUMMARY_ENV_FILE=$HOME/.config/funnel-summary.env bash ~/funnel_daily_summary.sh
systemctl --user enable --now funnel-summary.timer
systemctl --user list-timers funnel-summary.timer --no-pager
```

`SUMMARY_TARGET=sink` pins this unit to `summarize_funnel.sql`,
`openbrain_logs_rollup`, `openbrain_logs`, and an absolute socket host. The
wrapper rejects the retired free-form SQL/role knobs and any TCP host before it
starts `psql`.

Reports contain request metadata, so they land in a mode-0700 local directory.
Replicating them off this qube is a new outbound path from the perimeter; the
sink's disposable-data posture deliberately avoids one.

## Verify

```sh
docker compose config --services             # exactly: caddy, log-ingester, log-sink
docker compose up -d
curl -s http://127.0.0.1:9787/caddy-health   # → ok

# the sink is ready only with its durable completion marker
docker compose exec -T log-sink \
  sh -c 'test -f "$PGDATA/.openbrain-log-sink-init-complete"'

# the current catalog still satisfies the assertion (fresh or adopted volume)
docker compose exec -T --user postgres log-sink sh -eu -c '
  PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -w \
    -h /var/run/postgresql -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-openbrain_logs}" -v ON_ERROR_STOP=1 -f -
' < ../../../db/log-sink/02-log-sink-assertion.sql
ss -tlnp | grep 5432 || echo 'no TCP listener — correct'

# a request actually lands
curl -s -o /dev/null http://127.0.0.1:9787/mcp && sleep 6
docker compose logs --tail=3 log-ingester    # → "N/N rows inserted"
```

On a brand-new volume, additionally prove that `initdb.d` reached the assertion
and then its lexically-last marker script:

```sh
docker compose logs log-sink | grep -E 'invariants OK|init completion marker written'
```

`invariants OK` comes from
[`db/log-sink/02-log-sink-assertion.sql`](../../../db/log-sink/02-log-sink-assertion.sql),
which runs immediately before the marker script and **fails the init** if the
sink ever holds a third relation, a role with cluster-level privileges, an
unenumerated grant, or a `GRANT … TO PUBLIC`. The entrypoint refuses every later
start unless the marker exists. On a fresh volume, either log line's absence is
meaningful. On an adopted volume, the helper's successful assertion and
`pre-marker volume adopted after current invariants passed` line are the
corresponding evidence; init scripts correctly do not rerun on recreation.
