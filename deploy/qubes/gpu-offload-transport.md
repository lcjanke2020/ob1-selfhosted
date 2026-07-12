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
                                                     └─ qrexec ConnectTCP+11434 ─▶ <gpu-qube> 127.0.0.1:11434
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
the forwarder unit and remove its rc.local restage lines.

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
host** bridges a local TCP port to the qrexec call.

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

The qubes-firewall hook re-runs this script on every firewall reload/boot, so
the rule is self-healing. Two scope caveats:

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
fi

# Mirror of the step-3 firewall rule (idempotent) — covers qubes where the
# qubes-firewall service flag is off and the user-script hook never runs.
if ! nft list chain ip qubes custom-input 2>/dev/null | grep -q 'dport 11434'; then
  nft add rule ip qubes custom-input iifname "br-*" tcp dport 11434 ct state new accept
fi
```

(`Restart=always` lets the unit converge once docker is up; wherever the
qubes-firewall hook runs, the step-3 rule also re-applies on every firewall
reload.)

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

## Notes

- **Cold load.** The first request after a model (re)load pays a cold-start of
  tens of seconds vs a warm call; pre-warm the model so the first capture after
  a load isn't slow. The extractor's `CHAT_TIMEOUT_MS` (default 60s) covers it.
- **Verify the transport:** from the app-qube host, `curl http://<compose-gw>:11434/v1/models`
  (should list the model); from inside the container,
  `docker exec <mcp-container> deno eval 'console.log((await fetch("http://<compose-gw>:11434/v1/models")).status)'`
  should print `200`.
- **Then verify classification — transport alone isn't enough.** `/v1/models`
  proves the path, but the extractor actually POSTs `/chat/completions` with a
  strict `response_format: {type: "json_schema", …}`
  ([`server/metadata.ts`](../../server/metadata.ts)); a server can list the
  model yet reject that request shape, after which every capture silently
  classifies via `FALLBACK_CHAT_*` — thought content leaves the box, the
  outcome this transport exists to prevent. Capture a test thought and check
  the mcp container logs for `[metadata] classified via primary endpoint`; a
  `primary endpoint failed` line followed by `classified via FALLBACK endpoint`
  means the primary rejected the request shape.
- This plumbing exists only to keep content on a **loopback-only** GPU qube. A
  reachable OpenAI-compatible server (local or over the tailnet) used directly
  as `CHAT_API_BASE` needs none of it.
