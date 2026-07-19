# Connecting Kimi Code to an OAuth deployment

The [tailnet/Funnel](../deploy/compose-tailnet/README.md) and [Qubes](../deploy/qubes/README.md)
install paths are **OAuth-only** — no static `x-brain-key` on the public door. The
[compose-tailnet runbook](../deploy/compose-tailnet/README.md#connect-claudeai--claude-mobile)
covers connecting **claude.ai / Claude mobile** (a confidential client), and
[codex-oauth-client.md](codex-oauth-client.md) covers a local **Codex CLI** (a public PKCE client
with a pre-registered client ID). This doc covers a third client shape: a local
[Kimi Code](https://www.kimi.com/code) CLI, which is **also a public PKCE client — but one that
registers exclusively through Dynamic Client Registration (DCR)**.

Kimi Code's MCP server configuration (`mcp.json`) has no field for a pre-registered OAuth client ID
(as of CLI 0.27.0 — the HTTP-server fields are `url`, `auth`, `bearerTokenEnvVar`, headers, and
tool/timeout options only), and its OAuth flow requires the authorization server to advertise a
`registration_endpoint`. The pre-registered Native-client route that is *preferred* for Codex is
therefore **not available** here: the time-boxed DCR procedure is the only route, and every new
Kimi Code host needs it. If a future Kimi Code release adds a static client-ID option, prefer the
pre-registered route from the Codex doc instead.

The procedure below was verified end-to-end on **2026-07-19** with **Kimi Code CLI 0.27.0** on a
tailnet-connected Linux host: OAuth login, the 11-tool MCP listing, read-only `session_*` calls,
and a refresh token persisted in the credential store.

> **Scope: Auth0, as we run it today.** Same caveat as the Codex doc — this documents the one
> provider and flow this project operates (Auth0, public PKCE clients). Kimi Code speaks standard
> OAuth 2.1 + PKCE + RFC 7591 DCR, so other OIDC providers almost certainly work — we just don't
> run them.

> **Never put access tokens, refresh tokens, authorization codes, client secrets, or the contents
> of the credential store into git, issue comments, shell transcripts, or test artifacts.**

## Boundaries

- Same as the Codex doc: this covers a **locally running Kimi Code process** that can already reach
  the deployment's `.ts.net` MCP URL. On a tailnet-connected host, MagicDNS resolves that hostname
  to the server's private tailnet address; OAuth still terminates at the provider, and the tailnet
  path is not an auth bypass. Header forwarding is transport behavior; the **server** decides which
  doors a deployment enables — an OAuth-only deployment ignores `X-Brain-Key` entirely.
- This does **not** authorize cloud-hosted agent workers. Keep public cloud ingress disabled.
- Kimi Code supports `bearerTokenEnvVar` for HTTP MCP servers — it is **not** an alternative here,
  because this deployment enables no static-key door.

## Prerequisites

1. Confirm the protected resource is healthy and advertises the expected issuer (same checks as the
   Codex doc):

   ```bash
   curl -i https://homebox.tailnet-name.ts.net/mcp
   curl -sS https://homebox.tailnet-name.ts.net/.well-known/oauth-protected-resource/mcp
   ```

   The first returns `401` with a `WWW-Authenticate: Bearer` challenge; the second names the exact
   MCP URL as `resource` and your Auth0 tenant as its authorization server.

2. Confirm the authorization server advertises DCR — Kimi Code hard-fails with
   `Incompatible auth server: does not support dynamic client registration` if the issuer metadata
   lacks a registration endpoint:

   ```bash
   curl -sS https://<your-tenant>.auth0.com/.well-known/openid-configuration | grep registration_endpoint
   ```

   An advertised endpoint does **not** mean DCR is *enabled* — see the probe trap in
   [Troubleshooting](#troubleshooting). The actual toggle check is the login attempt itself.

## Enable the DCR window (operator step)

Kimi Code cannot use a pre-registered client, so open a **time-boxed** DCR window before login —
the same procedure the Codex doc documents as its fallback:

1. In the OpenBrain **Auth0 API → Settings**, set the **default third-party permissions** to the
   minimum OpenBrain needs (DCR-registered clients are third-party under Auth0's strict mode).
2. Promote the login connection to **Domain Level** — otherwise the DCR-registered client fails
   with `no connections enabled for the client`.
3. Enable **Dynamic Client Registration** (tenant **Settings → Advanced**).

Plan to disable DCR **immediately after** the login completes. Open DCR lets anyone register a
third-party application against your tenant during that window, while the Domain-Level login
connection remains available to third-party applications after DCR is disabled. Treat both as
deliberate exposure. The registered client and its refresh token keep working after DCR is off —
**do not delete** the newly DCR-created application (normally `kimi-code (<server-name>)`, which is
`kimi-code (openbrain)` for the entry below); deleting it forces re-registration through another
DCR window. Because Kimi Code has no pre-registered route, each *additional* Kimi Code host needs
this window opened again.

## Configure and log in

Add the server to the user-level `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json` when
`KIMI_CODE_HOME` is set):

```json
{
  "mcpServers": {
    "openbrain": {
      "url": "https://homebox.tailnet-name.ts.net/mcp",
      "auth": "oauth"
    }
  }
}
```

`auth: "oauth"` marks the server for the OAuth login flow. No scopes field exists. Against this
deployment, the observed flow returned `offline_access` and stored a refresh token, so no additional
scope configuration was needed in Kimi Code 0.27.0.

**MCP servers load at process start.** Restart the CLI after editing `mcp.json` — resuming the
previous session (`kimi resume`) is sufficient; a brand-new conversation is not required. The new
process shows the server in needs-auth state.

Start the login from the TUI:

```
/mcp-config login openbrain
```

(An agent inside the session can run the same flow via the server's `authenticate` tool.) The flow
starts a callback server on a random `127.0.0.1` port, registers the client over DCR, prints the
Auth0 authorization URL, and blocks up to 15 minutes for the callback. Complete login/consent in a
browser on the Kimi host. To use a browser on another machine, leave the login running, read
`<port>` from the current URL's `redirect_uri` (`http://127.0.0.1:<port>/callback`), and start
this local forward on the browser machine before opening that exact URL:

```bash
ssh -N -L <port>:127.0.0.1:<port> <user>@<kimi-host>
```

The browser's callback to its own `127.0.0.1:<port>` then traverses the tunnel to the Kimi host. If
the URL must leave the terminal, hand it off through an owner-only (`0600`) temporary file and
delete it after the callback — never relay it through chat, issues, logs, or a committed artifact.

Then disable DCR in Auth0 (keep the registered application).

## Credential store

Kimi Code stores MCP OAuth material under `~/.kimi-code/credentials/mcp/` as three files per
server — `<server>-<hash>-client.json` (the DCR registration), `-discovery.json` (cached AS +
resource metadata), and `-tokens.json`. Confirm owner-only permissions **without printing them**:

```bash
stat -c '%a %U:%G %n' ~/.kimi-code/credentials/mcp/openbrain-*
```

Expect `600` throughout. The tokens file should contain a `refresh_token` key (a keys-only check
with `jq 'keys'` is safe; do not print values).

## Skill and process-restart discovery

Install the canonical session workflow as a personal skill by **symlink**, rather than copying it
and creating a second source of truth:

```bash
mkdir -p ~/.kimi-code/skills
ln -s /path/to/ob1-selfhosted/skills/session-tracker ~/.kimi-code/skills/session-tracker
```

Kimi Code scans `$KIMI_CODE_HOME/skills/` (default `~/.kimi-code/skills/`) and `~/.agents/skills/`
at user scope; the latter is shared across agent tools. Restart the CLI after adding the server or
skill; resuming the same conversation is sufficient. Confirm `session-tracker` is listed and that
OpenBrain exposes the `session_*` tools (capture, lookup, search, list, status-update). See
[`skills/session-tracker/SKILL.md`](../skills/session-tracker/SKILL.md) for the usage contract.

## Smoke test and staged-session import

Same as the Codex doc: read-only `session_search`/`session_lookup` first, then the full
`+++`-delimited TOML staging payload to `session_capture`, **recording the returned integer `id`**
back into the payload (omission on re-capture mints a duplicate), and verifying the round-trip
reports an *update*. Server-side provenance should show `source = 'funnel'` with a non-null
`source_node` (the JWT subject) — an authentication-door label, not a network-path claim; the
tailnet client is expected to arrive via Caddy's `@tailnet` branch. The SQL check and the
Caddy-log path discrimination are in [codex-oauth-client.md](codex-oauth-client.md#smoke-test-and-staged-session-import).

## Restart and refresh verification

Restart the CLI (resume is fine) and repeat a read-only lookup — this proves persisted credentials
and tool discovery. For refresh renewal: after the access token expires, look up again with no
browser step, then confirm a **`sertft`** event for this client in Auth0 **Monitoring → Logs**.
That event plus a successful lookup is the proof. Do not log out to test renewal — logout clears
the stored credentials and tests *reauthorization*, not refresh.

## Troubleshooting

- **Login fails with `failed to start OAuth flow for "<server>":` and an empty detail** — the most
  likely cause is **DCR disabled** at the tenant. Kimi Code 0.27.0 swallows the authorization
  server's error body (`dynamic client registration is disabled`) instead of surfacing it. Enable
  the DCR window and retry.
- **Probe trap: DCR looks open when it isn't.** Auth0's registration endpoint validates the request
  payload *before* checking whether DCR is enabled, so a probe with a malformed `redirect_uris`
  gets a `400` validation error even with DCR off — only a well-formed request gets the real
  `dynamic client registration is disabled`. Don't conclude the window is open from a validation
  error.
- **`Incompatible auth server: does not support dynamic client registration`** — the issuer
  metadata has no registration endpoint at all. There is no Kimi Code workaround; the AS must
  support DCR (or a future Kimi Code must grow a static client-ID option).
- **Browser login succeeds but MCP returns 401 / audience mismatch** — confirm Auth0's **Resource
  Parameter Compatibility Profile** is enabled and the protected-resource `resource` exactly equals
  the Auth0 API identifier (same as the Codex doc).
- **`no connections enabled for the client` during login** — the login connection wasn't promoted
  to Domain Level for third-party clients.
- **No refresh token / browser login required after expiry** — not expected against this
  deployment (verified to issue one), but if it regresses: confirm the Auth0 API still enables
  **Allow Offline Access**, the application permits the `refresh_token` grant, and the refresh
  token hasn't been revoked or expired by policy. An access-only credential must be reauthorized
  once after correcting those settings.
- **Current session has no OpenBrain tools** — restart the CLI so it reloads `mcp.json`; resuming
  the same conversation is sufficient. Then confirm the personal skill symlink resolves.
- **`Address already in use` while starting the SSH forward** — another process owns that port on
  the browser machine. The local forwarding port must match the current `redirect_uri`, so stop the
  login, start a new one to obtain another random callback port, and build the forward from the new
  authorization URL.
