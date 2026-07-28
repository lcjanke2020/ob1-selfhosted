# Offloading metadata classification to a GPU qube (qrexec ConnectTCP)

> **One configuration option among three — pick deliberately.** OB1's metadata
> extractor (`CHAT_API_BASE`) calls an OpenAI-compatible `/chat/completions`
> endpoint — any server that also supports the strict `json_schema` response
> format it sends (see the verification note at the end) — so it routes with
> equal ease to:
>
> 1. **Another machine on your network running a local LLM** (LM Studio,
>    ollama, …) — just set `CHAT_API_BASE` to its URL; no plumbing.
> 2. **Any hosted OpenAI-compatible provider** with an API key — same, plus
>    `CHAT_API_KEY`; thought content leaves your network.
> 3. **A GPU qube on the same Qubes host** whose model server is bound to
>    **loopback only** — no network-facing listener on the serving qube: no
>    tailnet/LAN bind, no sshd. This is the only option that needs the
>    plumbing below (a host-side forwarder + a qrexec `ConnectTCP` transport),
>    and it is **not a good fit for everyone**: it trades setup effort and a
>    console-only administration model for the smallest network exposure. For
>    the rationale — what the no-listener posture buys, the GPU-passthrough
>    privilege argument, and the honest tradeoffs (no sshd means no remote
>    administration without purpose-built tooling) — see
>    [Serving From a Qube With No Network-Facing Listener](https://github.com/lcjanke2020/qubes-os-explorations/blob/master/qrexec-connecttcp-service-qube.md)
>    in the qubes-os-explorations repo. This doc is the OB1-specific how-to.

```
mcp container ──(compose-bridge gateway :11434)──▶ socat  [app qube host]
                                                     └─ qubes.ConnectTCP+11434 (qrexec) ─▶ <gpu-qube> 127.0.0.1:11434
```

Placeholders below: `<app-qube>` = the qube running this compose project,
`<gpu-qube>` = the qube with the GPU + the loopback model server, `<compose-gw>`
= the gateway IP of this project's docker bridge (see step 2). `11434` is the
ollama port; substitute your server's port throughout.

---

## Degradation, disabling, re-enabling

This transport is **optional and easy to disable**. If the GPU qube becomes
unavailable, leave the safety knobs below in place — the `autostart=no` **policy
option** (step 1), with the forwarder unit left enabled and running (it has no
`autostart` setting of its own) — and OB1 degrades cleanly to its
`FALLBACK_CHAT_*` endpoint: captures keep working, and the halted qube is never
started as a side effect.
This degradation path is field-verified: with the GPU qube halted, a capture's
primary attempt fails fast (the forwarder accepts the TCP connection, the qrexec
call is refused, the connection closes — no timeout burn), the fallback
classifies in the same request, and the GPU qube stays halted. Re-enable by
starting the GPU qube; no code or config change is required (the extractor is
endpoint-agnostic). To park the transport entirely, additionally stop + disable
the forwarder unit, remove its rc.local restage lines, and drop the step-3
accept stanza from `qubes-firewall-user-script` — otherwise the firewall hook
re-adds the (now-listenerless) `:11434` accept at each boot.

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
halted target** by default, so a capture-path classification call would *boot*
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

Nothing is installed in `<gpu-qube>` for the transport itself: `qubes.ConnectTCP`
is a stock qrexec service that connects to `127.0.0.1:<port>` on the target. The
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
set -e
# Bind to THIS compose project's bridge gateway (see the gotcha below) so the
# mcp container can reach it — not docker0 / host.docker.internal.
BIND_IP="<compose-gw>"
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
binds the same port on a different address, the bridge gateway. Two sockets, two
roles; the CPU ollama keeps serving embeddings either way.)

`/rw/config/ob1-ollama-forward.service`:

```ini
[Unit]
Description=OB1 ollama forwarder (compose-gw:11434 -> <gpu-qube> via qrexec ConnectTCP)
After=docker.service qubes-network.service
Wants=docker.service
[Service]
ExecStart=/rw/config/ob1-ollama-forward.sh
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

**Gotcha — inter-bridge isolation.** A container on a *user-defined* docker
bridge (any compose project) **cannot** reach `docker0` /
`host.docker.internal` — docker isolates bridges from each other. Bind the
forwarder to the container's **own** compose-network gateway and point
`CHAT_API_BASE` there. Find the gateway:

```sh
docker network inspect <project>_default -f '{{(index .IPAM.Config 0).Gateway}}'
```

For a *stable* gateway across recreates, pin the subnet/gateway in a local,
uncommitted `docker-compose.override.yml` next to
[`app-qube/docker-compose.yml`](app-qube/docker-compose.yml) (compose
auto-merges an override that sits beside the base file; keeping it local and
uncommitted keeps your private subnet out of git):

```yaml
networks:
  default:
    ipam:
      config:
        - subnet: <your-private-/24>
          gateway: <compose-gw>
