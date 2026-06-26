# Tailscale Funnel as a long-lived MCP perimeter

There are plenty of "how to turn Funnel on" walkthroughs. What's scarce is anyone treating Funnel as a **durable, hardened, observed public perimeter** — and specifically the combination *self-hosted MCP server + Funnel + OAuth resource server + IP allowlist + observability*. That combination is what claude.ai and Claude mobile require if you want them to reach a server on hardware you own: they connect from Anthropic's cloud, not from your device, so "tailnet-only" doesn't reach them.

This doc is the transferable half of this repo: what Funnel does and doesn't give you, and the pattern for putting any MCP server behind it. The implementation here (`Caddyfile`, `server/auth.ts`, `server/auth_audit.ts`, `db/02-observability.sql`) is a working reference.

## What Funnel doesn't give you

Each known limitation, and what this stack does about it:

| Funnel limitation | Consequence | Mitigation here |
|---|---|---|
| No native IP/ASN filtering or rate limiting (long-standing feature request) | Anyone on the internet can reach your listener | On-node allowlist of Anthropic egress (`160.79.104.0/21`) at Caddy, evaluated against the XFF-resolved client IP; 403 before the backend is touched |
| No platform-level access control — security is entirely your application's auth | A weak or missing auth layer is fully exposed | OAuth 2.1 resource-server validation (RS256, pinned issuer/audience, required `exp`) is load-bearing, not optional; the public deployment is OAuth-only — no static-key door exists, and the server ignores a presented `x-brain-key` |
| Funnel hostnames are discoverable via Certificate Transparency logs the moment the cert is minted | "Nobody knows my URL" is not a control | Neutral hostname (nothing in the name says what it serves), and the assumption that scanners arrive on day one — hence observability |
| Bandwidth caps and Let's Encrypt rate limits on a long-lived name | Availability footguns | Accepted for a personal store; monitor, don't assume |
| Forwarded headers are only as trustworthy as your proxy chain | Header spoofing / IP confusion | Trust XFF only where the port boundary guarantees the traffic came through `tailscaled`; `trusted_proxies static private_ranges` + strict mode; the `Tailscale-Funnel-Request` discriminator header is injected by tailscaled itself and is not client-controllable |
| Nothing stops a misconfigured second route to the backend | A stray `tailscale funnel` pointed at the raw backend bypasses the proxy | The backend's host port is removed by the public-facing compose override (`ports: !reset null`), so the raw port isn't published when the override is applied. The forgotten-override case (loopback-only port republished) is a consciously-accepted residual risk — a container can't detect its own host-port mapping — recorded in [security-model.md](security-model.md) |

## The transferable pattern

In dependency order — each step is independently testable:

