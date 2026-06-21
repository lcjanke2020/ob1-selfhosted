# Install path 3 — Qubes OS

Running the stack inside a [Qubes OS](https://www.qubes-os.org/) app qube gets you VM-level compartmentalization around your memory store: the qube that talks to the internet is not the qube that holds your keys, and (with the [three-qube design](three-qube-design.md)) the qube that holds the public edge is not the qube that holds the database.

The **deployed shape** splits the stack across three qubes — a Funnel + Caddy **ingress** qube, an **app** qube (mcp + Ollama), and a **db** qube (Postgres) — connected over a firewall-scoped tailnet; see [`three-qube-design.md`](three-qube-design.md) for the threat model and trust layers. The setup mechanics in the sections below (bind-dirs, SELinux relabels, systemd persistence, networking) are written for a single Fedora-templated app qube because they apply to **each** qube you build; [Splitting the stack across qubes](#splitting-the-stack-across-qubes) at the bottom layers the split on top via per-role compose overrides. (A single app qube running the whole compose stack is still a valid starting point — just stop before the split.) Everything from the other two install paths applies; this page only covers what Qubes changes.

## Qube setup

- **Template:** a Fedora template with `docker`, `openssh-server`, and `tailscale` installed. Keep the qube's purpose narrow — this box's only job is the memory stack.
- **App qube (AppVM), not StandaloneVM** — root stays on the template (centralized updates); everything that must survive a reboot goes through bind-dirs (below).

### Bind-dirs: what must persist

A stock AppVM persists only `/home`, `/usr/local`, and `/rw` across reboots. The services this stack depends on keep state elsewhere — bind-dir each of these (in `/rw/config/qubes-bind-dirs.d/50_user.conf`):

```sh
binds+=( '/etc/ssh' )                # SSH host keys
binds+=( '/var/lib/tailscale' )      # Tailscale node identity
binds+=( '/var/lib/docker' )         # Docker metadata + volumes
binds+=( '/var/lib/containerd' )     # ← easy to miss; see below
```

> **The `/var/lib/containerd` gotcha (Fedora 43+).** Stock Docker ≥ 28 on Fedora 43 enables the containerd-snapshotter integration by default, which moves image content and snapshots out of `/var/lib/docker` into `/var/lib/containerd` (~10 GB for this stack's images). With only `/var/lib/docker` bind-dir'd, image pulls land on the qube's volatile root — `/` fills up, the next `docker compose build` dies with `no space left on device`, and everything re-pulls after each reboot. Pre-seed `/rw/bind-dirs/var/lib/containerd` (empty, `root:root 0710`) before rebooting into the bind.

If image data already landed in the volatile `/var/lib/containerd` and you don't want to re-pull:

```sh
docker compose down
sudo systemctl stop docker docker.socket containerd
sudo mv /var/lib/containerd /rw/bind-dirs/var/lib/containerd
sudo mkdir /var/lib/containerd
sudo mount --bind /rw/bind-dirs/var/lib/containerd /var/lib/containerd
sudo restorecon -R /var/lib/containerd
echo "binds+=( '/var/lib/containerd' )" | sudo tee -a /rw/config/qubes-bind-dirs.d/50_user.conf
sudo systemctl start docker
```

### SELinux relabels

Fedora-templated qubes enforce SELinux, which bites this stack in exactly two places:

1. **DB init scripts** — relabel once per checkout, before first start:
   ```sh
   chcon -Rt container_file_t /path/to/repo/db
   ```
   Symptom if skipped: postgres logs `Permission denied opening /docker-entrypoint-initdb.d/`, never becomes healthy, `mcp` never starts.
2. **The Caddyfile** (Pattern B) — already handled: its volume mount uses `:Z` so docker auto-relabels.

### Persisting systemd units

`/etc/systemd/system/*` is wiped on every AppVM reboot. To persist the [daily-summary timer](../compose-tailnet/README.md#observability-pattern-b) (or any other unit), stash the unit files under `/rw/config/<your-dir>/` and have `/rw/config/rc.local` copy them back and enable them at boot:

```sh
# in /rw/config/rc.local
cp /rw/config/openbrain-units/*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now funnel-summary.timer
```

For **user** timers, two extra Qubes-isms: idle app qubes get suspended (timers resume on wake), and user units only run without an open shell session if linger is on — `sudo loginctl enable-linger user`. If a timer "stopped firing", check `loginctl show-user user | grep Linger` and `systemctl --user is-enabled <timer>` before suspecting anything else.

## Networking posture

- All compose services bind loopback; tailnet exposure goes through `tailscale serve`/`funnel` exactly as in the [tailnet install](../compose-tailnet/README.md). **Split-deployment exception:** the app qube's `mcp` is deliberately published on the tailnet (`0.0.0.0:8787`) so the ingress qube's Caddy can reach it across qubes. That port is *not* left open to the tailnet at large — it is scoped by Tailscale ACL (only the ingress qube may reach it) + the app qube's host firewall (a `DOCKER-USER` rule, since docker DNAT bypasses the Qubes `INPUT` chain) + mcp's JWT auth. See the header of [`docker-compose.app-qube.yml`](docker-compose.app-qube.yml) for the three layers.
- Gate reachability with Tailscale ACL tags (e.g. a tag for "may reach the memory store on :443" and the standard ssh-target tag if you administer over the tailnet). Remember the qube's own firewall script (`/rw/config/qubes-firewall-user-script`) only opens what you add — `:22` is not open by default.
- Funnel (Pattern B) additionally needs the `funnel` node attribute on this device in the Tailscale admin console.

## Verified deployment

This shape — Fedora app qube, bind-dirs as above, Pattern A with CPU-only Ollama — passed the full [verification checklist](../compose-local/README.md#verification-checklist) end-to-end, including first-try semantic recall from a Claude client on another tailnet machine. The snags documented above are the complete list encountered; everything else worked as on a plain Linux host.

## Splitting the stack across qubes

A single qube running edge + app + database means a compromise of the public edge is a compromise of the memory store. The deployed Qubes shape therefore puts those three roles in three qubes, each reachable only by the next over a firewall-scoped tailnet. The full threat model, the three trust layers, and the reboot-persistence requirements are in [`three-qube-design.md`](three-qube-design.md); this section is the operator recipe. Build each qube with the bind-dirs / SELinux / persistence mechanics above, then layer the role-specific compose overrides below.

### db qube — Postgres only

Postgres runs natively, out of compose. The app qube reaches it with [`docker-compose.external-db.yml`](docker-compose.external-db.yml) layered on and `DB_HOST` set to the db qube's tailnet address; the bundled `postgres` service then no longer starts. The db qube accepts connections only from the app qube (Tailscale ACL + nft `tailscale0:5432` + `pg_hba` scram). Its own on-disk config — bind-dirs, the `tailscale0:5432` firewall unit, the boot ordering in `rc.local`, and the `pg_hba` / `listen_addresses` snippets — is provided as reproducible placeholders in [`db-qube/`](db-qube/) (see its [README](db-qube/README.md)).

### app qube — mcp + Ollama

The app qube runs the application half only, via [`docker-compose.app-qube.yml`](docker-compose.app-qube.yml): mcp + Ollama, no Caddy and no log-ingester. Its `mcp` is re-published on the tailnet (`0.0.0.0:8787`) so the ingress qube's Caddy can reach it — scoped by Tailscale ACL + the app qube's host firewall + mcp's JWT (the override file's header documents the three layers). A Qubes app qube has no GPU passthrough, so [`docker-compose.cpu-ollama.yml`](docker-compose.cpu-ollama.yml) strips the base ollama nvidia reservation (CPU `nomic-embed-text` is sub-second). Run from `deploy/qubes`:

```sh
DB_HOST=<db-qube-tailnet-ip> \
COMPOSE_FILE=../compose-local/docker-compose.yml:docker-compose.external-db.yml:docker-compose.cpu-ollama.yml:docker-compose.app-qube.yml \
docker compose up -d
```

Note there is **no** `docker-compose.pattern-b.yml` and **no** `COMPOSE_PROFILES=pattern-b` in that invocation — that is exactly what keeps Caddy (base file, `pattern-b` profile) and the log-ingester (in the pattern-b override) off the app qube.

### ingress qube — Funnel + Caddy (+ log-ingester)

The ingress qube terminates the Tailscale Funnel and runs Caddy. It layers the **same `external-db.yml`** as the app qube, so it has no local Postgres of its own and `DB_HOST` points the log-ingester at the db qube. Point Caddy at the app qube by setting `MCP_UPSTREAM=<app-qube-tailnet-ip>:8787`; the Caddyfile reads `reverse_proxy {$MCP_UPSTREAM}` (default `mcp:8787` when unset, i.e. single-host). Run from `deploy/qubes`:

```sh
DB_HOST=<db-qube-tailnet-ip> \
MCP_UPSTREAM=<app-qube-tailnet-ip>:8787 \
COMPOSE_FILE=../compose-local/docker-compose.yml:../compose-tailnet/docker-compose.pattern-b.yml:docker-compose.external-db.yml:docker-compose.cpu-ollama.yml \
COMPOSE_PROFILES=pattern-b \
docker compose up -d
```

`external-db.yml` parks the bundled `postgres`, so the edge holds **no** memory store. The log-ingester (started by the `pattern-b` profile here) tails Caddy's access logs and writes its `funnel_access_log` rows *across* to the db qube over the same scoped link — which is why the ingress qube keeps one INSERT-only path to `:5432` (the documented exception — see [three-qube-design.md](three-qube-design.md#log-ingester-placement-open) and #12). The flip between local-mcp and the app qube — and its rollback — is the one `MCP_UPSTREAM` line plus a Caddy reload.

What this recipe does **not** yet do is park the now-unused `mcp` + `ollama` that the Pattern B stack still starts on the edge (Caddy proxies past them to the app qube). That matters for isolation: the idle `mcp` still carries the app-role DB credential and an app-role path to the db qube, so the edge isn't fully severed from the store until it's parked (or its credential dropped, as the live deployment does). Doing it cleanly needs an ingress-only override that also resets `caddy`'s `depends_on`; it is tracked in #13.
