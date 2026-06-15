# DB qube — provisioning artifacts

The [three-qube design](../three-qube-design.md) pulls Postgres out of compose into
a dedicated **database qube**: a minimal Debian-templated AppVM running Postgres +
pgvector natively, reachable only from the app qube over a firewall-scoped tailnet
link. This directory holds the on-disk config that makes that qube reproducible —
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
| `pg_hba.snippet.conf` | append to `/etc/postgresql/<ver>/main/pg_hba.conf` | scram host lines for the app roles, from the app qube's IP only |
| `postgresql.local.conf` | `conf.d/` drop-in or `ALTER SYSTEM` | `listen_addresses` (loopback + tailnet IP) and `ssl = off` |

## Placeholders to fill

- `<db-qube-tailnet-ip>` — this qube's own tailnet address (in `postgresql.local.conf`).
- `<app-qube-tailnet-ip>` — the app qube's tailnet address (in `pg_hba.snippet.conf`).
- Postgres major version (`17` in the paths/commands) — match your template.

## The three trust layers (why this is shaped the way it is)

Reachability is enforced in three independent layers, so no single
misconfiguration exposes the database:

1. **Tailscale ACL** — a grant permits exactly `app-qube → db-qube:5432`; every
   other tailnet peer is default-denied at the wire. (Configured in your tailnet
   admin console, not in this repo.)
2. **Qubes nftables** — `qubes-firewall-user-script` accepts inbound `tcp/5432`
   on `tailscale0` only. Because `qubes-firewall.service` runs *before*
   `tailscaled` (the interface does not exist yet), `ob1-db-firewall.service`
   re-applies the rule `After=tailscaled`, and `rc.local` (re)installs and
   enables that unit each boot.
3. **`pg_hba.conf`** — `scram-sha-256` host lines for the app roles from the app
   qube's IP only; the superuser stays off the network.

No `tcp/22` is opened: there is no sshd on the DB qube. All administration is
done from dom0 with `qvm-run`.

## Boot ordering

`rc.local` encodes the one ordering constraint that matters: `tailscale0` must
have its IP **before** Postgres starts, or the cluster cannot bind the tailnet
address. It starts `tailscaled`, re-applies the firewall rule on the new
interface, then waits for `tailscale0` to gain an `inet` address before starting
the cluster.

## Template note

The shared Debian template keeps `tailscaled` **disabled**: enabling it in the
template breaks the template's own apt updates-proxy, because `tailscale0` is
IPv6-only at that stage and the proxy resolves `EAI_ADDRFAMILY`. The AppVM starts
`tailscaled` explicitly from `rc.local` instead. If you template-update and
reboot the DB qube, bounce the app-side connection pools afterward — clients
holding a pooled socket to the DB qube will see a stale-connection error
(`Broken pipe`) on first reuse until the pool is rebuilt.

See [`../three-qube-design.md`](../three-qube-design.md) for the full reasoning
and the still-open ingress-split design.
