# Offloading metadata classification to a GPU qube (qrexec ConnectTCP)

> **One configuration option among three — pick deliberately.** OB1's metadata
> extractor (`CHAT_API_BASE`) calls any OpenAI-compatible `/chat/completions`
> endpoint, so it routes with equal ease to:
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
unavailable, leave the safety knobs below in place (`autostart=no` on the policy
+ the forwarder) and OB1 degrades cleanly to its `FALLBACK_CHAT_*` endpoint —
captures keep working, and the halted qube is never started as a side effect.
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

Validate after editing (in dom0):

```sh
qubesctl --version >/dev/null  # any dom0 op; or:
python3 -c "from qrexec.policy.parser import FilePolicy; import pathlib; FilePolicy(policy_path=pathlib.Path('/etc/qubes/policy.d')); print('OK')"
```

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
uncommitted `docker-compose.override.yml` (keeps your private subnet out of
git — compose auto-merges it):

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
the rule is self-healing.

## 4. Persistence (rc.local)

`/etc/systemd` is reset from the template each boot, so restage + enable the
forwarder unit from `/rw/config` in `/rw/config/rc.local`:

```bash
if [ -f /rw/config/ob1-ollama-forward.service ]; then
  cp /rw/config/ob1-ollama-forward.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now ob1-ollama-forward.service
fi
```

(`Restart=always` lets the unit converge once docker is up; the step-3 firewall
rule re-applies via the firewall hook.)

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
- **Verify end to end:** from the app-qube host, `curl http://<compose-gw>:11434/v1/models`
  (should list the model); from inside the container,
  `docker exec <mcp-container> deno eval 'console.log((await fetch("http://<compose-gw>:11434/v1/models")).status)'`
  should print `200`.
- This plumbing exists only to keep content on a **loopback-only** GPU qube. A
  reachable OpenAI-compatible server (local or over the tailnet) used directly
  as `CHAT_API_BASE` needs none of it.
