# app qube — mcp + Ollama

The **app** qube of the [three-qube split](../three-qube-design.md): it runs the
application half (the MCP server + Ollama embeddings) and nothing else. The
public edge (Funnel + Caddy + log-ingester) lives on the
[ingress qube](../ingress-qube/); the canonical Postgres lives on the
[db qube](../db-qube/). This qube is the **trusted compartment** — it holds the
DB admin credential and writes thoughts — reachable only from the ingress qube.

Build this qube with the shared bind-dirs / SELinux / systemd-persistence
mechanics from the [Qubes README](../README.md) first; this directory is the
app-qube-specific overlay.

## Run

```sh
cp .env.example .env && $EDITOR .env     # fill required values + choose the fallback policy
docker compose up -d
```

[`docker-compose.yml`](docker-compose.yml) is self-contained — `mcp` + `ollama`
only, no override stack. `mcp` is published on `0.0.0.0:8787` so the ingress
qube's Caddy can reach it across qubes (set
`MCP_UPSTREAM=<this-qube-tailnet-ip>:8787` in the _ingress_ qube's `.env`).
Ollama runs CPU-only (no GPU passthrough in a Qubes app qube); point
`OLLAMA_URL` at an external GPU box to offload it.

The compose project is **not** auto-started on reboot (`restart: unless-stopped`
only resurrects containers while the daemon is up, not the project after an
AppVM reboot). To bring it back automatically, add
`docker compose -f /path/to/app-qube/docker-compose.yml up -d` to `rc.local`
after the docker start, or run it by hand after a reboot.

## Offloading metadata classification (`CHAT_*`) to a GPU qube

