# Connecting Codex to an OAuth deployment

The [tailnet/Funnel](../deploy/compose-tailnet/README.md) and [Qubes](../deploy/qubes/README.md)
install paths are **OAuth-only** — no static `x-brain-key` on the public door. The
[compose-tailnet runbook](../deploy/compose-tailnet/README.md#connect-claudeai--claude-mobile)
covers connecting **claude.ai / Claude mobile** (a confidential client, `client_id` + `client_secret`
pasted into a custom connector). This doc covers the other client we run: a **local
[Codex](https://developers.openai.com/codex/) CLI** wired up as an OAuth-only client, using a
**public PKCE client with no secret**.

The procedure below registers a local Codex process as an OpenBrain client over OAuth. It
deliberately configures **no** `x-brain-key`, **no** bearer-token environment variable, and **no**
client secret — initial authorization, credential reuse across fresh sessions, tool discovery, and
session capture all ride on the OAuth flow. The DCR route was verified on 2026-07-11 and the
preferred pre-registered Native route, including refresh-token issuance and an 11-tool MCP listing,
was verified on 2026-07-12 with **Codex CLI 0.144.1** on tailnet-connected Linux/WSL hosts.

> **Scope: Auth0, as we run it today.** This documents the one OAuth provider and flow this project
> actually operates — **Auth0**, with a Native/public PKCE client. The server isn't Auth0-specific:
> it validates RS256 JWTs against the single issuer and audience *you* configure
> ([funnel-mcp-perimeter.md](funnel-mcp-perimeter.md)), and Codex speaks standard OAuth 2.1 +
> PKCE, so other OIDC providers and other registration flows almost certainly work — we just don't
> run them, so we can't document them firsthand. **If you wire Codex to another provider or flow and
> want to contribute it back, a PR is welcome.**

> **Honest caveat.** Unlike a shared static key, this is a **one-time setup per Codex account, per
> machine**: each host authorizes its own client and holds its own credentials. That's the price of
> per-identity OAuth provenance; it doesn't fan out across a fleet as cleanly as copying one bearer
> token.

## Boundaries

- This covers a **locally running Codex process** that can already reach the deployment's `.ts.net`
  MCP URL. On a tailnet-connected host, MagicDNS resolves that hostname to the server's private
  tailnet address, so the request lands on Caddy's `@tailnet` branch even though the same hostname
  is also published through Funnel. OAuth still terminates at the provider, and the server still
  validates issuer, audience, signature, and expiry — the tailnet path is not an auth bypass, just a
  different network route to the same door.
- Header forwarding is transport behavior, not auth acceptance. Caddy forwards `Authorization` (and
  `X-Brain-Key`) on both allowed branches; the **server** decides which doors a deployment enables.
  An OAuth-only deployment leaves `MCP_ACCESS_KEY` unset, so a forwarded `X-Brain-Key` is ignored —
  see [security-model.md](security-model.md).
- This does **not** authorize cloud-hosted Codex workers. Keep public cloud ingress disabled until
  the OAuth path and an automated source-range control are independently verified. If you ever do
  allowlist a cloud provider's egress, **source the CIDRs from that provider's official published
  feed and keep them current** — the hazard is a stale, hand-copied list, not the allowlist pattern
  itself (the Funnel edge already allowlists Anthropic's published egress range in the Caddyfile the
  same way).
- Never put access tokens, refresh tokens, authorization codes, client secrets, or the contents of
  Codex's OAuth credential store into git, issue comments, shell transcripts, or test artifacts.

## Prerequisites

1. Confirm the protected resource is healthy and advertises the expected issuer:

   ```bash
   curl -i https://homebox.tailnet-name.ts.net/mcp
   curl -sS https://homebox.tailnet-name.ts.net/.well-known/oauth-protected-resource/mcp
   ```

   The first should return `401` with a `WWW-Authenticate: Bearer` challenge; the second should name
   the exact MCP URL as `resource` and your Auth0 tenant as its authorization server. When OpenBrain
   has no resource-specific scopes, the metadata must **omit** `scopes_supported`; RFC 9728 forbids
   publishing a metadata parameter with zero values, and an empty array can suppress the client's
   configured OIDC scopes.

2. Use a Codex release whose CLI exposes `--oauth-client-id` (and `--oauth-resource`) on
   `codex mcp add`:

   ```bash
   codex --version
   codex mcp add --help
   ```

   The preferred route below uses `--oauth-client-id`. `--oauth-resource` availability is really a
   version proxy for an OAuth-capable MCP implementation — don't pass the flag when protected-resource
   discovery already supplies the exact resource (see the troubleshooting note on double `resource`
   parameters). `mcp_oauth_callback_port` is a top-level config key, so it won't appear in this
   subcommand help; confirm your release lists it in the
   [Codex config reference](https://developers.openai.com/codex/config-reference).

3. In **Auth0 Dashboard → Settings → Advanced**, enable **Resource Parameter Compatibility Profile**
   so Auth0 treats the standards-based OAuth `resource` parameter as the API audience.

4. In the OpenBrain **Auth0 API → Settings**, enable **Allow Offline Access**. Auth0 returns a refresh
   token only when the API permits offline access, the client permits the `refresh_token` grant, and
   the authorization request includes the `offline_access` scope.

## Choose a client-registration route

### Preferred — pre-registered Native (public PKCE) client

Create an Auth0 **Application** with:

- Type **Native**, Token Endpoint Authentication Method **None**, **no client secret**.
- Grants: **Authorization Code + PKCE** and **Refresh Token**.
- The intended Database / Social / Enterprise login connection enabled **for this application only**.

Create a separate application for Codex rather than repurposing a Claude custom-connector
application: the latter is normally a confidential Regular Web Application that authenticates with
a client secret, while local Codex is a public client that cannot safely hold one. Copy the value
explicitly labeled **Client ID** from the Native application's Settings page, not Auth0's
24-character internal Application ID, and never configure Codex with a Client Secret.

Use its **public client ID** with Codex and register the exact fixed loopback callback described
below. This route needs **no DCR** and **no Domain-Level connection** promotion. See Auth0's
[public-application guidance](https://auth0.com/docs/get-started/applications/confidential-and-public-applications).

> This is the preferred and live-validated route. It keeps the Codex callback, revocation, consent,
> and audit boundary separate from confidential clients while requiring no DCR window or
> Domain-Level connection promotion.

### Validated fallback — temporary DCR

Only when a pre-registered client isn't available. Before registration: set the OpenBrain API's
default third-party permissions to the minimum OpenBrain needs, promote the login connection to
**Domain Level**, then temporarily enable **Dynamic Client Registration (DCR)**. Run Codex *without*
`--oauth-client-id`, then **disable DCR immediately after login**.

> Open DCR lets anyone register a third-party application during that window, and the Domain-Level
> promotion persistently exposes the connection to third-party apps — so treat both as deliberate,
> time-boxed changes. Existing DCR-created clients and their refresh tokens keep working after DCR is
> turned back off. If Auth0 shows only a generic `Oops!, something went wrong` page, check
> **Monitoring → Logs**: strict third-party clients enable Open Redirect Protection by default and
> intentionally hide the underlying authorization error from the browser.

## Configure and log in

For the preferred route, pick an unused fixed loopback port and put it at the **top level** of
`~/.codex/config.toml`, before any `[table]` (top-level keys after a table header get assigned to
that table):

```toml
mcp_oauth_callback_port = 4321
# On headless Linux/WSL without a usable Secret Service/keyring:
mcp_oauth_credentials_store = "file"
```

Codex appends a deterministic, server-specific callback ID, so the final URI looks like
`http://127.0.0.1:4321/callback/<server-specific-id>` (see the
[Codex MCP docs](https://developers.openai.com/codex/mcp/)). Keeping the port fixed makes that
derived callback stable on every host that uses the same MCP URL. Add the server with the Native
application's **public client ID** — no client secret, and no redundant `--oauth-resource`:

```bash
codex mcp add openbrain \
  --url https://homebox.tailnet-name.ts.net/mcp \
  --oauth-client-id <oauth-native-client-id>
```

Add the refresh-capable OIDC scopes to the server entry that command created:

```toml
[mcp_servers.openbrain]
url = "https://homebox.tailnet-name.ts.net/mcp"
scopes = ["openid", "offline_access"]
```

OpenBrain currently has no resource-specific authorization scopes, so its protected-resource
metadata omits `scopes_supported` and Codex uses these configured scopes. Do not publish
`scopes_supported = []`: besides violating RFC 9728's zero-value rule, Codex 0.144.1 can persist an
empty granted scope and receive no refresh token from that flow.

`codex mcp add` only writes the server entry — it does **not** start OAuth. Begin the flow
explicitly:

```bash
codex mcp login openbrain
```

That prints an authorization URL (and tries to open a browser). Read **only** its decoded
`redirect_uri`, add that **exact full URI** to the Auth0 Native application's **Allowed Callback
URLs**, then press **Ctrl-C** to stop this first login and release the fixed callback port. Only
after that process exits, run `codex mcp login openbrain` **again** to complete authorization. (If
your Codex build happens to surface the authorization URL at `codex mcp add` time, the same
`redirect_uri` applies — the two-step `add` → `login` sequence is robust either way.)

> Don't paste the full authorization URL into issues or docs — it also carries transient OAuth
> `state` and PKCE values.

On headless or remote WSL, Codex may print the URL without opening a Windows browser. Keep the login
process running and open the **exact current URL** from a local WSL/Windows session; Windows can
normally reach WSL2's `127.0.0.1` listener through localhost forwarding. Do not reuse a URL from a
canceled attempt. If an agent harness hides the URL, hand it off through an owner-only (`0600`)
temporary file and delete that file immediately after the callback; never relay it through chat,
issues, logs, or a committed artifact.

For the **temporary-DCR fallback**, complete its Auth0 prerequisites first, omit `--oauth-client-id`,
and let Codex register the public PKCE client:

```bash
codex mcp add openbrain \
  --url https://homebox.tailnet-name.ts.net/mcp
```

As with the preferred route, add `scopes = ["openid", "offline_access"]` to the generated server
entry, then start login explicitly with `codex mcp login openbrain`.

Codex derives `resource` from protected-resource discovery. Supplying the same value again in
`oauth_resource` makes Codex 0.144.1 emit **two** `resource` parameters, which Auth0 may reject with
a generic error page.

### Confirm the transport carries no static credentials

If a prior attempt already added the server, don't add a second entry — confirm the existing one:

```bash
codex mcp get openbrain
```

Codex 0.144.1 omits OAuth fields from `mcp get`, so use that output only to check the transport, and
require every static-credential source to be **absent**: no bearer-token env var, empty
`http_headers`, empty `env_http_headers` (OpenBrain needs no non-credential headers). For the
preferred route, inspect the public client ID in `config.toml` without reading the credential store:

```bash
rg -n -A 3 '^\[mcp_servers\.openbrain\]$|^\[mcp_servers\.openbrain\.oauth\]$' \
  ~/.codex/config.toml
```

You should see `scopes = ["openid", "offline_access"]` on the server and
`client_id = "<oauth-native-client-id>"` in its OAuth table. A client ID is public, not a secret.

If login was canceled or failed after the entry was added, retry it:

```bash
codex mcp login openbrain
```

Complete login and consent in the browser. The pre-registered route needs no Auth0 toggle afterward.
For the DCR fallback, return to **Settings → Advanced**, disable DCR, and save — but **don't delete**
the generated `Codex` third-party application; that registration is what permits later authorization
and refresh without reopening DCR.

Codex stores MCP OAuth credentials outside `config.toml`. On Linux without a usable
Secret Service/keyring, set `mcp_oauth_credentials_store = "file"` explicitly as shown above; Codex
then uses `~/.codex/.credentials.json`. Confirm that file is owner-only (`0600`) **without printing
it**:

```bash
stat -c '%a %U:%G %n' ~/.codex/.credentials.json
```

## Skill and process-restart discovery

Install the canonical session workflow as a personal skill by **symlink**, rather than copying it and
creating a second source of truth:

```bash
mkdir -p ~/.codex/skills
ln -s /path/to/ob1-selfhosted/skills/session-tracker ~/.codex/skills/session-tracker
```

Adjust the source path to wherever your `ob1-selfhosted` checkout lives; if the link already resolves
there, leave it. Restart the Codex CLI process after adding the MCP server or skill; resuming the same
conversation in that new process is sufficient. Confirm `session-tracker` is listed and that
OpenBrain exposes the `session_*` tools (capture, lookup, search, list, status-update) before
importing anything. See
[`skills/session-tracker/SKILL.md`](../skills/session-tracker/SKILL.md) for the usage contract.

## Smoke test and staged-session import

1. Run a read-only `session_search` or `session_lookup`.
2. Submit the complete `+++`-delimited TOML staging payload to `session_capture`.
3. **Record the integer `id`** the server returns, back into your local staging payload. Never invent
   an ID, and never re-capture without the returned ID — omission creates a duplicate row.
4. Look the ID up and verify title, branch, summary, next actions, blockers, and artifacts.
5. Re-submit the same payload **including `id`**; success must report an *update*, not a second record.

Server-side provenance should show the OAuth door and a non-null subject. Run this read-only query as
the `openbrain_readonly` role against your OB1 Postgres — reach it however your install path does
(e.g. `docker compose exec -T postgres psql -U openbrain_readonly -d openbrain` from a compose
deployment directory, or `psql` directly on the Qubes db qube). The similarly named
[thought-capture check](../deploy/compose-tailnet/README.md#observability-pattern-b) reads a
different store and does **not** verify `session_capture`:

```sql
SELECT id, title, source, source_node, updated_at
FROM sessions.session
WHERE id = <session-id>;
```

`source = 'funnel'` here is an **authentication-door** label, not a proof of network path: every
verified Auth0 bearer gets `door = 'funnel'` in request context, which `session_capture` persists as
`source` (with the JWT subject in `source_node`). It does **not** mean Caddy handled the request on
its public `@anthropic_funnel` branch — a local tailnet client is expected to reach the door through
`@tailnet` (bypassing the Anthropic CIDR matcher) while still needing a valid token. To determine the
actual network path, compare Caddy's `tailnet-access.log` vs `funnel-access.log`; a request forced
through the hostname's **public** Funnel IPs from a non-Anthropic source must return `403`. The
header-discrimination model is in [funnel-mcp-perimeter.md](funnel-mcp-perimeter.md).

## Restart and refresh verification

Close and restart the Codex CLI process, then repeat a read-only lookup. Resuming the same conversation
is sufficient; a brand-new conversation is not required because the new process reloads MCP
configuration and tools. This proves persisted credential and tool-discovery behavior, but **not**
refresh-token renewal on its own. For renewal:
wait until the access token has expired (or use a shortened Auth0 test lifetime), leave the refresh
token intact, then look up again. After the old access token expires and Codex silently renews,
confirm a **`sertft`** event (successful exchange of Refresh Token for Access Token; see Auth0's
[log-event codes](https://auth0.com/docs/deploy-monitor/logs/log-event-type-codes)) for this client
in **Monitoring → Logs**. That event plus a successful lookup with no browser reauthorization is the
proof. `mcp_auth_events` records auth *failures*, not successful validations, so an empty failure log
is not the refresh signal. Restore the normal access-token lifetime after any shortened test.

> Don't use `codex mcp logout` to test renewal — logout clears the stored credentials and tests
> *reauthorization*, not refresh. And never print or decode the credential store to inspect expiry.

## Troubleshooting

- **`dynamic client registration is disabled`** — the server entry has no OAuth client ID, so Codex
  is attempting DCR. Prefer a pre-registered Native client with `--oauth-client-id`; if you're
  deliberately using the DCR fallback, enable DCR, retry login, then disable it.
- **Browser login succeeds but MCP returns 401 / audience mismatch** — confirm Resource Parameter
  Compatibility Profile is enabled and the protected-resource `resource` exactly equals the Auth0 API
  identifier. Remove a redundant configured `oauth_resource` if the authorization URL contains
  `resource` twice.
- **Auth0 shows only `Oops!, something went wrong`** — inspect Monitoring → Logs for the real event.
  For a pre-registered client, confirm the exact full callback and that the login connection is
  enabled on that application. For a DCR client, `no connections enabled for the client` means the
  login connection wasn't promoted to Domain Level. Open Redirect Protection hides this in the browser.
- **Auth0 log says `Missing required parameter: response_type` with `qs: {}`** — the browser opened
  only the tenant URL, not the full authorization URL — a wrapped or line-broken copy from the
  terminal can drop the query string entirely. Reopen the exact, single-line URL from the current
  login attempt. On headless/remote WSL, use the owner-only temporary-file handoff above rather than
  a wrapped chat link, and delete it immediately after the callback.
- **No refresh token / browser login required after expiry** — confirm the deployed protected-resource
  metadata omits (rather than emptily advertises) `scopes_supported`, the Codex server entry requests
  `openid` + `offline_access`, the Auth0 API enables Allow Offline Access, the application permits the
  `refresh_token` grant, and the refresh-token policy hasn't expired or been revoked. An existing
  access-only credential must be reauthorized once after correcting those settings.
- **Current thread has no OpenBrain tools** — restart the Codex CLI so it reloads MCP configuration;
  resuming the same conversation is sufficient. Then confirm the personal skill symlink resolves.
- **Logout says it failed to delete OAuth tokens from the keyring** — on headless Linux/WSL, set the
  top-level `mcp_oauth_credentials_store = "file"` and retry. If changing config is undesirable, use
  `codex mcp logout -c 'mcp_oauth_credentials_store="file"' openbrain` for that operation.
- **`Address already in use` during callback** — another process owns Codex's selected loopback port.
  Stop the stale login or pick another fixed port, update Auth0's exact callback URL, and retry; never
  expose the callback listener on a non-loopback address.
- **DCR client has no API access** — under Auth0's strict third-party security mode, set the OpenBrain
  API's default third-party permissions (at the minimum OpenBrain requires) before registering a new
  DCR client.
