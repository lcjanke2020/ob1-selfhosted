# DB qube — provisioning artifacts

The [three-qube design](../three-qube-design.md) pulls Postgres out of compose into
a dedicated **database qube**: a minimal Debian-templated AppVM running Postgres +
pgvector natively, reachable over a firewall-scoped tailnet only by its scoped peers
— the app qube (full app role) and the ingress qube's log-ingester (INSERT-only); see
the [design doc](../three-qube-design.md). This directory holds the on-disk config that makes that qube reproducible —
the counterpart to the compose files for the other install paths.

These are **placeholders**, not drop-in secrets. Fill in the two addresses and
adjust the Postgres major version to match your template before using them.

## What each file is, and where it goes on the DB qube

Everything durable lives under `/rw` (a stock AppVM wipes `/etc/systemd/system`
and most of `/etc` on every reboot), and is re-installed at boot by `rc.local`.

| File here | Install at | Purpose |
|-----------|-----------|---------|
| `qubes-bind-dirs.d/50_user.conf` | `/rw/config/qubes-bind-dirs.d/50_user.conf` | Persist PGDATA, the cluster config, and the Tailscale identity across reboots |
| `qubes-firewall-user-script` | `/rw/config/qubes-firewall-user-script` (chmod +x) | nft accept for inbound `tcp/5432` on `tailscale0` only |
| `ob1-db-firewall.service` | `/rw/config/ob1-db-firewall.service` | One-shot that re-applies the firewall rule *after* `tailscaled` is up |
| `rc.local` | `/rw/config/rc.local` (chmod +x) | Boot order: start tailscaled → install/enable the firewall unit → start Postgres once `tailscale0` has an IP |
| `pg_hba.snippet.conf` | append to `/etc/postgresql/<ver>/main/pg_hba.conf` | scram host lines: app + readonly from the app qube, ingester from the ingress qube |
| `postgresql.local.conf` | `conf.d/` drop-in or `ALTER SYSTEM` | `listen_addresses` (loopback + tailnet IP) and `ssl = off` |

## Placeholders to fill

- `<db-qube-tailnet-ip>` — this qube's own tailnet address (in `postgresql.local.conf`).
- `<app-qube-tailnet-ip>` — the app qube's tailnet address: the app + readonly host lines in `pg_hba.snippet.conf`.
- `<ingress-qube-tailnet-ip>` — the ingress qube's tailnet address: the `openbrain_ingester` host line in `pg_hba.snippet.conf` (the log-ingester runs on the ingress qube).
- Postgres major version (`17` in the paths/commands) — match your template.

## The three trust layers (why this is shaped the way it is)

Reachability is enforced in three independent layers, so no single
misconfiguration exposes the database:

1. **Tailscale ACL** — grants permit exactly `app-qube → db-qube:5432` (and, for
   the log-ingester, `ingress-qube → db-qube:5432`); every other tailnet peer is
   default-denied at the wire. (Configured in your tailnet admin console, not in
   this repo.)
2. **Qubes nftables** — `qubes-firewall-user-script` accepts inbound `tcp/5432`
   on `tailscale0` only. The rule loads even before the interface exists
   (`iifname` matches by name, not index) and simply doesn't match traffic until
   `tailscale0` appears; `ob1-db-firewall.service` re-applies it `After=tailscaled`
   (waiting for the interface) to cover paths where `qubes-firewall` didn't run
   the user script in this leaf AppVM, and `rc.local` (re)installs and enables
   that unit each boot. The script is idempotent and logs to
   `/var/log/ob1-db-firewall.log`. Confirm the chain name matches your Qubes
   version with a pre-flight `nft list ruleset | grep custom-input` — if it
   differs, the accept won't land and the log will say so.
3. **`pg_hba.conf`** — `scram-sha-256` host lines scoped per peer: the app and
   readonly roles from the app qube's IP, the INSERT-only `openbrain_ingester`
   role from the ingress qube's IP; the superuser stays off the network.

