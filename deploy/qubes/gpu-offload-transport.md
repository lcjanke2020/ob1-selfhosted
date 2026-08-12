# Offloading metadata classification to a GPU qube (qrexec ConnectTCP)

> **One configuration option among three — pick deliberately.** OB1's metadata
> extractor (`CHAT_API_BASE`) calls an OpenAI-compatible `/chat/completions`
> endpoint — any server that also supports the strict `json_schema` response
> format it sends (see the verification note at the end) — so it routes with
> equal ease to:
>
> 1. **Another machine on your network running a local LLM** (LM Studio, ollama,
>    …) — just set `CHAT_API_BASE` to its URL; no plumbing.
> 2. **Any hosted OpenAI-compatible provider** with an API key — same, plus
>    `CHAT_API_KEY`; thought content leaves your network.
> 3. **A GPU qube on the same Qubes host** whose model server is bound to
>    **loopback only** — no network-facing listener on the serving qube: no
>    tailnet/LAN bind, no sshd. This is the only option that needs the plumbing
>    below (a host-side forwarder + a qrexec `ConnectTCP` transport), and it is
>    **not a good fit for everyone**: it trades setup effort and a console-only
>    administration model for the smallest network exposure. For the rationale —
>    what the no-listener posture buys, the GPU-passthrough privilege argument,
>    and the honest tradeoffs (no sshd means no remote administration without
>    purpose-built tooling) — see
>    [Serving From a Qube With No Network-Facing Listener](https://github.com/lcjanke2020/qubes-os-explorations/blob/master/qrexec-connecttcp-service-qube.md)
>    in the qubes-os-explorations repo. This doc is the OB1-specific how-to.

```
mcp container ──(app qube's own IP :11434)──▶ socat  [app qube host]
                                                └─ qubes.ConnectTCP+11434 (qrexec) ─▶ <gpu-qube> 127.0.0.1:11434
```

Placeholders below: `<app-qube>` = the qube running this compose project,
`<gpu-qube>` = the qube with the GPU + the loopback model server, `<qube-ip>` =
the app qube's own IP (`qubesdb-read /qubes-ip` — see step 2). `11434` is the
ollama port; substitute your server's port throughout.

This doc assumes the deployed **rootless** docker posture
([Qubes README § Rootless docker](README.md#rootless-docker-the-deployed-engine-posture)),
where the forwarder binds the qube's own IP and no firewall rule is needed; the
rootful variant (bridge-gateway bind + a `custom-input` accept) is kept as a
note in step 3.

---

## Degradation, disabling, re-enabling

This transport is **optional and easy to disable**. If the GPU qube becomes
unavailable, leave the safety knobs below in place — the `autostart=no` **policy
option** (step 1), with the forwarder unit left enabled and running (it has no
`autostart` setting of its own). The primary attempt then fails fast without
starting the halted qube. OB1 follows `METADATA_FALLBACK_POLICY`: `off` stores a
local stub, while `alert` or `allow` may classify through `FALLBACK_CHAT_*`. The
permitted-fallback path is field-verified: with the GPU qube halted, the
forwarder accepts the TCP connection, the qrexec call is refused, the connection
closes with no timeout burn, fallback classifies in the same request, and the
GPU qube stays halted. Re-enable by starting the GPU qube; no code or config
change is required (the extractor is endpoint-agnostic). To park the transport
entirely, additionally stop + disable the forwarder unit and remove its rc.local
restage lines (under the rootless posture there is no firewall stanza to unwind;
on the rootful variant, also drop the step-3 `br-*` accept).

---

## 1. dom0 policy

`/etc/qubes/policy.d/30-ob1-connecttcp.policy`:

```
qubes.ConnectTCP +11434 <app-qube> <gpu-qube> allow
```

**Gotcha — explicit destination, not `@default`.** The forwarder calls
`qrexec-client-vm <gpu-qube> qubes.ConnectTCP+11434`, naming an explicit target.
A caller that names an explicit target does **not** match a rule written with
`@default` (+ `target=`) — the request is refused. Name the destination qube in
the rule.

**Safety — `autostart=no` (strongly recommended).** qrexec **auto-starts a
halted target** by default, so a capture-path classification call would _boot_
the GPU qube. If booting it is ever undesirable (it's down for maintenance, or
starting it is risky), append `autostart=no`:

```
qubes.ConnectTCP +11434 <app-qube> <gpu-qube> allow autostart=no
```

Now the call simply fails when the GPU qube is halted → the extractor moves on
to its fallback, and a capture can never start the qube as a side effect.

Validate after editing (in dom0) — a malformed rule should fail the parse here,
not be discovered at the first refused capture:

```sh
qubes-policy-lint /etc/qubes/policy.d/30-ob1-connecttcp.policy  # ships with qubes-core-qrexec (4.2+)
# where qubes-policy-lint isn't available, parse the whole policy dir directly:
python3 -c "from qrexec.policy.parser import FilePolicy; import pathlib; FilePolicy(policy_path=pathlib.Path('/etc/qubes/policy.d')); print('OK')"
```

Nothing is installed in `<gpu-qube>` for the transport itself:
`qubes.ConnectTCP` is a stock qrexec service that connects to `127.0.0.1:<port>`
on the target. The
[companion guide](https://github.com/lcjanke2020/qubes-os-explorations/blob/master/qrexec-connecttcp-service-qube.md)
walks the server side — binding the model server to loopback and verifying the
qube ends up with no network-facing listener.

## 2. App-qube host forwarder (socat)

The container can't issue qrexec itself, so a small `socat` on the **app-qube
host** bridges a local TCP port to the qrexec call. (`socat` isn't in every
template — install it in the app qube's **template**: `/usr` is
template-provided, so a package installed in the app qube itself vanishes on
reboot.)

`/rw/config/ob1-ollama-forward.sh`:

```bash
#!/bin/bash
# Bind the qube's OWN IP: under rootless docker the mcp container reaches its
# host via slirp4netns at that address (the packet arrives on lo, which the
# qubes input chain accepts); eth0/tailscale peers are covered by the qubes
# input default-drop — no accept rule exists for :11434.
set -e
BIND_IP="$(qubesdb-read /qubes-ip)"
exec socat TCP-LISTEN:11434,fork,reuseaddr,bind="${BIND_IP}" \
  EXEC:'/usr/bin/qrexec-client-vm <gpu-qube> qubes.ConnectTCP+11434'
```

Make it executable — the unit below runs the file directly as `ExecStart`, and a
default-`0644` file fails at start with `Permission denied`:

```sh
chmod +x /rw/config/ob1-ollama-forward.sh
```

(No port clash with the compose stack's own `ollama` container: that publishes
`127.0.0.1:11434` — the CPU-only **embeddings** server — while the forwarder
binds the same port on a different address, the qube's own IP. Two sockets, two
roles; the CPU ollama keeps serving embeddings either way.)

`/rw/config/ob1-ollama-forward.service`:

```ini
[Unit]
Description=OB1 ollama forwarder (qube-ip:11434 -> <gpu-qube> via qrexec ConnectTCP)
After=qubes-network.service
[Service]
ExecStart=/rw/config/ob1-ollama-forward.sh
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

(No docker dependency: the bind address is the qube's own IP, which exists as
soon as qubes networking is up — the unit no longer waits on a compose bridge,
and `Restart=always` converges over anything transient.)

**Why the qube's own IP — and why not a bridge gateway.** Two docker facts
combine here. A container on a _user-defined_ bridge cannot reach `docker0` /
`host.docker.internal` (inter-bridge isolation) — that rules out the obvious
targets under any engine. And under **rootless** docker the compose bridge
itself lives inside rootlesskit's network namespace, so a host-side bind on the
bridge-gateway IP (the rootful-era answer) is unreachable from the host side
entirely. What does work is slirp4netns's own path: a container connecting to
its **host's own IP** is delivered to the host on `lo`. The qube's IP is also
stable across compose recreates — no subnet pinning needed.

## 3. Qubes firewall — nothing to add (rootless)

Qubes' nft `input` chain is **policy-drop**, which is exactly why the qube-IP
bind works with no rule: slirp4netns delivers container→own-host-IP traffic to
the host on **`lo`**, and the stock chain accepts loopback. Meanwhile
eth0/tailscale peers get the default-drop — no accept rule exists for `:11434`,
so only this qube's own workloads can reach the forwarder.

> **Rootful variant (historical / non-rootless installs).** Under a rootful
> daemon the compose bridge is a host-side `br-*` interface: bind the forwarder
> to _this project's_ bridge-gateway IP (find it with
> `docker network inspect <project>_default -f
> '{{(index .IPAM.Config 0).Gateway}}'`;
> pin subnet/gateway in a local, uncommitted `docker-compose.override.yml` for
> stability), and add a `custom-input` accept, since that path is _not_
> loopback:
>
> ```bash
> nft add rule ip qubes custom-input iifname "br-*" tcp dport 11434 ct state new accept
> ```
>
> Caveats that made this the more fragile shape: `br-*` matches every
> user-defined bridge on the qube; the default `br-<id>` name changes when the
> network is recreated; and the `qubes-firewall` hook that would apply the
> script never fires on a qube that doesn't route other qubes — the rule needs a
> one-shot unit or an rc.local mirror. The qube-IP bind above retires all of it.

## 4. Persistence (rc.local)

`/etc/systemd` is reset from the template each boot, so restage + enable the
forwarder unit from `/rw/config` in `/rw/config/rc.local` — the shipped
[`app-qube/rc.local`](app-qube/rc.local) carries exactly this block (guarded:
absent files = transport not installed, boot carries on cleanly):

```bash
if [ -f /rw/config/ob1-ollama-forward.service ]; then
  cp /rw/config/ob1-ollama-forward.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now ob1-ollama-forward.service
fi
```

(Ordering doesn't matter under rootless — the qube's own IP exists as soon as
qubes networking is up, and the rootless daemon is the operator account's user
service, started by linger independently of rc.local.)

## 5. Wire it to OB1

In the app qube's `.env` (`<qube-ip>` = `qubesdb-read /qubes-ip` on the app
qube):

```dotenv
CHAT_API_BASE=http://<qube-ip>:11434/v1
CHAT_MODEL=<your-served-model>
# CHAT_API_KEY blank for a local ollama (no auth)
ENABLE_PRIMARY_EXTRACTION=true
```

Choose `METADATA_FALLBACK_POLICY` explicitly. Use `off` to keep a downed GPU
qube from sending content anywhere else, `alert` to permit the configured
fallback only with a notification channel, or `allow` to permit fallback without
requiring delivery. Configure `FALLBACK_CHAT_*` only for the latter two choices.
See [`app-qube/.env.example`](app-qube/.env.example) for the full block and the
`ENABLE_PRIMARY_EXTRACTION` safety gate (off unless exactly `true`).

## 6. Host RAM on the GPU qube — size it generously

It is tempting to trim the GPU qube's memory down — "the model lives in VRAM,
the host side is just a shim". Field experience says otherwise: **an undersized
GPU qube produces exactly the silent-fallback failure class this transport
exists to prevent**, and it does so _intermittently_, which makes it expensive
to diagnose.

What actually happens (mechanics per ollama 0.30 on Linux with a discrete GPU;
the numbers used below are a worked hypothetical, not any particular
deployment's profile):

- The model server's host-side process legitimately needs several GiB even with
  the weights in VRAM: load machinery, per-request state, and — on newer ollama
  — large transient allocations that arrive at _request_ time (prompt- cache
  state saves approaching 1 GiB).
- ollama wants enough **free** host RAM to **mmap** the model file at load —
  when it expects the model to fit on the GPU, the scheduler's host-pressure
  check (upstream `server/sched.go`) requires
  `system_free ≥ model_size + loaded_mmap_size + max(8 GB, total_memory/10)` —
  the floor is decimal (ollama's `format.GigaByte` is 1000³): 8 GB ≈ 7.45 GiB.
  Below that it logs
  `disabling mmap for llama-server load due to host memory
  pressure` and takes
  a heavier buffered load path — more anonymous host RAM, slower loads, and no
  page cache to make the next load cheap. The log line prints every input to the
  decision (`model_size`, `loaded_mmap_size`, `headroom`, `system_free`,
  `system_total`) — size from those fields, not from guesses.
- A GPU-passthrough qube typically runs with **fixed memory** (`maxmem 0` — no
  ballooning), so nothing rescues a spike: the kernel OOM killer kills the
  server. `Restart=always` brings it back in seconds — **empty**. The resident
  model is gone, a `keep_alive=-1` pin died with the process, and nothing looks
  wrong until the next capture pays a cold load, then stores a stub under `off`
  or may use `FALLBACK_CHAT_*` under `alert`/`allow`.

The symptom set masquerades as an eviction or keep-alive bug, which is the trap:
`/api/ps` shows the model pinned with a far-future `expires_at` on one check and
absent on the next; captures classify via primary at HH:MM and leak via fallback
at HH:MM+20. Note also that this failure **burns the full `CHAT_TIMEOUT_MS`**
when the kill lands mid-request — unlike the halted-qube case in the degradation
section above, which fails fast — because the connection is accepted and then
never answered.

**Diagnosis** (on the GPU qube; unit name per your install):

```sh
journalctl -u ollama | grep -iE "oom|killed|memory pressure"
# the two smoking guns:
#   "A process of this unit has been killed by the OOM killer" / "Failed with result 'oom-kill'"
#   "disabling mmap for llama-server load due to host memory pressure"
systemctl show ollama -p NRestarts    # restarts you didn't perform
```

**Sizing rule:** derive it from the scheduler's own inputs — two different
thresholds matter, and they are not the same number.

- **The OOM floor.** Assigned RAM must cover the server's host-side peak
  (several GiB of anonymous memory at request time, per the first bullet above)
  plus the OS and services. Below this the qube is OOM roulette on every
  request, whatever mmap decides.
- **The mmap threshold.** Cheap loads additionally need _free_ RAM at load time
  to clear the `model_size + loaded_mmap_size + max(8 GB,
  total_memory/10)`
  check — _free_, not assigned: the OS, services, and whatever else is resident
  all bite into it first, so assigned RAM has to sit comfortably above the sum.

A worked hypothetical: a 16 GiB model file, no other mmap-loaded model, and a
qube small enough that the headroom term is its 8 GB floor (≈ 7.45 GiB) — the
raw threshold is ≈ 23.5 GiB _free_; treat "≥ 24 GiB free" as the rounded-up
target. An 8 GiB qube is below even the OOM floor for that model. A 24 GiB qube
clears the OOM floor but can never clear the mmap check (the OS and services
already hold a few GiB), so every load quietly takes the buffered path. ~32 GiB
keeps mmap on with margin — and the spare RAM is not wasted: it becomes page
cache for the model file, which makes post-restart reloads dramatically cheaper.
After resizing, confirm the load journal no longer shows the mmap-disable line
and the oom-kill entries stop recurring — the line's own fields tell you how
much margin you actually have.

## 7. Keep the model resident (pre-warm at boot, re-warm on a timer)

The first request after a model (re)load pays a cold start of tens of seconds;
with a 30B-class model that can consume most of the extractor's
`CHAT_TIMEOUT_MS` budget (default 60 s) and tip a capture into the fallback.
Load the model _before_ any capture arrives, and re-assert residency on a timer
so a crash or restart self-heals instead of leaking. Three files on the GPU qube
(ollama flavor; adjust for your server):

`/usr/local/bin/ollama-warmup.sh`:

```bash
#!/bin/bash
# Load the classifier model and pin it resident. A no-op costing milliseconds
# when the model is already loaded — so the same script is both the boot
# pre-warm and the periodic self-heal.
MODEL="<your-served-model>"
for i in $(seq 1 60); do
  curl -sf --max-time 5 http://127.0.0.1:11434/api/version >/dev/null && break
  sleep 2
done
exec curl -sf --max-time 290 -X POST http://127.0.0.1:11434/api/generate \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"keep_alive\":-1}" >/dev/null
```

`/etc/systemd/system/ollama-warmup.service`:

```ini
[Unit]
Description=Pre-load classifier model (resident warm-up)
After=ollama.service
Wants=ollama.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ollama-warmup.sh
# Worst case in the script above: 60 waits x (5 s curl + 2 s sleep) = 420 s
# before the generate even starts, + up to 290 s for the load itself.
TimeoutStartSec=720
```

`/etc/systemd/system/ollama-warmup.timer`:

```ini
[Unit]
Description=Re-warm classifier model every 5 min (self-heal after crash)

[Timer]
OnBootSec=20s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
```

```sh
systemctl daemon-reload && systemctl enable --now ollama-warmup.timer
```

The five-minute tick bounds the window in which a crash can put a cold model in
front of a capture. Two companion settings, same qube:

- **Pin residency server-side, not per-request.** A per-request `keep_alive` pin
  is weaker than it looks — not because ordinary traffic overwrites it (in
  ollama 0.30 a request that _omits_ `keep_alive` leaves a loaded runner's
  expiry alone, and the OpenAI-compatible endpoint never sends one), but because
  the pin lives in the runner, and runners get replaced by events ordinary
  operation produces: a crash, a server restart, an option change forcing a
  reload, a real request racing the boot warm-up. Every **fresh** load whose
  request carries no `keep_alive` starts from the _server default_ of five
  minutes (upstream `server/sched.go` takes `envconfig.KeepAlive()` unless the
  request overrides it) — so a probe-applied pin quietly downgrades to five
  minutes on the next reload. Set `Environment=OLLAMA_KEEP_ALIVE=-1` in a unit
  drop-in: that makes the default itself infinite and covers every load path,
  including the ones the warm-up timer exists to catch.
- **Privacy note for ollama ≥ 0.30:** unless `OLLAMA_NO_CLOUD=true` is set, the
  server periodically phones ollama.com (registry / model-metadata cache
  hydration) — from the qube whose reason to exist is that content never leaves
  it. Add it to the same drop-in.

## Notes

- **Cold load / residency.** The first request after a model (re)load pays a
  cold start of tens of seconds vs a warm call; §7 wires the pre-warm + re-warm
  that keeps it off the capture path, and §6 explains why an undersized qube
  silently undoes both.
- **Know when it degrades.** Every fallback classification is a privacy event
  recorded in the durable, content-free database audit and still logged to
  stderr for diagnosis. Optional Pushover/ntfy first-occurrence alerts and
  rollups, plus the legacy log-monitor fallback, are in
  [`docs/metadata-degradation-monitoring.md`](../../docs/metadata-degradation-monitoring.md).
- **Verify the transport:** from the app-qube host,
  `curl http://<qube-ip>:11434/v1/models` (should list the model); from inside
  the container,
  `docker exec <mcp-container> deno eval 'console.log((await fetch("http://<qube-ip>:11434/v1/models")).status)'`
  should print `200`.
- **Then verify classification — transport alone isn't enough.** `/v1/models`
  proves the path, but the extractor actually POSTs `/chat/completions` with a
  strict `response_format: {type: "json_schema", …}`
  ([`server/metadata.ts`](../../server/metadata.ts)); a server can list the
  model yet reject that request shape. Under policy `off`, the capture stores a
  local stub and never calls `FALLBACK_CHAT_*`; under `alert` or `allow`, it may
  fall through to that endpoint and thought content may leave the box. Captures
  still succeed; the extractor writes a durable event and warns on every
  fallback classification. For a transport smoke test, also check the immediate
  log deliberately: capture a test thought and look for
  `[metadata] classified via primary endpoint`. Failure lines now identify the
  broad cause: `primary endpoint failed (transport/timeout)` is an availability
  signal, `primary endpoint failed (non-2xx response)` is a server or request-
  compatibility failure with the final HTTP status appended, and lines beginning
  `primary endpoint returned …` identify an invalid completion envelope,
  unparseable model output, or runtime-schema-rejected metadata. Check the model
  server's own logs for detail beyond that status or within the output-quality
  class.
- This plumbing exists only to keep content on a **loopback-only** GPU qube. A
  reachable OpenAI-compatible server (local or over the tailnet) used directly
  as `CHAT_API_BASE` needs none of it.