```

## 3. Qubes firewall (custom-input)

Qubes' nft `input` chain is **policy-drop**, so a container→host packet to
`:11434` is silently dropped. Add an accept to `custom-input` in
`/rw/config/qubes-firewall-user-script`, **before** its trailing `exit 0`:

```bash
# Allow docker user-defined bridges (br-*) -> host :11434 (the forwarder).
if ! nft list chain ip qubes custom-input 2>/dev/null | grep -q 'dport 11434'; then
  nft add rule ip qubes custom-input iifname "br-*" tcp dport 11434 ct state new accept
fi
```

`qubes-firewall` runs this script when its worker starts — boot or a service
restart. An ordinary firewall **reload** reapplies the QubesDB rules but does
*not* re-run the user script, so treat this as boot-time persistence (the rule,
once added, stays in the chain for the qube's uptime). Two scope caveats:

- **`br-*` matches every docker user-defined bridge on the qube**, not just this
  project's — fine on a single-purpose app qube, where the OB1 bridge is the
  only one. If the qube runs other compose projects, pin the rule to this
  project's bridge instead: give the bridge a fixed name in the override file
  (`driver_opts: {com.docker.network.bridge.name: …}` under the network) — the
  default `br-<id>` name changes whenever the network is recreated.
- **The hook only runs where the `qubes-firewall` service flag is on** (check
  `systemctl is-active qubes-firewall`); on qubes without it the script sits
  unexecuted and the rule silently never appears. The step-4 rc.local block
  mirrors the rule so those qubes get it too.

## 4. Persistence (rc.local)

`/etc/systemd` is reset from the template each boot, so restage + enable the
forwarder unit from `/rw/config` in `/rw/config/rc.local` — placed **after the
docker start** in [`app-qube/rc.local`](app-qube/rc.local)'s boot order (the
forwarder binds the compose gateway, so starting it earlier just leaves
`Restart=always` spinning until docker has created the bridge):

```bash
if [ -f /rw/config/ob1-ollama-forward.service ]; then
  cp /rw/config/ob1-ollama-forward.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now ob1-ollama-forward.service

  # Mirror of the step-3 firewall rule (idempotent) — covers qubes where the
  # qubes-firewall service flag is off and the user-script hook never runs.
  # Inside the same guard so a parked transport doesn't re-add the accept from
  # here; the step-3 stanza still does where the hook runs — remove it too when
  # parking (see the degradation section).
  if ! nft list chain ip qubes custom-input 2>/dev/null | grep -q 'dport 11434'; then
    nft add rule ip qubes custom-input iifname "br-*" tcp dport 11434 ct state new accept
  fi