No `tcp/22` is opened: there is no sshd on the DB qube. All administration is
done from dom0 with `qvm-run`.

## Boot ordering

`rc.local` encodes the one ordering constraint that matters: `tailscale0` must
have its IP **before** Postgres starts, or the cluster cannot bind the tailnet
address. It starts `tailscaled`, re-applies the firewall rule on the new
interface, then waits for `tailscale0` to gain an `inet` address before starting
the cluster. If the interface never comes up it logs an error and does **not**
start Postgres rather than failing quietly; boot output (and the
`pg_ctlcluster` exit status) lands in `/var/log/ob1-db-boot.log`.

### Disable the cluster's boot auto-start (required)

The "start Postgres only after `tailscale0` is up" guarantee holds **only** if
Debian's own boot-time auto-start is off. By default `postgresql@17-main.service`
starts the cluster early at boot — before `tailscale0` exists — so it fails to
bind `<db-qube-tailnet-ip>`, lands in `failed`, and can leave a stale
`postmaster.pid` that the `rc.local` start then contends with. Set the cluster to
manual once:

```
# /etc/postgresql/17/main/start.conf
manual
```

`manual` still allows `pg_ctlcluster 17 main start` (what `rc.local` runs); it
only suppresses the boot auto-start. It lives under `/etc/postgresql`, so the
bind-dir persists it across reboots.

## First boot / provisioning

These artifacts configure the cluster's *plumbing*; they don't create the
database, roles, or extension. On a fresh DB qube, once the cluster is up, run
the same SQL the compose path runs from `docker-entrypoint-initdb.d` — the
canonical definitions live in [`db/`](../../../db/) (`00-roles.sh`,
`01-schema.sql`, …). Note `00-roles.sh` is shaped as a container init-entrypoint:
it runs under the postgres Docker entrypoint and reads the `OPENBRAIN_*_PASSWORD`
env vars, so on a native cluster don't run it as-is — export those vars first and
pick Pattern A vs B, or apply the equivalent statements by hand. In broad strokes,
once per cluster:

```bash
# as the postgres superuser, over the loopback socket:
sudo -u postgres psql -c "CREATE DATABASE openbrain;"
sudo -u postgres psql -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
# then create the openbrain_app / openbrain_ingester / openbrain_readonly roles
# and load the schema — see db/00-roles.sh and db/01-schema.sql for the exact,
# up-to-date statements (Pattern A vs B, passwords, grants).
```

Apply `pg_hba.snippet.conf` and `postgresql.local.conf` after the roles exist,
then reload/restart so the network listener and host lines take effect.

## Template note

The shared Debian template keeps `tailscaled` **disabled**: enabling it in the
template breaks the template's own apt updates-proxy, because `tailscale0` is
IPv6-only at that stage and the proxy resolves `EAI_ADDRFAMILY`. The AppVM starts
`tailscaled` explicitly from `rc.local` instead. If you template-update and
reboot the DB qube, bounce the app-side connection pools afterward — clients
holding a pooled socket to the DB qube will see a stale-connection error
(`Broken pipe`) on first reuse until the pool is rebuilt.

**Pin the Postgres major version.** PGDATA lives in the bind-dir, but the
`postgresql-NN` package comes from the shared template. A template update that
crosses a major version (e.g. 17 → 18) gives you a newer server that **will not
start** against a PGDATA initialized by the old major. Verify the major version
the template ships before rebooting, and `pg_upgrade` (or dump/restore) across a
major bump deliberately rather than discovering it on a failed boot.

See [`../three-qube-design.md`](../three-qube-design.md) for the full reasoning
and the implemented three-qube split (the edge now runs only Caddy + the
log-ingester, [#13](https://github.com/lcjanke2020/ob1-selfhosted/issues/13) resolved;
log-ingester placement decided for now, [#12](https://github.com/lcjanke2020/ob1-selfhosted/issues/12)).
