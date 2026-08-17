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
only, no override stack. `mcp` publishes on `127.0.0.1:8787` **only** — it has
no network-facing listener. The ingress qube's Caddy reaches it over a
dom0-policy-gated qubes.ConnectTCP channel; the forwarder, policy line, and
verification live in the
[ingress qube's README](../ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp).
The canonical Postgres is on the db qube, reached through this qube's **own**
ConnectTCP forwarder (`DB_HOST` = this qube's own IP) — install
[the app→db hop](#the-appdb-hop-qubesconnecttcp) below before expecting `mcp` to
come up healthy. Ollama runs CPU-only (no GPU passthrough in a Qubes app qube);
point `OLLAMA_URL` at an external GPU box to offload it.

The stack runs under the operator account's **rootless** dockerd (see the
[Qubes README § Rootless docker](../README.md#rootless-docker-the-deployed-engine-posture)),
which also answers reboot recovery: `loginctl enable-linger user` — persisted by
the `/var/lib/systemd/linger` bind-dir, without which the flag lasts exactly one
boot — makes the user manager start the rootless daemon at boot, and
`restart: unless-stopped` resumes the containers; no `rc.local` compose start,
no manual `up -d` after a reboot. Verify with `docker compose ps` after the qube
comes back, before any interactive login (a login starts the user manager and
masks a broken linger).

## The app→db hop (qubes.ConnectTCP)

Every DB client on this qube — mcp, the encrypted backup, the auth-events
rollup, admin psql — reaches the canonical Postgres through a small host-side
`socat` forwarder rather than a db-qube network address: the db qube's cluster
binds **loopback only** and has no network-facing listener at all (same pattern
as the ingress→app hop, one hop further down):

```
mcp container ──(this qube's own IP :5432)──▶ socat  [app qube host]
                     └─ qubes.ConnectTCP+5432 (qrexec) ─▶ <db-qube> 127.0.0.1:5432
```

The forwarder binds the qube's **own IP** (`qubesdb-read /qubes-ip`): under
rootless docker the mcp container reaches its own host via slirp4netns — the
packet arrives on `lo`, which the qubes input chain accepts, so no firewall rule
is needed — while eth0/tailscale peers are covered by the qubes input
default-drop (nothing accepts `:5432`). Host-side clients (backup, rollup, psql)
target the same address, so one `DB_HOST` value serves everything.

Install (the qube's **template** must have `socat`; `/usr` is template-provided,
so an AppVM-local install vanishes on reboot):

1. dom0 policy (validate with `qubes-policy-lint`; explicit destination, not
   `@default` — both gotchas in
   [`../gpu-offload-transport.md`](../gpu-offload-transport.md)):

   ```
   qubes.ConnectTCP +5432 <app-qube> <db-qube> allow autostart=no
   ```

   `autostart=no` matches this repo's other ConnectTCP rules: a stray connection
   must never boot a halted db qube as a side effect — start it deliberately.
   (The trade-off is real on this hop: with the flag, recovery from a down db
   qube is a manual `qvm-start`; without it, the first connection self-heals by
   booting the qube. Pick one knowingly.)

2. Stage [`ob1-db-forward.sh`](ob1-db-forward.sh) (chmod +x; edit its `DB_QUBE`
   name to match the policy line's destination) and
   [`ob1-db-forward.service`](ob1-db-forward.service) under `/rw/config/`; the
   shipped [`rc.local`](rc.local) restages + enables the unit each boot. For the
   current boot, also install + `systemctl enable --now` it by hand.

3. Set `DB_HOST=<this-qube-ip>` in `.env` — and in **every other** `DB_HOST`
   carrier: the backup job's env file and `~/.config/auth-events-summary.env`. A
   stale copy pointing at the old db-qube address fails only when that listener
   goes away, on the consumer's own timer cadence.

The db-qube side needs no transport install — `qubes.ConnectTCP` is a stock
qrexec service that connects to `127.0.0.1:5432` on the target; its `pg_hba`
must carry the loopback scram lines
([`../db-qube/pg_hba.snippet.conf`](../db-qube/pg_hba.snippet.conf)). Migrating
a live install off the old firewall-scoped tailnet listener is a phased
checklist:
[`../db-qube/README.md` § Migrating an existing install to ConnectTCP](../db-qube/README.md#migrating-an-existing-install-to-connecttcp).

Verify from this qube's host: `pg_isready -h <this-qube-ip> -p 5432` answers
"accepting connections" (that traverses socat → qrexec → the db qube's
loopback), and an authenticated
`psql -h <this-qube-ip> -U openbrain_app -d openbrain -c 'select 1;'` completes.

## Offloading metadata classification (`CHAT_*`) to a GPU qube

The `mcp` server's optional metadata extractor (`CHAT_API_BASE`) calls an
OpenAI-compatible `/chat/completions` endpoint — any server that also supports
the strict `json_schema` response format it sends — so it routes with equal ease
to another machine on your network running a local LLM, or (with `CHAT_API_KEY`)
to a hosted OpenAI-compatible provider; neither needs plumbing. To instead keep
thought content on a **GPU qube on this same Qubes host** whose model server is
bound to loopback only (no network-facing listener — no LAN/tailnet bind, no
sshd), see [`../gpu-offload-transport.md`](../gpu-offload-transport.md): a
host-side `socat` forwarder (bound to this qube's own IP) + qrexec `ConnectTCP`
transport, with the persistence and `autostart=no` safety notes. It is a
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
**administer the db qube remotely** through the same
[ConnectTCP channel](#the-appdb-hop-qubesconnecttcp) every other DB client here
uses — role provisioning + schema/migrations. The db qube's `pg_hba` grants the
superuser a **loopback** host line, reachable only through the channel dom0
policy grants to this qube — a deliberate trade-off (a compromised app qube then
has full DB admin — including `COPY … TO/FROM PROGRAM`, i.e. an app→db OS pivot
— not just the app role; accepted for now since this compartment runs the memory
application and the db qube is highly contained (the runtime app role itself is
still restricted by memory-space RLS) — see
[`../db-qube/README.md`](../db-qube/README.md) and
[#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15)). At runtime the
app qube also connects as `openbrain_app` (mcp writes thoughts; the
[daily rollup](#daily-auth-event-rollup-and-retention-host-side) summarizes and
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

Server 1.20.0 requires a re-apply of `db/02-observability.sql` (it now converges
`mcp_auth_events` in place to the allowed+denied audit shape) AND
`OAUTH_ALLOWED_SUBJECTS` in this qube's `.env` **before the container roll**:
the allowlist fails closed, so rolling the container without it leaves the
OAuth-only deployment rejecting every Bearer — a deliberate lockout posture,
loudly warned in the boot log, but not what an upgrade intends. Set it to the
exact `sub` claim(s) to admit (Auth0 dashboard → User Management → Users →
user_id), then roll, then verify a live client and check `mcp_auth_events` for
the new `outcome='allowed'` rows.

## Upgrading an existing deployment

`db/*.sql` are `docker-entrypoint-initdb.d` scripts: PostgreSQL runs them only
on a fresh data directory. On an existing database they never rerun, so neither
a new migration nor a tightened grant reaches a running deployment by itself.
Apply them by hand, in order, during an operator window.

The per-migration recipes under [`docs/`](../../../docs/) assume the single-box
compose install and `docker compose exec -T postgres`. **In this split topology
that command has nothing to exec into** — Postgres is not in the app compose
project. Run the same files from this qube's repository checkout, through this
qube's [ConnectTCP forwarder](#the-appdb-hop-qubesconnecttcp) (`DB_HOST`), as
the database superuser:

```sh
(
  cd deploy/qubes/app-qube || exit
  . ./.env || exit
  : "${DB_HOST:?set DB_HOST in .env}"
  : "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}"
  env -i PATH="$PATH" PGPASSWORD="$POSTGRES_PASSWORD" \
    psql -w -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "${POSTGRES_USER:-postgres}" \
      -d "${POSTGRES_DB:-openbrain}" -v ON_ERROR_STOP=1 \
      -f ../../../db/08-access-tokens.sql
)
```

Run it from the top of the checkout. The example applies migration 08 —
substitute the file named by the row you are moving to, and apply several in
ascending order, one invocation each.

Every step is inside the subshell, and each one that can fail stops it. An
unguarded `cd` is the interesting case: on failure the shell simply continues in
the caller's directory, so a stray `.env` there would be sourced instead and the
run would target whatever database _that_ file names — reporting success.
`env -i` cannot help, because those values arrive as arguments rather than
environment. Keep `|| exit` **inside** the parentheses: hoisted out, it would
close the operator's interactive shell rather than abandon the recipe. Nothing
here changes the caller's directory or environment.

Source without `set -a`, keep it in a subshell, and build the client's
environment rather than handing it the shell's. `env -i` starts `psql` from
empty, so the only values it can see are the two named on that line — every
`$DB_HOST`-style expansion happens in the parent shell before `env` runs, so the
arguments are unaffected. The app and read-only role passwords, the model API
keys, and the notification credentials never reach the client process, and
nothing survives in the operator's shell once the subshell returns. This is the
rule the backup job states in
[`backup/backup.env.example`](backup/backup.env.example): only what the client
needs reaches the client.

The guards carry as much weight as the scoping. A failed `. ./.env` does not
stop a subshell by itself: without `|| exit` the recipe runs on to `psql` with
an empty host and database, where libpq falls back to a local socket and can
exit 0 having touched something other than the intended remote target. `:?`
rejects an unset or empty required value before any connection is attempted, and
`-w` keeps a missing password from becoming an interactive prompt.

Two limits are worth stating rather than papering over. `env -i` makes the
scoping hold however `.env` was written — an `export`-prefixed line no longer
reaches the client — but the file is still _sourced_, so a value containing
shell metacharacters is evaluated when it is read, well before `psql` is
reached. Keep `.env` to the plain `KEY=value` lines `.env.example` ships;
nothing here defends a file that has stopped being one. And because the client
now starts from an empty environment, a deployment that depends on additional
libpq variables — `PGSSLMODE`, say — must name them on the `env -i` line, since
they are no longer inherited.

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

Rows start at 1.7.0. `db/01-schema.sql` and `db/04-sessions.sql` have no upgrade
row of their own; a database predating either needs it applied first, in that
order (`db/02-observability.sql` gained an upgrade row at 1.20.0 — older
databases still apply it in its numbered position first).
`db/03-grants-assertion.sql` is deliberately not third — it is a read-only
**superuser** check of the completed catalog (HBA inspection requires that
privilege), so it runs after every pending row below and fails by design if run
before the relations it asserts on exist. The db qube records the same canonical
order
([First boot / provisioning](../db-qube/README.md#first-boot--provisioning)).

| Server | Migration                                                                  | Additional requirement                                                                                                                       |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.7.0  | `db/05-hybrid-search.sql`                                                  | pgvector 0.8.0+ (filtered iterative scans)                                                                                                   |
| 1.9.0  | `db/06-spaces.sql`                                                         | PostgreSQL 15+ (`NULLS NOT DISTINCT`); superuser, not owner                                                                                  |
| 1.16.0 | `db/07-metadata-degradation.sql`                                           | from 1.17.0, an explicit `METADATA_FALLBACK_POLICY` in `.env`                                                                                |
| 1.19.0 | `db/08-access-tokens.sql`                                                  | —                                                                                                                                            |
| 1.20.0 | `db/02-observability.sql` (re-apply; converges `mcp_auth_events` in place) | `OAUTH_ALLOWED_SUBJECTS` in `.env` **before** the container roll — fail-closed                                                               |
| Arc B  | `db/02-observability.sql`, then `db/09-retire-corpus-funnel.sql`           | sink cutover complete; both legacy tables archived, verified, and empty; retired HBA rules removed                                           |
| 1.22.0 | `db/10-thought-mutations.sql`                                              | superuser (table-owner SECURITY DEFINER helper; narrows the app's thoughts UPDATE to content columns); rerun `03-grants-assertion.sql` after |

Migration 08 is required by 1.19.0 **even when native tokens are disabled**.
`ENABLE_NATIVE_TOKENS` gates the credential door, not the schema: the server's
boot probe refuses to start without `native_auth`, so applying it _after_ the
container roll takes the deployment down rather than leaving it on the old
version. Apply migrations before the roll, not with it.

### Window order

1. Take the labelled pre-migration rollback point and verify it off-box —
   [Deploy-window rollback point](#deploy-window-rollback-point).
2. Tag the running image so a rollback needs no rebuild. Resolve it through the
   Compose service instead of reconstructing the project-prefixed image name:

   ```bash
   mcp_image="$(docker compose images -q mcp)"
   if [[ -z "$mcp_image" || "$mcp_image" == *$'\n'* ]]; then
     echo "expected exactly one current mcp image" >&2
     exit 1
   fi
   docker tag "$mcp_image" "openbrain-mcp:rollback-<previous-commit>"
   ```

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

## Daily auth-event rollup and retention (host-side)

The corpus auth-event horizons are active only when
[`scripts/funnel_daily_summary.sh`](../../../scripts/funnel_daily_summary.sh)
runs. In this split topology Postgres is not in the app compose project, so the
shipped job uses the wrapper's explicit `postgres` backend: host `psql` connects
to the db qube through the
[ConnectTCP forwarder](#the-appdb-hop-qubesconnecttcp) (`DB_HOST` = this qube's
own IP) as `openbrain_app`, the existing role whose corpus grants cover the
auth-event report and retention deletes. The internet-adjacent ingress qube
never receives that credential.

**This qube runs only the `mcp_auth_events` half.** The rollup is split by
owning table, because the two halves no longer share a database: the Funnel
access log is written to a local sink on the
[ingress qube](../ingress-qube/README.md#daily-rollup-and-retention-host-side-not-compose),
which runs [`db/summarize_funnel.sql`](../../../db/summarize_funnel.sql) there.
Here, [`db/summarize_auth_events.sql`](../../../db/summarize_auth_events.sql)
handles the auth-decision audit mcp writes into the corpus — reason-coded
denials plus the per-request admission rows (1.20.0+). `SUMMARY_TARGET=corpus`
pins the wrapper to that SQL file, `openbrain_app`, the corpus database, and a
non-socket host; the retired free-form role/SQL knobs fail closed. The ingress
job uses `SUMMARY_TARGET=sink` and the opposite tuple.

Arc B removes the old Funnel tables and roles from this cluster entirely. For an
existing deployment, follow
[db-qube/README.md § Retiring the ingress qube's old access](../db-qube/README.md#retiring-the-ingress-qubes-old-access-existing-installs):
export and verify both legacy tables, explicitly empty them, remove the old HBA
rules, then apply `db/09-retire-corpus-funnel.sql`. The migration refuses
nonempty tables or stale HBA rules and rolls back on an unexpected dependency;
the final grants assertion rejects any old-shape relation or role that
reappears.

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

If the pre-Arc-B `funnel-summary.*` app-qube unit exists, disable its timer
first. Install and verify the renamed auth-event unit before deleting the old
unit files; never leave both timers enabled against the same corpus.

```sh
systemctl --user disable --now funnel-summary.timer 2>/dev/null || true
mkdir -p ~/.config/systemd/user
install -m 0755 scripts/funnel_daily_summary.sh ~/funnel_daily_summary.sh
install -m 0644 db/summarize_auth_events.sql ~/summarize_auth_events.sql
install -m 0600 deploy/qubes/app-qube/auth-events-summary.env.example ~/.config/auth-events-summary.env
$EDITOR ~/.config/auth-events-summary.env  # set DB_HOST + OPENBRAIN_APP_PASSWORD
install -d -m 0700 ~/openbrain-funnel-summaries
install -m 0644 deploy/qubes/app-qube/auth-events-summary.service ~/.config/systemd/user/
install -m 0644 deploy/qubes/app-qube/auth-events-summary.timer   ~/.config/systemd/user/
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
```

After the new service passes its manual run, remove the obsolete app-qube
`~/.config/systemd/user/funnel-summary.{service,timer}` and
`~/.config/funnel-summary.env`, then run `systemctl --user daemon-reload` once
more. The ingress qube intentionally keeps its own `funnel-summary.*` names.

Run the service once before enabling the schedule. This is the catch-up pass:
for this qube's auth half it enforces `mcp_auth_events`' per-class horizons — 30
days for anonymous denials, 365 for admission rows and `subject_not_allowed`
denials (the identity-carrying classes) — and prints the rolling 24h
auth-failure and admitted-identities reports. The removals are irreversible, so
take a database snapshot first if you may need the older rows. The two retention
DELETEs autocommit independently (no shared transaction): a failure between them
leaves each class individually consistent, and the next idempotent run converges
whichever half lagged; any failed run leaves the last complete Markdown artifact
intact instead of replacing it with partial output. If a connection fails after
the database commit but while the report queries are streaming, the database may
be ahead of the artifact; the next idempotent run regenerates the report.

```sh
systemctl --user start auth-events-summary.service
systemctl --user show auth-events-summary.service -p Result -p ExecMainStatus
journalctl --user -u auth-events-summary.service -n 50 --no-pager
ls -l ~/openbrain-funnel-summaries/

systemctl --user enable --now auth-events-summary.timer
systemctl --user list-timers auth-events-summary.timer --no-pager
```

The timer runs at 00:30 UTC, matching the SQL's UTC day boundaries. An active
`OnCalendar=` timer fires a slept-through occurrence late when a suspended app
qube wakes, and `Persistent=true` extends that across a reboot (this is a user
timer, so its stamp lives in the persistent home — unlike the system backup
timer, see
[§ Missed runs](#missed-runs-what-the-timer-catches-up-and-what-it-cannot-see));
the service makes up to two additional attempts at two-minute intervals so a
transient tailnet startup race does not consume that occurrence. User lingering
keeps the unit eligible when no shell is open. Reports default to the local,
mode-0700 `~/openbrain-funnel-summaries` directory because they contain verified
identity metadata. To retain an off-box copy, set `SUMMARY_DIR` in
`~/.config/auth-events-summary.env` to a trusted replicated directory and
protect that destination accordingly. For Syncthing, add
`/.auth-events-summary-*` to the folder's `.stignore`; final reports have no
leading dot, while an uncatchable hard kill or qube crash can leave a private
staging dotfile behind.

A user service cannot order itself after the system tailnet unit. The bounded
retries handle the common race, and later successful runs catch up idempotently,
but a persistent failure still needs a visible signal. Install a user
`notify-failure@.service` and uncomment the `OnFailure=` example in
`auth-events-summary.service`, or monitor `systemctl --user --failed` and the
unit journal.

When updating the rollup implementation, reinstall **both** the wrapper and
`summarize_auth_events.sql` (this qube's half), then manually start the service
once and inspect its journal before waiting for the next timer occurrence. When
rotating `OPENBRAIN_APP_PASSWORD`, update the mode-0600 summary env at the same
time as the app compose `.env` so the unattended job does not silently retain
the old credential.

## Host firewall (custom-input; no `:8787` machinery)

mcp publishes loopback only, so there is **no mcp listener to scope** — the
elaborate `DOCKER-USER` machinery an earlier revision shipped (an iptables
insert script, a `docker.service` drop-in re-applying it on daemon restarts, and
a boot one-shot ordered after docker) is retired along with the `0.0.0.0:8787`
publish it existed to narrow. What remains is small:

| File                                                       | Install at                                         | Purpose                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`qubes-firewall-user-script`](qubes-firewall-user-script) | `/rw/config/qubes-firewall-user-script` (chmod +x) | `custom-input` accepts for host services (SSH on `tailscale0`; optional Syncthing)          |
| [`ob1-app-firewall.service`](ob1-app-firewall.service)     | `/rw/config/ob1-app-firewall.service`              | one-shot that runs the script `After=tailscaled` — the applier on this qube (see below)     |
| [`rc.local`](rc.local)                                     | `/rw/config/rc.local` (chmod +x)                   | boot order: tailscaled → rootful-docker-off → firewall one-shot → backup timer → forwarders |

Two properties do the work the old machinery did:

- **The qubes input chain default-drops.** Nothing accepts `:8787` (or the
  forwarders' `:5432`/`:11434`) from `eth0`/`tailscale0` — a third qube's probe
  times out at that drop — and mcp has no socket there anyway, so even a packet
  the firewall let through would find nothing listening (`ss -tlnp` is the check
  that proves the socket claim; see Verify). What changed vs the old design is
  not that a firewall stopped mattering, but that reachability no longer depends
  on _mutable, docker-managed_ firewall state — the static input default-drop
  needs no re-assertion machinery.
- **Container→host traffic arrives on `lo` under rootless docker** (slirp4netns
  delivers a container's packet to its own host's IP on loopback, which the
  stock chain accepts) — so the forwarder transports need no `custom-input`
  accepts either, and the old `br-*` bridge rules are gone (the compose bridge
  now lives inside rootlesskit's netns, invisible to the host chain).

One Qubes-ism to know: on an app qube that doesn't route other qubes, the
`qubes-firewall` service's own hook never fires, so `qubes-firewall-user-script`
would sit unexecuted. The shipped `ob1-app-firewall.service` one-shot
(restaged + enabled from `rc.local` each boot) is what actually applies it,
ordered after tailscaled so the `tailscale0`-scoped accepts land on the running
interface.

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

### Missed runs: what the timer catches up, and what it cannot see

A 03:30 occurrence slept through by a suspended qube fires late on wake — that
is the active `OnCalendar=` timer's own doing, no stamp involved. Across a qube
**reboot** the timer unit was inactive, and only `Persistent=true` can catch up:
it compares the calendar against a stamp file, and that stamp lives on the
volatile root unless `/var/lib/systemd/timers` is bind-dir'd (see
[`../README.md` § Bind-dirs](../README.md#bind-dirs-what-must-persist)). Without
the bind-dir, after a host power-off or `qvm-shutdown` the timer starts with an
empty stamp, schedules tomorrow's run, and quietly drops today's. Nothing fails,
so the `OnFailure=` notifier stays silent. The tell is `LAST -` in
`systemctl list-timers ob1-db-backup.timer` on a boot that should have caught
up. With the bind-dir, the catch-up is dispatched as soon as `rc.local` enables
the timer (plus `RandomizedDelaySec`); the forwarder gate there only proves the
local listener, not the db qube, so a cold boot of both qubes can race — the
catch-up then fails once, loudly, and consumes the occurrence. To close either
kind of gap by hand, start the service (above) rather than invoking the script
directly, so the run keeps the unit's sandbox and its failure hook.

Because `OnFailure=` can only ever report "ran and failed", pair it with a
freshness check on the **receiving** host — the one place that can see "never
ran". A cron/launchd job on the private-key host that alerts when the newest
`db-*.sql.gz.gpg` in the replicated folder is older than about 26 hours (24 h
cadence + `RandomizedDelaySec` + replication lag) turns a silent gap into a
signal, whichever hop swallowed the artifact. For a host that routinely sleeps
across 03:30 and catches up on wake, add the longest sleep you consider normal
to that window (or run the check once a day, after the expected catch-up), so
the ordinary case does not alarm:

```sh
# on the receiving host, e.g. hourly
newest=$(ls -t "$RECV_DIR"/db-*.sql.gz.gpg 2>/dev/null | head -1)
[ -n "$newest" ] && [ $(( $(date +%s) - $(stat -c %Y "$newest") )) -lt $((26*3600)) ] \
  || your-alert "no fresh encrypted DB backup in $RECV_DIR"
```

(On macOS use `stat -f %m`.)

## Verify

```sh
docker compose config --services      # exactly: mcp, ollama
docker compose up -d
ss -tlnp | grep 8787                  # 127.0.0.1:8787 ONLY — no 0.0.0.0, no tailnet IP
ss -tlnp | grep 5432                  # <this-qube-ip>:5432 — the db forwarder (socat), nothing else
pg_isready -h <this-qube-ip> -p 5432  # "accepting connections" — via qrexec to the db qube
# from the ingress qube, a Caddy request through the ConnectTCP forwarder
# reaches mcp; from any OTHER qube or tailnet peer, a connect to this qube's
# :8787 or :5432 times out (the qubes input default-drop — the ss lines above
# are what prove no wider listener exists behind it).
```
