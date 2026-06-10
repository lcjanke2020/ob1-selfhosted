# Install path 3 — Qubes OS

Running the stack inside a [Qubes OS](https://www.qubes-os.org/) app qube gets you VM-level compartmentalization around your memory store: the qube that talks to the internet is not the qube that holds your keys, and (with the [three-qube design](three-qube-design.md)) the qube that holds the public edge is not the qube that holds the database.

This page documents the **current, deployed shape**: one Fedora-templated app qube running the whole compose stack ([Pattern A or B](../compose-tailnet/README.md)), with Docker, Tailscale, and sshd. Everything from the other two install paths applies; this page only covers what Qubes changes.

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

- All compose services bind loopback; tailnet exposure goes through `tailscale serve`/`funnel` exactly as in the [tailnet install](../compose-tailnet/README.md).
- Gate reachability with Tailscale ACL tags (e.g. a tag for "may reach the memory store on :443" and the standard ssh-target tag if you administer over the tailnet). Remember the qube's own firewall script (`/rw/config/qubes-firewall-user-script`) only opens what you add — `:22` is not open by default.
- Funnel (Pattern B) additionally needs the `funnel` node attribute on this device in the Tailscale admin console.

## Verified deployment

This shape — Fedora app qube, bind-dirs as above, Pattern A with CPU-only Ollama — passed the full [verification checklist](../compose-local/README.md#verification-checklist) end-to-end, including first-try semantic recall from a Claude client on another tailnet machine. The snags documented above are the complete list encountered; everything else worked as on a plain Linux host.

## Where this is going

A single qube running edge + app + database means a compromise of the public edge is a compromise of the memory store. The designed next step separates those into **ingress / app / db qubes** with the database pulled out of compose entirely — see [`three-qube-design.md`](three-qube-design.md).
