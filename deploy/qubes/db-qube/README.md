# DB qube — provisioning artifacts

The [three-qube design](../three-qube-design.md) pulls Postgres out of compose
into a dedicated **database qube**: a minimal Debian-templated AppVM running
Postgres + pgvector natively, **bound to loopback only** — no network-facing
listener at all — and reachable by exactly **one** peer: the app qube (superuser
for remote admin, plus the app and readonly roles), over a dom0-policy-gated
qubes.ConnectTCP channel
([app-qube README § The app→db hop](../app-qube/README.md#the-appdb-hop-qubesconnecttcp)).
The ingress qube is deliberately not a peer — no qrexec rule, no credential — it
writes Funnel logs to a local sink of its own; see the
[design doc](../three-qube-design.md). This directory holds the on-disk config
that makes that qube reproducible — the counterpart to the compose files for the
other install paths.

These are **placeholders**, not drop-in secrets. Adjust the Postgres major
version to match your template before using them (the old address placeholders
are gone: nothing here needs a tailnet or peer IP any more).

## What each file is, and where it goes on the DB qube

Everything durable lives under `/rw` (a stock AppVM wipes `/etc/systemd/system`
and most of `/etc` on every reboot), and is re-installed at boot by `rc.local`.

| File here                        | Install at                                         | Purpose                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qubes-bind-dirs.d/50_user.conf` | `/rw/config/qubes-bind-dirs.d/50_user.conf`        | Persist PGDATA, the cluster config, and the Tailscale identity across reboots                                                                                                                                                                                                                                                            |
| `rc.local`                       | `/rw/config/rc.local` (chmod +x)                   | Boot: start tailscaled (optional — node kept with zero inbound grants) → start Postgres (no interface wait; the cluster binds loopback only)                                                                                                                                                                                             |
| `pg_hba.snippet.conf`            | append to `/etc/postgresql/<ver>/main/pg_hba.conf` | scram **loopback** lines: superuser (remote admin) + app + readonly — every remote caller arrives on loopback via ConnectTCP. No line for the ingress qube — existing installs must also REMOVE the retired ingress and tailnet lines, see [§ Migrating an existing install to ConnectTCP](#migrating-an-existing-install-to-connecttcp) |
| `postgresql.local.conf`          | `conf.d/` drop-in or `ALTER SYSTEM`                | `listen_addresses = 'localhost'` and `ssl = off`                                                                                                                                                                                                                                                                                         |

The `qubes-firewall-user-script` (the `tailscale0:5432` accept) and
`ob1-db-firewall.service` (its post-tailscaled applier) that earlier versions of
this directory shipped are **gone**: with a loopback-only cluster there is no
inbound rule to apply. Existing installs remove them in the
[migration pass](#migrating-an-existing-install-to-connecttcp).

## Placeholders to fill

- Postgres major version (`17` in the paths/commands) — match your template.

## The trust layers (why this is shaped the way it is)

Reachability is enforced in independent layers, so no single misconfiguration
exposes the database:

1. **No listener** — `listen_addresses = 'localhost'`: the cluster has no socket
   on any network interface. There is nothing for a tailnet or LAN peer to
   connect to, whatever the firewall or ACL state — `ss -ntlp` showing only
   `127.0.0.1`/`::1` on `:5432` is the check.
2. **dom0 qrexec policy** — the only remote path in is
   `qubes.ConnectTCP +5432 <app-qube> <db-qube> allow autostart=no`, enforced by
   dom0 per **source qube**. Only the app qube can open the channel; the ingress
   qube deliberately has no rule. This layer replaces the old Tailscale-ACL +
   nftables source scoping — it is enforced below anything a compromised peer
   qube can reach.
3. **`pg_hba.conf`** — `scram-sha-256` on the loopback lines: the app and
   readonly roles scoped to the `openbrain` database, and the **superuser** (for
   remote DB admin — see the trade-off note below). pg_hba can no longer tell
   callers apart by source (everything arrives as loopback); it keeps the
   role/database scoping and the password gate — **provided the stock broad
   `host all all` loopback lines are removed**: first match wins, and left in
   place they shadow the scoped lines entirely (the snippet's header and the
   migration checklist both carry the removal + the prove-by-attempt probe).

**Superuser remote-admin trade-off.** The superuser (`postgres`) is reachable
through the **app qube's ConnectTCP channel only**, so role provisioning +
schema migrations can be driven from the app qube (in addition to running them
locally on this qube). This is **more than a data-access delta**: a reachable
superuser can `COPY … TO/FROM PROGRAM` (run commands **as the `postgres` OS user
on this qube**), `DROP`/alter structures, and read password hashes from
`pg_authid` — so a compromised app qube could **pivot into this qube's OS**, the
very VM boundary the three-qube split exists to enforce. Accepted for now
because (a) the app compartment legitimately runs the memory service (though its
runtime role remains constrained by memory-space RLS), and (b) this db qube is
deliberately contained — a minimal template, no sshd, no network listener,
nothing of value beyond the store it already holds. Hardening to a non-superuser
migration role — which closes the _pivot_, not just the data delta — is tracked
in [#15](https://github.com/lcjanke2020/ob1-selfhosted/issues/15). To revert to
local-only admin, drop the `postgres` loopback lines from `pg_hba.snippet.conf`
(the `local … peer` socket path remains).

No `tcp/22` is opened: there is no sshd on the DB qube. OS-level administration
is done from dom0 with `qvm-run`; DB-level administration is done either there
(over the local socket) or remotely from the app qube through the ConnectTCP
channel (the superuser remote-admin lines above).

## Boot ordering

There is no ordering constraint left: the cluster binds loopback only, so it no
longer waits on `tailscale0`. `rc.local` starts `tailscaled` (the node is kept
on the tailnet with zero inbound grants; drop that block if you retire the node)
and then starts the cluster unconditionally. Boot output (and the
`pg_ctlcluster` exit status) lands in `/var/log/ob1-db-boot.log`.

### Disable the cluster's boot auto-start (required)

Debian creates new clusters with `start.conf = auto`, and this runbook's
`rc.local` is the single intended start path — so set the cluster to `manual`
once, before the first boot with this `rc.local` in place:

```
# /etc/postgresql/17/main/start.conf
manual
```

`manual` still allows `pg_ctlcluster 17 main start` (what `rc.local` runs); it
only suppresses the boot auto-start. The file lives under `/etc/postgresql`, so
the bind-dir persists it across reboots; when changing it on a live system, also
run `systemctl daemon-reload` so postgresql-common's systemd generator re-reads
it for the next boot.

The original reason for the manual path — losing the race against an auto-start
that could not yet bind the tailnet IP — is gone with the loopback-only bind;
what it preserves now is **one** explicit, logged start branch instead of two
racing ones. If you prefer the stock auto-start, set `start.conf` back to `auto`
and delete the `rc.local` start block — pick one, not both. Left at `auto` by
accident, the stock service wins the race and `rc.local`'s start returns
"already running" (`pg_ctlcluster` exit 2) — `rc.local` reports that accurately
as a running cluster with a pointer to this section, not as a failure, so the
boot stays honest either way.

## First boot / provisioning

These artifacts configure the cluster's _plumbing_; they don't create the
database, roles, or extension. On a fresh DB qube, once the cluster is up, run
the same SQL the compose path runs from `docker-entrypoint-initdb.d` — the
canonical definitions live in [`db/`](../../../db/) (`00-roles.sh`,
`01-schema.sql`, …). Note `00-roles.sh` is shaped as a container
init-entrypoint: it runs under the postgres Docker entrypoint and reads the
`OPENBRAIN_*_PASSWORD` env vars, so on a native cluster don't run it as-is —
export those vars first and pick Pattern A vs B, or apply the equivalent
statements by hand. In broad strokes, once per cluster:

```bash
# as the postgres superuser, over the loopback socket:
sudo -u postgres psql -c "CREATE DATABASE openbrain;"
sudo -u postgres psql -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
# then create the openbrain_app / openbrain_readonly / openbrain_token_admin
# roles — see db/00-roles.sh for the exact, up-to-date statements (Pattern A vs
# B, passwords, grants; token admin may remain NOLOGIN). The optional ingester
# and monitor roles belong on the ingress qube's LOCAL log sink, not here (see
# db/log-sink/) — skip them unless you are running the single-app-qube on-ramp
# with no separate ingress qube. Apply the SQL files in this order:
#   db/01-schema.sql
#   db/02-observability.sql
#   db/04-sessions.sql
#   db/05-hybrid-search.sql
#   db/06-spaces.sql
#   db/07-metadata-degradation.sql
#   db/08-access-tokens.sql
#   db/03-grants-assertion.sql  # always last
```

Do not load `db/*.sql` in filename order: `03-grants-assertion.sql` is a
read-only completed-catalog check, not the third schema migration. Run it last
during native provisioning, and rerun it after every later schema migration so
new relations are covered by the monitor allowlist invariant.

Apply `pg_hba.snippet.conf` and `postgresql.local.conf` after the roles exist —
including the snippet header's removal of the stock broad loopback lines (first
match wins) — then reload/restart so the loopback-only bind and the scoped host
lines take effect, and run the snippet's prove-by-attempt probe.

Once the superuser loopback line is in place (and the app qube's forwarder +
dom0 policy are installed —
[app-qube README § The app→db hop](../app-qube/README.md#the-appdb-hop-qubesconnecttcp)),
you can also run this provisioning (and later migrations) **remotely from the
app qube** through the ConnectTCP channel instead of on this qube — e.g.
`PGPASSWORD=… psql -h <app-qube-ip> -U postgres -d postgres` (the app qube's own
IP, where the forwarder listens) — which is the point of the superuser
remote-admin lines above.

Filtered provenance search requires pgvector `0.8.0` or newer. Before updating
an existing deployment, run
`SELECT extversion FROM pg_extension WHERE extname = 'vector';` in `openbrain`.
If the result is older, first install a pgvector package that provides `0.8.0`
or newer, run `ALTER EXTENSION vector UPDATE;` as the database owner, and verify
the version again before restarting the app-side MCP service.

Hybrid thought search additionally requires the idempotent
[`db/05-hybrid-search.sql`](../../../db/05-hybrid-search.sql) migration. Apply
it as the database owner from this qube's local socket or the existing
tailnet-restricted remote-admin path _before_ updating the MCP service. Adding
the stored `content_tsv` column backfills existing thoughts under an
access-exclusive lock that is held through both regular GIN index builds until
commit, blocking searches and captures for the migration's duration. Use a full
application maintenance window on a large corpus and budget disk for the column
plus both indexes. The updated app-side server refuses to boot until both
indexes exist. The migration also installs `pg_trgm`; the native Postgres
package must include that contrib extension. See
[Hybrid thought search](../../../docs/hybrid-search.md) for the full contract.

After hybrid search, apply the idempotent
[`db/06-spaces.sql`](../../../db/06-spaces.sql) migration in the same
maintenance window and run `db/03-grants-assertion.sql` last. Spaces requires
PostgreSQL 15 or newer and a PostgreSQL superuser (the documented local or
tailnet-restricted `postgres` path). It backfills legacy rows into the `default`
workspace, rebuilds audience-aware fingerprint uniqueness, and forces RLS on
thoughts, sessions, and artifacts. Reapplication rebuilds that fingerprint index
too, so it needs the same table-lock window and index headroom. It must land
before the scoped app server starts; the server boot probe refuses a partial
catalog. See [Memory spaces](../../../docs/spaces.md).

Next, apply
[`db/07-metadata-degradation.sql`](../../../db/07-metadata-degradation.sql) as
the database owner. It adds the append-only, content-free
metadata-classification audit, transactional outbox, and singleton notification
ledger without rewriting `thoughts`. Server 1.16.0 refuses to start until all
three relations and the seeded ledger row exist. Audit queries and the optional
Pushover/ntfy worker are documented in
[Metadata degradation monitoring](../../../docs/metadata-degradation-monitoring.md).

Then apply [`db/08-access-tokens.sql`](../../../db/08-access-tokens.sql) as the
database owner, then run `db/03-grants-assertion.sql` last. The server catalog
probe requires this schema, but the Qubes app remains OAuth-only: it does not
enable native token verification, and the dedicated administrator role can stay
`NOLOGIN`. See
[Native access tokens](../../../docs/native-access-tokens.md#existing-database-upgrade).

## Migrating an existing install to ConnectTCP

A deployment built from the earlier version of this directory has Postgres bound
to `localhost,<tailnet-ip>` behind the three-layer ACL + nftables +
`pg_hba`-source scoping. The cutover to the loopback-only ConnectTCP shape is
two phases — **build the new path first, tear the old one down second** — so the
tailnet path stays live as a fallback until the new one is verified.

**Phase 1 — bring up the ConnectTCP path (old path still live):**

1. **dom0 policy**: append
   `qubes.ConnectTCP +5432 <app-qube> <db-qube> allow autostart=no` to your
   policy file (e.g. `/etc/qubes/policy.d/30-ob1-connecttcp.policy`), then
   validate with `qubes-policy-lint` — the destination must be explicit, not
   `@default` (see [`../gpu-offload-transport.md`](../gpu-offload-transport.md)
   for both gotchas).
2. **This qube — pg_hba**: append the loopback lines from
   [`pg_hba.snippet.conf`](pg_hba.snippet.conf) and **remove the stock broad
   loopback lines** (`host all all 127.0.0.1/32` + `host all all ::1/128`) —
   first match wins, and left in place they shadow the appended role/database
   scoping entirely (keep the old tailnet `/32` lines for now). Reload
   (`sudo -u postgres psql -Atc 'select pg_reload_conf();'`), confirm
   `select count(*) from pg_hba_file_rules where error is not null;` prints `0`,
   and prove the effective **ordering** by attempt — the syntax check cannot see
   shadowing: on this qube, `psql -h 127.0.0.1 -U openbrain_app -d postgres`
   must FAIL with "no pg_hba.conf entry" while the same command with
   `-d openbrain` authenticates.
3. **App qube — forwarder**: install
   [`../app-qube/ob1-db-forward.sh`](../app-qube/ob1-db-forward.sh) +
   [`.service`](../app-qube/ob1-db-forward.service) under `/rw/config/` with the
   rc.local restage block, enable it, and verify
   `pg_isready -h <app-qube-ip> -p 5432` answers "accepting connections" — that
   exercises the full forwarder → qrexec → loopback chain.
4. **App qube — repoint every DB client**: set `DB_HOST=<app-qube-ip>` in the
   compose `.env` and recreate `mcp`, and update **every other file that carries
   a `DB_HOST`** — the backup job's env and the rollup's
   `~/.config/funnel-summary.env` are the easy ones to miss; a stale copy keeps
   working over the tailnet until phase 2 silently breaks it. Then verify end to
   end: a capture (pgvector write), a hybrid-search read, and a manual backup
   run.

**Phase 2 — retire the tailnet path (only after phase 1 verifies):**

5. **Capture your tailnet ACL as deployed** (from the admin console, not a
   possibly-stale local copy) somewhere durable **before removing anything** —
   post-teardown rollback means editing Tailscale policy, and reconstructing it
   from memory during an outage is the failure mode.
6. **This qube**: set `listen_addresses = 'localhost'` (via `ALTER SYSTEM` or
   the `conf.d` drop-in — match how you set it originally); remove the three
   app-qube tailnet `/32` lines from `pg_hba.conf` (dated backup first); delete
   the live `tailscale0:5432` nft accepts in **both families** — find the
   handles with `nft -a list chain ip qubes custom-input` **and**
   `nft -a list chain ip6 qubes custom-input`, then
   `nft delete rule <family> qubes custom-input handle <n>` for each; remove the
   accept from `/rw/config/qubes-firewall-user-script` and retire
   `ob1-db-firewall.service`; replace `rc.local` with the current shipped
   version (no interface wait). Restart the cluster and confirm `ss -ntlp` shows
   loopback-only `:5432`.
7. **Reboot this qube once** and re-verify: cluster online, loopback-only
   listeners, no `:5432` accept in `nft list chain ip qubes custom-input` **or**
   `nft list chain ip6 qubes custom-input`, and the app's clients reconnect
   cleanly (pooled connections die with the reboot; the pool rebuilds on first
   use).
8. **Remove the tailnet ACL grant** for app→db:5432 in the admin console (and
   any leftover ingress→db grant the
   [retirement pass below](#retiring-the-ingress-qubes-old-access-existing-installs)
   didn't get to).
9. **Prove the negative by attempt, not inspection** — from the app qube _and_
   the ingress qube, a TCP connect to `<db-qube-tailnet-ip>:5432` must now die
   at the wire (timeout, not an auth error), while the app's ConnectTCP path
   keeps working. This closes
   [#6](https://github.com/lcjanke2020/ob1-selfhosted/issues/6).

## Retiring the ingress qube's old access (existing installs)

A deployment that predates the ingress qube's local log sink
([ingress-qube/README.md § Local log sink](../ingress-qube/README.md#local-log-sink))
still carries live corpus access for the retired edge roles, and appending the
current `pg_hba.snippet.conf` cannot remove lines already present in the
installed file. Retirement is an explicit one-time pass — run it after the
ingress qube has cut over to its sink, from this qube's console (dom0 `qvm-run`)
or the app qube's superuser psql:

1. **Remove the two retired host lines** — `openbrain_ingester` and
   `openbrain_monitor` from the ingress qube's IP — from the installed
   `/etc/postgresql/<ver>/main/pg_hba.conf`. Keep a dated backup, then reload (a
   reload suffices for pg_hba):
   `sudo -u postgres psql -Atc 'select pg_reload_conf();'`
2. **Verify negatively** — the file still parses and no effective rule names
   either role:
   `sudo -u postgres psql -Atc "select count(*) from pg_hba_file_rules where error is not null or user_name::text ~ 'openbrain_(ingester|monitor)';"`
   must print `0`.
3. **Drop the corpus-side roles**, connected to the `openbrain` database — not
   the `postgres` maintenance DB, because `DROP OWNED BY` only acts in the
   database it runs in. Postgres does not let grants "die with" a role:
   privileges granted TO a role are recorded as dependencies that BLOCK a bare
   `DROP ROLE` (`privileges for table funnel_access_log`), so the revoke pass
   comes first, and each step fails loudly:
   1. Confirm neither role OWNS anything (`DROP OWNED BY` would drop it, not
      just revoke):
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname IN ('openbrain_ingester', 'openbrain_monitor');`
      must return zero rows.
   2. `DROP OWNED BY openbrain_ingester; DROP ROLE openbrain_ingester;` then
      `DROP OWNED BY openbrain_monitor; DROP ROLE openbrain_monitor;`. (The
      monitor role is optional — if it was never provisioned, its pair errors
      with "role does not exist" and can be skipped.)
   3. Confirm both are gone:
      `SELECT count(*) FROM pg_roles WHERE rolname IN ('openbrain_ingester', 'openbrain_monitor');`
      must print `0`.

   [`db/03-grants-assertion.sql`](../../../db/03-grants-assertion.sql) treats
   both roles as optional, so it still passes afterwards.
4. **Remove the tailnet ACL grant** for ingress→db:5432 — capture the ACL as
   actually deployed first (from the admin console, not a possibly-stale local
   copy) — and drop the ingress qube from any per-peer nft scoping you added.
5. **Never reuse the old passwords.** The sink reuses the role NAMES by design;
   give it fresh values in the ingress qube's `.env`, so a credential that left
   the edge before the cutover no longer opens anything.
6. **Prove the negative from the ingress qube** — a TCP attempt at
   `<db-qube-tailnet-ip>:5432` must now die at the wire (ACL/firewall timeout),
   not at authentication.
7. **Decide the legacy rows' fate** — nothing writes to or retention-prunes the
   corpus's `funnel_access_log`/`funnel_access_summary` anymore; see the cutover
   note in [app-qube/README.md](../app-qube/README.md) for the archive/truncate
   step and its verification.

## Template note

The shared Debian template keeps `tailscaled` **disabled**: enabling it in the
template breaks the template's own apt updates-proxy, because `tailscale0` is
IPv6-only at that stage and the proxy resolves `EAI_ADDRFAMILY`. The AppVM
starts `tailscaled` explicitly from `rc.local` instead. If you template-update
and reboot the DB qube, bounce the app-side connection pools afterward — clients
holding a pooled socket to the DB qube will see a stale-connection error
(`Broken pipe`) on first reuse until the pool is rebuilt.

**Pin the Postgres major version.** PGDATA lives in the bind-dir, but the
`postgresql-NN` package comes from the shared template. A template update that
crosses a major version (e.g. 17 → 18) gives you a newer server that **will not
start** against a PGDATA initialized by the old major. Verify the major version
the template ships before rebooting, and `pg_upgrade` (or dump/restore) across a
major bump deliberately rather than discovering it on a failed boot.

See [`../three-qube-design.md`](../three-qube-design.md) for the full reasoning
and the implemented three-qube split (the edge runs Caddy, the log-ingester, and
its own local log sink,
[#13](https://github.com/lcjanke2020/ob1-selfhosted/issues/13) and
[#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12) both resolved —
the edge is no longer a peer of this qube at all).