The `mcp` server's optional metadata extractor (`CHAT_API_BASE`) calls an
OpenAI-compatible `/chat/completions` endpoint — any server that also supports
the strict `json_schema` response format it sends — so it routes with equal ease
to another machine on your network running a local LLM, or (with `CHAT_API_KEY`)
to a hosted OpenAI-compatible provider; neither needs plumbing. To instead keep
thought content on a **GPU qube on this same Qubes host** whose model server is
bound to loopback only (no network-facing listener — no LAN/tailnet bind, no
sshd), see [`../gpu-offload-transport.md`](../gpu-offload-transport.md): a
host-side `socat` forwarder + qrexec `ConnectTCP` transport, with the
firewall/`custom-input`, persistence, and `autostart=no` safety notes. It is a
deliberate tradeoff, not a default — the why and the costs are covered in
[Serving From a Qube With No Network-Facing Listener](https://github.com/lcjanke2020/qubes-os-explorations/blob/master/qrexec-connecttcp-service-qube.md).

`METADATA_FALLBACK_POLICY` is required and has no default. Choose `off` to
guarantee that a primary failure stores placeholder metadata without calling
`FALLBACK_CHAT_*`; choose `alert` to permit fallback only when at least one
Pushover/ntfy adapter is configured; choose `allow` to permit fallback without
requiring delivery. `alert` and `allow` also support a fallback-only deployment,
but `allow` is the privacy-weakest posture. On every restart, verify the log
line `[metadata] fallback policy: ...` reports the intended value.

## Credentials (per-qube split)

This qube holds the **admin/superuser** `POSTGRES_PASSWORD` (the trusted
compartment holds it, never the internet-adjacent ingress qube) and uses it to
**administer the db qube remotely** over the tailnet — role provisioning +
schema/migrations. The db qube's `pg_hba` grants the superuser a host line from
**this qube's IP only** — a deliberate trade-off (a compromised app qube then
has full DB admin — including `COPY … TO/FROM PROGRAM`, i.e. an app→db OS pivot
— not just the app role; accepted for now since this compartment runs the memory
application and the db qube is highly contained (the runtime app role itself is
still restricted by memory-space RLS) — see
[`../db-qube/README.md`](../db-qube/README.md) and
[#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15)). At runtime the
app qube also connects as `openbrain_app` (mcp writes thoughts; the
[daily rollup](#daily-funnel-rollup-and-retention-host-side) summarizes and
retires observability rows) and `openbrain_readonly` (the backup job). It does
**not** carry the log-ingester credential — that lives only on the ingress qube.

OAuth's verified `sub` supplies personal identity automatically. The seeded
`sensitive` workspace is therefore available without a shared-key principal:
call a thought/session tool with `workspace_id = "sensitive"` and personal
visibility. It is an application authorization boundary, not extra encryption;
the admin credential and read-only backup role can still read it. Scope
semantics and the required `db/06-spaces.sql` migration are in
[Memory spaces](../../../docs/spaces.md).

Server 1.16.0 also requires `db/07-metadata-degradation.sql` on the DB qube. It
records content-free classifier degradation and enqueues committed events
durably; this app qube can then deliver optional Pushover/ntfy alerts from the
ledger. Apply it before migration 08 below. See
[Metadata degradation monitoring](../../../docs/metadata-degradation-monitoring.md).
Upgrades also require an explicit `METADATA_FALLBACK_POLICY` in the app-qube
`.env`; an unset value deliberately prevents the new container from starting.

Server 1.19.0 also requires `db/08-access-tokens.sql` on the DB qube followed by
`db/03-grants-assertion.sql`. This Qubes posture stays OAuth-only:
`ENABLE_NATIVE_TOKENS=false` is pinned in compose and `MCP_ACCESS_KEY` remains
absent, so the new schema does not add an accepted credential at the public
edge. See
[Native access tokens](../../../docs/native-access-tokens.md#existing-database-upgrade)
for what the schema contains, and
[Upgrading an existing deployment](#upgrading-an-existing-deployment) for how to
apply it in this topology.

## Upgrading an existing deployment

`db/*.sql` are `docker-entrypoint-initdb.d` scripts: PostgreSQL runs them only
on a fresh data directory. On an existing database they never rerun, so neither
a new migration nor a tightened grant reaches a running deployment by itself.
Apply them by hand, in order, during an operator window.

The per-migration recipes under [`docs/`](../../../docs/) assume the single-box
compose install and `docker compose exec -T postgres`. **In this split topology
that command has nothing to exec into** — Postgres is not in the app compose
project. Run the same files from this qube's repository checkout, over the
tailnet, as the database superuser:

```sh
cd deploy/qubes/app-qube
( . ./.env
  PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "${POSTGRES_USER:-postgres}" \
    -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f ../../../db/08-access-tokens.sql )
```

Source without `set -a` and keep it in a subshell. `psql` needs exactly one
secret from that file; the rest — the app and read-only role passwords, the
model API keys, the notification credentials — stay unexported shell variables
that the client process never sees, and leave no trace in the operator's shell
once the subshell returns. `-h`/`-p`/`-d` are argument expansions and need no
export at all. This is the same rule the backup job states in
[`backup/backup.env.example`](backup/backup.env.example): only what the client
needs reaches the client.

This qube's `.env` carries the superuser _password_ but no `POSTGRES_USER`, so
the default above names the db qube's `postgres` superuser. Keep the override
hook: an operator who renamed that role sets `POSTGRES_USER` to match the
`pg_hba` line
([`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)). Passing an
empty `-U` is not equivalent — libpq treats it as absent and substitutes the
**login account's** name, which the db qube's `pg_hba` does not recognize.

Fedora's `postgresql` package provides the host `psql` client; it is commonly
already present beside the `pg_dump` client used by the encrypted backup. If it
is absent, install the package in this qube's Fedora **template** — an
AppVM-local install disappears on reboot.

### Which migration each server version requires

Rows start at 1.7.0. `db/01-schema.sql` through `db/04-sessions.sql` belong to
the initial install rather than to a version upgrade; a database predating any
of them needs it applied, in order, before the rows below.

| Server | Migration                        | Additional requirement                                        |
| ------ | -------------------------------- | ------------------------------------------------------------- |
| 1.7.0  | `db/05-hybrid-search.sql`        | pgvector 0.8.0+ (filtered iterative scans)                    |
| 1.9.0  | `db/06-spaces.sql`               | PostgreSQL 15+ (`NULLS NOT DISTINCT`); superuser, not owner   |
| 1.16.0 | `db/07-metadata-degradation.sql` | from 1.17.0, an explicit `METADATA_FALLBACK_POLICY` in `.env` |
| 1.19.0 | `db/08-access-tokens.sql`        | —                                                             |

Migration 08 is required by 1.19.0 **even when native tokens are disabled**.
`ENABLE_NATIVE_TOKENS` gates the credential door, not the schema: the server's
boot probe refuses to start without `native_auth`, so applying it _after_ the
container roll takes the deployment down rather than leaving it on the old
version. Apply migrations before the roll, not with it.

### Window order

1. Take the labelled pre-migration rollback point and verify it off-box —
   [Deploy-window rollback point](#deploy-window-rollback-point).
2. Tag the running image so a rollback needs no rebuild:
   `docker tag app-qube-mcp:latest app-qube-mcp:rollback-<previous-commit>`.
3. `git pull` the checkout on **every** qube that installs something from it:
   this one for compose and the rollup, the ingress qube for the Funnel monitor.
4. Reconcile `.env` against `.env.example`. `docker compose config --quiet` is a
   cheap dry run — it fails on a missing required variable without touching the
   running container.
5. **Install host-side consumers before replaying SQL that narrows a grant.**
   Several credentials in this topology live outside the compose project: the
   Funnel monitor's role on the ingress qube, the rollup's role here. Replaying
   a `REVOKE` before the matching script is updated leaves that consumer failing
   on its own timer cadence until it catches up — silently, if it only writes to
   a local log. The reverse order is safe, because a new script is written
   against both the old and the new grant set. See
   [the v3 → v4 Funnel monitor upgrade](../ingress-qube/README.md#funnel-monitor-host-side-not-compose)
   for a worked example.
6. Stop `mcp`, apply the migrations in ascending order, then run
   `db/03-grants-assertion.sql`. It must exit 0. It reads the completed catalog,
   so a partial migration or a widened role fails it loudly.
7. `docker compose build mcp && docker compose up -d --no-deps mcp`. Confirm the
   boot log names the schemas it found and the auth door you expect, then
   `/health`.
8. Verify from the outside — a real request through the public door, not only a
   local health check.

## Daily Funnel rollup and retention (host-side)

The access-log schema retains raw rows for 30 days and daily aggregates for one
year, but those policies are active only when
[`scripts/funnel_daily_summary.sh`](../../../scripts/funnel_daily_summary.sh)
runs. In this split topology Postgres is not in the app compose project, so the
shipped job uses the wrapper's explicit `postgres` backend: host `psql` connects
to the db qube as `openbrain_app`, the existing role whose observability grants
cover the transactional rollup and retention deletes. The internet-adjacent
ingress qube never receives that credential.

The job reads a dedicated environment file containing only its database
settings. Do not point it at this directory's `.env`: exporting the full app
environment would needlessly expose the database administrator, OAuth,
model-provider, and notification settings to the rollup process. The wrapper
refuses to source a symlink, a file owned by another user, or a file with any
group/other permissions; values in this file take precedence over inherited
environment values.

Fedora's `postgresql` package provides the host `psql` client; it is commonly
already present beside the `pg_dump` client used by the encrypted backup. If it
is absent, install the package in this qube's Fedora **template** and restart
the app qube—an AppVM-local package install disappears on reboot.

**Install on the app qube** as the regular user, from the repository checkout:

```sh
mkdir -p ~/.config/systemd/user
install -m 0755 scripts/funnel_daily_summary.sh ~/funnel_daily_summary.sh
install -m 0644 db/summarize_funnel.sql ~/summarize_funnel.sql
install -m 0600 deploy/qubes/app-qube/funnel-summary.env.example ~/.config/funnel-summary.env
$EDITOR ~/.config/funnel-summary.env       # set DB_HOST + OPENBRAIN_APP_PASSWORD
install -d -m 0700 ~/openbrain-funnel-summaries
install -m 0644 deploy/qubes/app-qube/funnel-summary.service ~/.config/systemd/user/
install -m 0644 deploy/qubes/app-qube/funnel-summary.timer   ~/.config/systemd/user/
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
```

Run the service once before enabling the schedule. This is the catch-up pass: it
builds the previous daily summaries before transactionally removing raw rows
beyond the retention horizon. That removal is irreversible, so take a database
snapshot first if you may need the pre-30-day raw rows. A failure before the SQL
transaction commits leaves the raw rows intact; any failed run leaves the last
complete Markdown artifact intact instead of replacing it with partial output.
If a connection fails after the database commit but while the report queries are
streaming, the database may be ahead of the artifact; the next idempotent run
regenerates the report. A multi-day catch-up stores every day in
`funnel_access_summary`, but publishes one Markdown artifact for the most
recently completed day rather than recreating a historical report file per day.

```sh
systemctl --user start funnel-summary.service
systemctl --user show funnel-summary.service -p Result -p ExecMainStatus
journalctl --user -u funnel-summary.service -n 50 --no-pager
ls -l ~/openbrain-funnel-summaries/

systemctl --user enable --now funnel-summary.timer
systemctl --user list-timers funnel-summary.timer --no-pager
```

The timer runs at 00:30 UTC, matching the SQL's UTC day boundaries.
`Persistent=true` causes one missed occurrence to run after a suspended app qube
wakes; the service makes up to two additional attempts at two-minute intervals
so a transient tailnet startup race does not consume that occurrence. User
lingering keeps the unit eligible when no shell is open. Reports default to the
local, mode-0700 `~/openbrain-funnel-summaries` directory because they contain
request metadata. To retain an off-box copy, set `SUMMARY_DIR` in
`~/.config/funnel-summary.env` to a trusted replicated directory and protect
that destination accordingly. For Syncthing, add `/.funnel-summary-*` to the
folder's `.stignore`; final reports have no leading dot, while an uncatchable
hard kill or qube crash can leave a private staging dotfile behind.

A user service cannot order itself after the system tailnet unit. The bounded
retries handle the common race, and later successful runs catch up idempotently,
but a persistent failure still needs a visible signal. Install a user
`notify-failure@.service` and uncomment the `OnFailure=` example in
`funnel-summary.service`, or monitor `systemctl --user --failed` and the unit
journal.

When updating the rollup implementation, reinstall **both** the wrapper and
`summarize_funnel.sql`, then manually start the service once and inspect its
journal before waiting for the next timer occurrence. When rotating
`OPENBRAIN_APP_PASSWORD`, update the mode-0600 summary env at the same time as
the app compose `.env` so the unattended job does not silently retain the old
credential.

## Host firewall (scope the `0.0.0.0:8787` bind)

The `0.0.0.0` bind is reachable on every interface (tailnet **and** LAN). Three
independent layers narrow it to the ingress qube — Tailscale ACL, this host
firewall, and mcp app auth. Install the firewall artifacts (counterpart to the
db qube's):

| File                                                       | Install at                                                                                                                       | Purpose                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`qubes-firewall-user-script`](qubes-firewall-user-script) | `/rw/config/qubes-firewall-user-script` (chmod +x)                                                                               | `DOCKER-USER` rule: accept `:8787` only from the ingress qube's tailnet IP, drop it on every other source/interface |
| [`docker-ob1-firewall.conf`](docker-ob1-firewall.conf)     | `/rw/config/docker-ob1-firewall.conf` (rc.local copies it to `/etc/systemd/system/docker.service.d/ob1-firewall.conf` each boot) | docker drop-in: re-runs the script `ExecStartPost` so a daemon restart can't leave `:8787` open                     |
| [`ob1-app-firewall.service`](ob1-app-firewall.service)     | `/rw/config/ob1-app-firewall.service`                                                                                            | boot one-shot that applies the rule once `After=tailscaled` + docker                                                |
| [`rc.local`](rc.local)                                     | `/rw/config/rc.local` (chmod +x)                                                                                                 | boot order: tailscaled → install docker drop-in → docker → firewall one-shot → backup timer                         |

The rule lives in `DOCKER-USER`, **not** the Qubes `custom-input` chain, because
docker's DNAT bypasses the qubes `INPUT` path — a `custom-input` accept/drop
never sees the published-port traffic. The script **inserts** (`-I`) above
docker's seeded `RETURN` rule (an appended rule would land below it and never
run) and rebuilds idempotently. Replace `<ingress-qube-tailnet-ip>` in the
script with the ingress qube's address; if you later **rotate** that address,
flush the chain and re-run
(`sudo iptables -F DOCKER-USER && sudo
/rw/config/qubes-firewall-user-script`)
so the old ACCEPT doesn't linger. Two triggers keep the rule live: the boot
one-shot applies it at startup, and the docker drop-in re-applies it on every
daemon restart. (This layer also closes the LAN-reachable-`0.0.0.0`-bind gap —
it drops `:8787` on all interfaces, not just `tailscale0`.)

## Encrypted DB backup

A daily job dumps the db qube (read-only role), GPG-encrypts to a public key
(this host holds **no** private key), and drops the artifact into an
off-box-replicated directory (Syncthing, rsync, …). Artifacts + units are in
[`backup/`](backup/); the design rationale is in
[`../encrypted-backup-example.md`](../encrypted-backup-example.md).

The canonical script gives every routine artifact a full UTC timestamp
(`db-YYYYMMDDTHHMMSSZ.sql.gz.gpg`). If two invocations select the same
timestamp, the later one receives `-2`, `-3`, and so on; publication atomically
refuses to replace any existing entry. The output filesystem must support hard
links (ordinary ext4/XFS/Btrfs directories do). If it does not, the script fails
closed instead of copying over a backup or exposing a partial final file.

Routine artifacts use `RETAIN_DAYS` (14 by default). A one-off `BACKUP_LABEL`
creates `db-labelled-<label>-<UTC timestamp>.sql.gz.gpg` and uses the longer
`LABEL_RETAIN_DAYS` horizon (90 by default). Labels are limited to 1–64 ASCII
letters, digits, dots, underscores, or hyphens and must start and end with a
letter or digit. Do not set `BACKUP_LABEL` permanently in `backup.env`; the
timer belongs in the routine namespace. Unknown hand-built filenames are
intentionally outside both automatic prune rules.

Before relying on this path in a deploy window, install the repository copy at
the exact path named by `ExecStart` and confirm no older parallel wrapper is
still being invoked:

```sh
install -m 0755 deploy/qubes/app-qube/backup/ob1-db-backup.sh \
  /rw/config/openbrain-units/ob1-db-backup.sh
cmp deploy/qubes/app-qube/backup/ob1-db-backup.sh \
  /rw/config/openbrain-units/ob1-db-backup.sh
systemctl cat ob1-db-backup.service
```

### Deploy-window rollback point

Run the canonical script as the backup service's unprivileged user before
applying a schema migration. Use a label that identifies the release or
migration, capture the printed final path, wait for off-box replication, and
verify/decrypt it on the separate restore host **before** changing the database:

```sh
sudo -u openbrain env BACKUP_LABEL=pre-1.20.0 \
  /rw/config/openbrain-units/ob1-db-backup.sh
```

After deployment, exercise the ordinary service and inspect both the journal and
output directory. This creates a distinct routine artifact; it cannot replace
the labelled pre-migration rollback point, even if both runs happen in the same
second.

```sh
sudo systemctl start ob1-db-backup.service
systemctl show ob1-db-backup.service -p Result -p ExecMainStatus
journalctl -u ob1-db-backup.service -n 50 --no-pager
```

## Verify

```sh
docker compose config --services      # exactly: mcp, ollama
docker compose up -d
# from the ingress qube, a Caddy request to MCP_UPSTREAM should reach mcp;
# from any OTHER tailnet peer, :8787 should be dropped by the host firewall.
```