fi
```

(`Restart=always` lets the unit converge once docker is up; where the
qubes-firewall hook does run, it re-applies the step-3 rule at boot as well —
this mirror just removes the service-flag dependency.)

## 5. Wire it to OB1

In the app qube's `.env`:

```dotenv
CHAT_API_BASE=http://<compose-gw>:11434/v1
CHAT_MODEL=<your-served-model>
# CHAT_API_KEY blank for a local ollama (no auth)
ENABLE_PRIMARY_EXTRACTION=true
```

Keep `FALLBACK_CHAT_*` configured so a downed GPU qube degrades to a hosted
model instead of dropping metadata. See
[`app-qube/.env.example`](app-qube/.env.example) for the full block and the
`ENABLE_PRIMARY_EXTRACTION` safety gate (off unless exactly `true`).

## 6. Host RAM on the GPU qube — size it generously

It is tempting to trim the GPU qube's memory down — "the model lives in VRAM,
the host side is just a shim". Field experience says otherwise: **an undersized
GPU qube produces exactly the silent-fallback failure class this transport
exists to prevent**, and it does so *intermittently*, which makes it expensive
to diagnose.

What actually happens (observed live: ollama 0.30 serving a ~16 GiB quantized
model from a qube pinned at 8 GiB):

- The model server's host-side process legitimately needs several GiB even with
  the weights in VRAM: load machinery, per-request state, and — on newer
  ollama — large transient allocations that arrive at *request* time (prompt-
  cache state saves approaching 1 GiB).
- ollama wants enough free host RAM to **mmap** the model file at load. Below
  that it logs `disabling mmap for llama-server load due to host memory
  pressure` and takes a heavier buffered load path — more anonymous host RAM,
  slower loads, and no page cache to make the next load cheap.
- A GPU-passthrough qube typically runs with **fixed memory** (`maxmem 0` — no
  ballooning), so nothing rescues a spike: the kernel OOM killer kills the
  server. `Restart=always` brings it back in seconds — **empty**. The resident
  model is gone, a `keep_alive=-1` pin died with the process, and nothing looks
  wrong until the next capture pays a cold load or times out into
  `FALLBACK_CHAT_*` — content off-box.

The symptom set masquerades as an eviction or keep-alive bug, which is the
trap: `/api/ps` shows the model pinned with a far-future `expires_at` on one
check and absent on the next; captures classify via primary at HH:MM and leak
via fallback at HH:MM+20. Note also that this failure **burns the full
`CHAT_TIMEOUT_MS`** when the kill lands mid-request — unlike the halted-qube
case in the degradation section above, which fails fast — because the
connection is accepted and then never answered.

**Diagnosis** (on the GPU qube; unit name per your install):

```sh
journalctl -u ollama | grep -iE "oom|killed|memory pressure"
# the two smoking guns:
#   "A process of this unit has been killed by the OOM killer" / "Failed with result 'oom-kill'"
#   "disabling mmap for llama-server load due to host memory pressure"
systemctl show ollama -p NRestarts    # restarts you didn't perform
```

**Sizing rule of thumb:** qube RAM ≥ model file size + ~4 GiB for the server
and OS — and round *up*, not down: spare RAM becomes page cache for the model
file, which makes post-restart reloads dramatically cheaper. For a ~16 GiB
model, 8 GiB is OOM roulette on every request; 24 GiB works; 32 GiB is
comfortable if the host has it. After resizing, confirm the load journal no
longer shows the mmap-disable line and the oom-kill entries stop recurring.

## 7. Keep the model resident (pre-warm at boot, re-warm on a timer)

The first request after a model (re)load pays a cold start of tens of seconds;
with a 30B-class model that can consume most of the extractor's
`CHAT_TIMEOUT_MS` budget (default 60 s) and tip a capture into the fallback.
Load the model *before* any capture arrives, and re-assert residency on a
timer so a crash or restart self-heals instead of leaking. Three files on the
GPU qube (ollama flavor; adjust for your server):

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
TimeoutStartSec=420
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

The five-minute tick bounds the window in which a crash can put a cold model
in front of a capture. Two companion settings, same qube:

- **Pin residency server-side, not per-request.** ollama's `keep_alive` is a
  *per-request* parameter: the next request that omits it resets the model's
  expiry to the server default (five minutes). A pin applied by a one-off
  probe therefore does not survive real traffic — set
  `Environment=OLLAMA_KEEP_ALIVE=-1` in a unit drop-in so every request
  inherits it.
- **Privacy note for ollama ≥ 0.30:** unless `OLLAMA_NO_CLOUD=true` is set,
  the server periodically phones ollama.com (registry / model-metadata cache
  hydration) — from the qube whose reason to exist is that content never
  leaves it. Add it to the same drop-in.

## Notes

- **Cold load / residency.** The first request after a model (re)load pays a
  cold start of tens of seconds vs a warm call; §7 wires the pre-warm + re-warm
  that keeps it off the capture path, and §6 explains why an undersized qube
  silently undoes both.
- **Know when it degrades.** Every fallback classification is a privacy event
  logged as a single line to the container's stderr that nobody reads. A small
  operator alert channel over those lines — triggers, no-content alert policy,
  a Pushover sketch — is in
  [`docs/metadata-degradation-monitoring.md`](../../docs/metadata-degradation-monitoring.md).
- **Verify the transport:** from the app-qube host, `curl http://<compose-gw>:11434/v1/models`
  (should list the model); from inside the container,
  `docker exec <mcp-container> deno eval 'console.log((await fetch("http://<compose-gw>:11434/v1/models")).status)'`
  should print `200`.
- **Then verify classification — transport alone isn't enough.** `/v1/models`
  proves the path, but the extractor actually POSTs `/chat/completions` with a
  strict `response_format: {type: "json_schema", …}`
  ([`server/metadata.ts`](../../server/metadata.ts)); a server can list the
  model yet reject that request shape, after which every capture falls through
  to `FALLBACK_CHAT_*` — thought content leaves the box, the outcome this
  transport exists to prevent. Captures still succeed and the extractor *does*
  warn on every fallback classification, but only in the container logs — so
  check them deliberately: capture a test thought and look for
  `[metadata] classified via primary endpoint`. A `primary endpoint failed`
  line followed by `classified via FALLBACK endpoint` proves only that the
  primary failed — the same line covers a rejected request shape, connectivity
  errors, timeouts, non-2xx responses, and unparseable output alike; check the
  model server's own logs to tell which.
- This plumbing exists only to keep content on a **loopback-only** GPU qube. A
  reachable OpenAI-compatible server (local or over the tailnet) used directly
  as `CHAT_API_BASE` needs none of it.
