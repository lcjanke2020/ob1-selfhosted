# Install path 3 — Qubes OS

Running the stack inside a [Qubes OS](https://www.qubes-os.org/) app qube gets
you VM-level compartmentalization around your memory store: the qube that talks
to the internet is not the qube that holds your keys, and (with the
[three-qube design](three-qube-design.md)) the qube that holds the public edge
is not the qube that holds the database.

The **deployed shape** splits the stack across three qubes — a Funnel + Caddy
**ingress** qube, an **app** qube (mcp + Ollama), and a **db** qube (Postgres) —
connected over a firewall-scoped tailnet; see
[`three-qube-design.md`](three-qube-design.md) for the threat model and trust
layers. The setup mechanics in the sections below (bind-dirs, SELinux relabels,
systemd persistence, networking) are written for a single Fedora-templated app
qube because they apply to **each** qube you build;
[Splitting the stack across qubes](#splitting-the-stack-across-qubes) at the
bottom points each qube at its own self-contained per-role compose directory. (A
single app qube running the whole compose stack is still a valid starting point
— just stop before the split.) Everything from the other two install paths
applies; this page only covers what Qubes changes.

## Qube setup

- **Template:** a Fedora template with `docker`, `openssh-server`, and
  `tailscale` installed. Keep the qube's purpose narrow — this box's only job is
  the memory stack. For the deployed
  [rootless-docker posture](#rootless-docker-the-deployed-engine-posture), the
  template also needs `docker-ce-rootless-extras` + `slirp4netns` (and `socat`
  for the qrexec forwarders).
- **App qube (AppVM), not StandaloneVM** — root stays on the template
  (centralized updates); everything that must survive a reboot goes through
  bind-dirs (below).

### Bind-dirs: what must persist

A stock AppVM persists only `/home`, `/usr/local`, and `/rw` across reboots. The
services this stack depends on keep state elsewhere — bind-dir each of these (in
`/rw/config/qubes-bind-dirs.d/50_user.conf`):

```sh
binds+=( '/etc/ssh' )                # SSH host keys
binds+=( '/var/lib/tailscale' )      # Tailscale node identity
binds+=( '/var/lib/docker' )         # ROOTFUL docker only — see note
binds+=( '/var/lib/containerd' )     # ROOTFUL docker only; easy to miss — see below
```

> The two docker binds apply to a **rootful** daemon. The deployed shape runs
> [rootless docker](#rootless-docker-the-deployed-engine-posture), whose storage
> lives in `~/.local/share/docker` — inside home, which persists natively — so
> neither bind is needed there. Keep them only for the simpler rootful on-ramp.

> **The `/var/lib/containerd` gotcha (Fedora 43+).** Stock Docker ≥ 28 on Fedora
> 43 enables the containerd-snapshotter integration by default, which moves
> image content and snapshots out of `/var/lib/docker` into
> `/var/lib/containerd` (~10 GB for this stack's images). With only
> `/var/lib/docker` bind-dir'd, image pulls land on the qube's volatile root —
> `/` fills up, the next `docker compose build` dies with
> `no space left on device`, and everything re-pulls after each reboot. Pre-seed
> `/rw/bind-dirs/var/lib/containerd` (empty, `root:root 0710`) before rebooting
> into the bind.

If image data already landed in the volatile `/var/lib/containerd` and you don't
want to re-pull:

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

### Rootless docker (the deployed engine posture)

Membership in the `docker` group is **root-equivalent by construction**: the
rootful daemon runs as root and honours arbitrary bind mounts, so
`docker run -v /:/host …` is a root shell — no password involved. On a qube that
otherwise enforces a sudo password and a locked-down polkit, that one group
membership quietly reopens the root path the lockdown closed. The deployed shape
therefore runs every compose stack under the **operator account's rootless
dockerd** and keeps the `docker` group empty:

- **Install** (per qube, as the operator account):
  `dockerd-rootless-setuptool.sh install` — needs `docker-ce-rootless-extras`
  and `slirp4netns` in the template. The daemon is a `systemd --user` unit; no
  account belongs to the `docker` group.
- **Autostart:** `sudo loginctl enable-linger user`. The user manager starts the
  rootless daemon at boot, and `restart: unless-stopped` resumes the containers
  — the per-qube `rc.local` files start no docker and run no compose self-heal.
- **Storage:** `~/.local/share/docker`, inside home — persists natively, so the
  `/var/lib/docker` + `/var/lib/containerd` bind-dirs above aren't needed.
- **Re-assert "rootful off" every boot.** The template still ships rootful
  docker, and `/etc` (unit enablement) + `/etc/group` (docker membership) are
  reset from the template on each AppVM boot. The shipped
  [`app-qube/rc.local`](app-qube/rc.local) disables + masks
  `docker`/`docker.socket`/`containerd`, empties the `docker` group, and removes
  the dead `/var/run/docker.sock` inode a template-enabled `docker.socket`
  re-creates before the mask lands.

Two traps worth knowing before you convert an existing rootful deployment:

- **The setuptool switches your default docker context** to the rootless daemon.
  Anything on the qube that reads the rootful socket by default — an existing
  log monitor, `docker logs` tooling, scripts — silently goes blind until
  repointed (or until rootful is retired and the context switch is the point).
- **Container→host networking changes shape.** Under rootless, the compose
  bridge lives inside rootlesskit's network namespace: a host-side service bound
  to the old bridge-gateway IP becomes unreachable from containers, and
  `DOCKER-USER`/`br-*` firewall hooks stop seeing container traffic. The working
  replacement is the qube's **own IP** (`qubesdb-read /qubes-ip`): slirp4netns
  delivers container→own-host-IP traffic to the host on `lo`, which the qubes
  input chain accepts — no firewall rule needed. Both qrexec forwarder
  transports
  ([ingress→app](ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp),
  [GPU offload](gpu-offload-transport.md)) are written this way.

### SELinux relabels

Fedora-templated qubes enforce SELinux, which bites this stack in exactly two
places:

1. **DB init scripts** — relabel once per checkout, before first start:
   ```sh
   chcon -Rt container_file_t /path/to/repo/db
   ```
   Symptom if skipped: postgres logs
   `Permission denied opening /docker-entrypoint-initdb.d/`, never becomes
   healthy, `mcp` never starts.
2. **The Caddyfile** (Pattern B) — already handled: its volume mount uses `:Z`
   so docker auto-relabels.

### Persisting systemd units

`/etc/systemd/system/*` is wiped on every AppVM reboot. To persist a **system**
unit such as the app qube's encrypted-backup timer, stash its unit files under
`/rw/config/<your-dir>/` and have `/rw/config/rc.local` copy them back and
enable them at boot:

```sh
# in /rw/config/rc.local
cp /rw/config/openbrain-units/*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ob1-db-backup.timer
```

User units under `~/.config/systemd/user/` live in the persistent home and do
not need that `rc.local` copy. The app qube's shipped
[daily-summary timer](app-qube/README.md#daily-funnel-rollup-and-retention-host-side)
is one. Two extra Qubes-isms apply: idle app qubes get suspended
(`Persistent=true` runs a missed calendar occurrence after wake), and user units
only run without an open shell session if linger is on —
`sudo loginctl enable-linger user`. If a timer stopped firing, check
`loginctl show-user user | grep Linger` and
`systemctl --user is-enabled <timer>` before suspecting the script.

## Networking posture

- All compose services bind loopback — **including the split deployment's
  `mcp`**; tailnet exposure goes through `tailscale serve`/`funnel` exactly as
  in the [tailnet install](../compose-tailnet/README.md). The ingress qube's
  Caddy reaches the app qube's loopback-only mcp over a **qubes.ConnectTCP**
  channel: a socat forwarder on the ingress qube bridges Caddy to the qrexec
  call, and dom0 policy
  (`qubes.ConnectTCP +8787 <ingress-qube> <app-qube> allow autostart=no`) gates
  the channel — see
  [the ingress→app hop](ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp).
  mcp's app auth (OAuth Bearer JWT — the only auth door on this OAuth-only
  deployment; no x-brain-key) still authenticates every request that arrives
  over it. An earlier revision published mcp on `0.0.0.0:8787` and scoped the
  wide bind with a Tailscale ACL grant + a `DOCKER-USER` host-firewall rule; the
  qrexec transport removed that listener class entirely.
- Gate reachability with Tailscale ACL tags (e.g. a tag for "may reach the
  memory store on :443" and the standard ssh-target tag if you administer over
  the tailnet). Remember the qube's own firewall script
  (`/rw/config/qubes-firewall-user-script`) only opens what you add — `:22` is
  not open by default.
- The public Funnel door additionally needs the `funnel` node attribute on this
  device in the Tailscale admin console.
- Unattended agents use the same OAuth verifier over the private tailnet branch;
  provision and verify them with the
  [client-credentials service-account runbook](../../docs/service-account-oauth-client.md).

## Verified deployment

This shape — Fedora app qube, bind-dirs as above, CPU-only Ollama — passed the
full [verification checklist](../compose-local/README.md#verification-checklist)
end-to-end, including first-try semantic recall from a Claude client on another
tailnet machine. The snags documented above are the complete list encountered;
everything else worked as on a plain Linux host.

## Splitting the stack across qubes

A single qube running edge + app + database means a compromise of the public
edge is a compromise of the memory store. The deployed Qubes shape therefore
puts those three roles in three qubes, each reachable only by the next over a
firewall-scoped tailnet. The full threat model, the three trust layers, and the
reboot-persistence requirements are in
[`three-qube-design.md`](three-qube-design.md); this section is the operator
recipe. Build each qube with the bind-dirs / SELinux / persistence mechanics
above, then run that qube's **self-contained** per-role compose directory below.

Each role gets its own directory with a self-contained `docker-compose.yml`, a
per-qube `.env.example` (the credential split — each qube holds only the secrets
it needs), and a README: [`db-qube/`](db-qube/), [`app-qube/`](app-qube/),
[`ingress-qube/`](ingress-qube/). No `COMPOSE_FILE` override stack, no
`--profile` flags — `cp .env.example .env && docker compose up -d` in the right
directory. (The override files
[`docker-compose.external-db.yml`](docker-compose.external-db.yml) +
[`docker-compose.cpu-ollama.yml`](docker-compose.cpu-ollama.yml) remain only for
the simpler on-ramp of a _single_ app qube running the whole base stack against
an external DB.)

### db qube — Postgres only

Postgres runs natively, out of compose, in [`db-qube/`](db-qube/). The app qube
reaches it as the full app role (and the readonly role for backups); the ingress
qube reaches it as two scoped observability roles — the INSERT-only ingester and
the SELECT-only funnel monitor. All are scoped by Tailscale ACL + nft
`tailscale0:5432` + `pg_hba` scram. Its on-disk config — bind-dirs, the
`tailscale0:5432` firewall unit, the boot ordering in `rc.local`, and the
`pg_hba` / `listen_addresses` snippets — is provided as reproducible
placeholders in [`db-qube/`](db-qube/) (see its [README](db-qube/README.md)).

### app qube — mcp + Ollama

The app qube runs the application half only — mcp + Ollama (CPU-only), no Caddy,
no log-ingester, no local Postgres. Its `mcp` publishes `127.0.0.1:8787` only —
no network-facing listener; the ingress qube's Caddy reaches it over the
dom0-policy-gated qubes.ConnectTCP channel
([the ingress→app hop](ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp)),
and mcp's app auth authenticates what arrives. The app qube is the trusted DB
control-plane, so its `.env` holds the admin + app + readonly passwords (never
the ingester credential); it also runs the encrypted off-box backup
([`app-qube/backup/`](app-qube/backup/)). Full recipe in
[`app-qube/README.md`](app-qube/README.md):

```sh
cd app-qube
cp .env.example .env && $EDITOR .env     # required values + METADATA_FALLBACK_POLICY
docker compose up -d                     # services: mcp, ollama
```

### ingress qube — Funnel + Caddy (+ log-ingester)

The ingress qube terminates the Tailscale Funnel and runs Caddy + the
log-ingester, with **no** memory store and **no** app credential — it carries
only two observability credentials: the INSERT-only ingester and the SELECT-only
funnel monitor. Caddy reverse-proxies to the app qube's mcp through the
host-side ConnectTCP forwarder (`MCP_UPSTREAM=<this-qube-ip>:18787` — see
[the ingress→app hop](ingress-qube/README.md#the-ingressapp-hop-qubesconnecttcp));
the log-ingester writes its `funnel_access_log` rows _across_ to the db qube
(`DB_HOST`), the one INSERT-only path this qube keeps to `:5432` (the documented
exception — see
[three-qube-design.md](three-qube-design.md#log-ingester-placement-decided-for-now)
and #12), and the host-side funnel monitor reads that table back over the same
wire. The monitor can optionally deliver privacy-safe, deduplicated Pushover
alerts for public-door 401 bursts; provider credentials remain separate 0600
host files (see
[`ingress-qube/README.md`](ingress-qube/README.md#funnel-monitor-host-side-not-compose)).
A **parked** local `postgres` is kept on disk for a future local logs store but
never started. Full recipe in
[`ingress-qube/README.md`](ingress-qube/README.md):

```sh
cd ingress-qube
cp .env.example .env && $EDITOR .env     # MCP_UPSTREAM (ConnectTCP forwarder), DB_HOST (db qube), ingester pw
docker compose up -d                     # services: caddy, log-ingester
sudo tailscale funnel --bg --https=443 http://127.0.0.1:9787   # expose Caddy (vacate :443 first)
```

The per-qube `ingress-qube/docker-compose.yml` defines **only** `caddy` +
`log-ingester` (plus the parked DB) — the now-unused edge `mcp` + `ollama` that
the old override recipe still started are simply not there, which is the clean
end state of #13. `MCP_UPSTREAM` remains the topology's one pivot point: the
single-host install defaults it to `mcp:8787`, the split points it at the
ConnectTCP forwarder, and the documented rollback repoints it at a direct
app-qube address — each flip is that one line plus a Caddy reload (the rollback
also needs the app-qube compose republished on `0.0.0.0`).
