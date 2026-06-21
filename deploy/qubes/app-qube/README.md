# app qube — mcp + Ollama

The **app** qube of the [three-qube split](../three-qube-design.md): it runs the
application half (the MCP server + Ollama embeddings) and nothing else. The public edge
(Funnel + Caddy + log-ingester) lives on the [ingress qube](../ingress-qube/); the
canonical Postgres lives on the [db qube](../db-qube/). This qube is the **trusted
compartment** — it holds the DB admin credential and writes thoughts — reachable only from
the ingress qube.

Build this qube with the shared bind-dirs / SELinux / systemd-persistence mechanics from
the [Qubes README](../README.md) first; this directory is the app-qube-specific overlay.

## Run

```sh
cp .env.example .env && $EDITOR .env     # fill DB_HOST + the three passwords
docker compose up -d
```

[`docker-compose.yml`](docker-compose.yml) is self-contained — `mcp` + `ollama` only, no
override stack. `mcp` is published on `0.0.0.0:8787` so the ingress qube's Caddy can reach
it across qubes (set `MCP_UPSTREAM=<this-qube-tailnet-ip>:8787` in the *ingress* qube's
`.env`). Ollama runs CPU-only (no GPU passthrough in a Qubes app qube); point `OLLAMA_URL`
at an external GPU box to offload it.

The compose project is **not** auto-started on reboot (`restart: unless-stopped` only
resurrects containers while the daemon is up, not the project after an AppVM reboot). To
bring it back automatically, add `docker compose -f /path/to/app-qube/docker-compose.yml up -d`
to `rc.local` after the docker start, or run it by hand after a reboot.

## Credentials (per-qube split)

This qube **custodies** the **admin/superuser** `POSTGRES_PASSWORD` (the trusted compartment
holds it, never the internet-adjacent ingress qube) for administering the headless db qube —
role provisioning + schema/migrations. Those are applied **on the db qube over its loopback
socket** (see [`../db-qube/README.md`](../db-qube/README.md)); the db qube's superuser is
**never given a network host line**, so the app qube does not connect as superuser remotely
(driving migrations from here instead would be an opt-in that needs a scoped superuser
`pg_hba` line added on the db qube). For normal operation the app qube reaches the db qube as
`openbrain_app` (mcp writes thoughts) and `openbrain_readonly` (the backup job). It does
**not** carry the log-ingester credential — that lives only on the ingress qube.

## Host firewall (scope the `0.0.0.0:8787` bind)

The `0.0.0.0` bind is reachable on every interface (tailnet **and** LAN). Three independent
layers narrow it to the ingress qube — Tailscale ACL, this host firewall, and mcp app auth.
Install the firewall artifacts (counterpart to the db qube's):

| File | Install at | Purpose |
|------|-----------|---------|
| [`qubes-firewall-user-script`](qubes-firewall-user-script) | `/rw/config/qubes-firewall-user-script` (chmod +x) | `DOCKER-USER` rule: accept `:8787` only from the ingress qube's tailnet IP, drop it on every other source/interface |
| [`docker-ob1-firewall.conf`](docker-ob1-firewall.conf) | `/rw/config/docker-ob1-firewall.conf` (rc.local copies it to `/etc/systemd/system/docker.service.d/ob1-firewall.conf` each boot) | docker drop-in: re-runs the script `ExecStartPost` so a daemon restart can't leave `:8787` open |
| [`ob1-app-firewall.service`](ob1-app-firewall.service) | `/rw/config/ob1-app-firewall.service` | boot one-shot that applies the rule once `After=tailscaled` + docker |
| [`rc.local`](rc.local) | `/rw/config/rc.local` (chmod +x) | boot order: tailscaled → install docker drop-in → docker → firewall one-shot → backup timer |

The rule lives in `DOCKER-USER`, **not** the Qubes `custom-input` chain, because docker's
DNAT bypasses the qubes `INPUT` path — a `custom-input` accept/drop never sees the
published-port traffic. The script **inserts** (`-I`) above docker's seeded `RETURN` rule
(an appended rule would land below it and never run) and rebuilds idempotently. Replace
`<ingress-qube-tailnet-ip>` in the script with the ingress qube's address; if you later
**rotate** that address, flush the chain and re-run (`sudo iptables -F DOCKER-USER && sudo
/rw/config/qubes-firewall-user-script`) so the old ACCEPT doesn't linger. Two triggers keep
the rule live: the boot one-shot applies it at startup, and the docker drop-in re-applies it
on every daemon restart. (This layer also closes the LAN-reachable-`0.0.0.0`-bind gap — it
drops `:8787` on all interfaces, not just `tailscale0`.)

## Encrypted DB backup

A daily job dumps the db qube (read-only role), GPG-encrypts to a public key (this host
holds **no** private key), and drops the artifact into an off-box-replicated directory
(Syncthing, rsync, …). Artifacts + units are in [`backup/`](backup/); the design rationale
is in [`../encrypted-backup-example.md`](../encrypted-backup-example.md).

## Verify

```sh
docker compose config --services      # exactly: mcp, ollama
docker compose up -d
# from the ingress qube, a Caddy request to MCP_UPSTREAM should reach mcp;
# from any OTHER tailnet peer, :8787 should be dropped by the host firewall.
```