1. **Funnel on `:443`, no other port.** Anthropic's MCP HTTP client refuses non-default-HTTPS ports (verified empirically — the connector reports "Couldn't reach the MCP server" and zero traffic ever arrives). Since `tailscale serve` and `tailscale funnel` can't both bind `:443` for one hostname, either move tailnet clients to another port (URL churn) or use a **single listener** that serves both and discriminates via the `Tailscale-Funnel-Request` header — this repo's Pattern Y.
2. **A reverse proxy in front of the backend** owning branch logic: the IP allowlist (the primary public perimeter), a body cap, and JSON access logs with credential redaction (`format filter`) — keep the redaction or you *will* log secrets. (Credentials don't need per-branch stripping when the server accepts only one door per deployment; redaction at the log layer still applies.)
3. **OAuth provider setup.** Confidential client (Authorization Code + refresh), RS256, API Identifier exactly equal to the public MCP URL — protocol, host, path, no port. Register the client at claude.ai's custom-connector Advanced settings with client_id + client_secret.
4. **JWT verification on the server** with pinned `issuer`, `audience`, `algorithms`, and `requiredClaims: ["exp"]` (plus `sub` if you stamp provenance). Add a boot-time JWKS reachability probe with an explicit timeout — a typo'd JWKS URI should fail the deploy, not the first real request.
5. **HTTP 401 + RFC 6750 `WWW-Authenticate` (with `resource_metadata`) on *missing* credentials.** This is what unblocks claude.ai's OAuth discovery; without it the connector loops forever never finding your authorization server. Keep *invalid*-credential responses on the JSON-RPC error envelope so established transports aren't torn down.
6. **An RFC 9728 `/.well-known/oauth-protected-resource/<path>` endpoint** pointing at your issuer and resource URL.
7. **Source-marker on every write** (`door` = which auth path, `sub` = verified JWT subject). Trivial code, large analytic payoff — it's how you distinguish mobile/cloud writes from tailnet writes forever after.
8. **An auth audit table** recording `(ts, reason, middleware, client_ip, path)` per failure. Proxy logs only see the 401 status; the reason code is the difference between "I fat-fingered the key" and "someone is probing".
9. **An alert-only monitor** over that table, filtering out `missing_credentials` (it's the expected first event of every OAuth dance, not an attack signal). Alert-only beats auto-shutoff: an auto-response with a subtly wrong command silently no-ops exactly when you need it.

## Failure-mode catalog

Observed in production, with diagnosis paths — the hours these cost are the reason this section exists.

### "Authorization with the MCP server failed" right after a successful consent screen

The token exchange between claude.ai and your OAuth provider is failing — the user-facing consent succeeded, then the backchannel `client_secret` check didn't. In Auth0's logs this shows as a `Failed Exchange` with `description: Unauthorized` and `client_name: null` a few hundred ms after a `Success Login`. Cause is almost always a copy-paste mismatch in the secret stored at claude.ai. **Your server sees nothing** — the failure happens before any Bearer reaches it; the audit table shows only the initial `missing_credentials` probe. Fix: re-paste the secret (or rotate it to eliminate ambiguity). False leads: changing the application type, grant types, or callback URLs.

### "Couldn't reach the MCP server", instantly, with zero traffic at the proxy

You put Funnel on a non-`:443` port. Anthropic's client refuses it. Move Funnel to `:443` (see pattern step 1).

### Backend container exits at boot with `Requires env access to "<VAR>"`

Deno's `--allow-env` allowlist in the Dockerfile drifted behind a new `Deno.env.get` in code. Hand-maintained lists always drift — this repo ships a static checker (`deno task check-allow-env`) wired into CI so the drift is caught at PR time.

### Tailnet door dies with `-32000`, Funnel keeps working

The tailnet door runs `mcp-remote` locally; the Funnel door doesn't. Current `mcp-remote` requires **Node 20+** (its bundled `undici` references the `File` global at module load — Node < 20 throws `ReferenceError: File is not defined` before JSON-RPC starts). Run the configured command by hand and read stderr; `node --version` confirms. Repointing `command` at a newer `npx` is **not** enough — the `#!/usr/bin/env node` shebang re-resolves from PATH; prepend a Node 20+ bin dir instead. The server is healthy the whole time — don't debug the wrong end.

### Timer-based monitoring silently stops (Qubes)

Idle app qubes get suspended, and user-level systemd units don't run without an open session unless linger is enabled. Check `loginctl show-user user | grep Linger` and `systemctl --user is-enabled <timer>` before suspecting the monitor script. Details in the [Qubes runbook](../deploy/qubes/README.md).

## What a quiet endpoint actually sees

The observability stack exists partly to answer a question the community mostly hand-waves: *what is the scan/attack baseline for an anonymous `.ts.net` Funnel endpoint?* The daily `funnel_access_summary` rollup (requests, unique IPs, status classes, top paths/UAs, p50/p95) accumulates exactly that, with non-Anthropic funnel traffic 403'd-and-logged as the scan baseline. Run it for a few months and you have data instead of folklore.
