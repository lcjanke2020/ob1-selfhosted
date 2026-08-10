# OAuth service accounts (client credentials)

Open Brain accepts unattended agents through the same OAuth resource-server door
used by interactive clients. A service account obtains a short-lived JWT with
the OAuth 2.0 `client_credentials` grant, sends it as a Bearer token, and
performs MCP or REST calls without a browser or human login.

This is OAuth, not an interactive OpenID Connect login: there is no user,
authorization code, consent screen, refresh token, or `openid` scope in the
machine flow. The configured enterprise issuer and JWKS still provide the signed
access-token trust boundary.

## Identity and provenance contract

Authentication remains unchanged. Open Brain accepts only an RS256 JWT whose
signature, issuer, audience, expiration, and `sub` pass the existing checks. The
subject must be a non-empty string of at most 1,024 characters with no control
characters. A machine identity does not introduce another credential verifier or
bypass authorization.

After verification, the server assigns one of three provenance labels:

| `door` label | Verified credential class      | Principal                                     |
| ------------ | ------------------------------ | --------------------------------------------- |
| `funnel`     | OAuth user token               | verified JWT `sub`                            |
| `service`    | OAuth client-credentials token | verified JWT `sub`                            |
| `tailnet`    | native/static `x-brain-key`    | configured deployment-wide principal, or none |

The historical `funnel` and `tailnet` names are compatibility labels, not proof
of the Caddy network route. A service-account request normally arrives through
the private tailnet branch but is stamped `service` because its credential is a
machine JWT.

Auth0's **default Auth0 access-token profile** includes the signed
`gty=client-credentials` claim on M2M tokens, which Open Brain recognizes
automatically. Auth0's selectable **RFC 9068 profile does not use `gty`**; it
uses `client_id` instead, and therefore needs the same exact-subject mapping as
a generic issuer. See Auth0's
[access-token profile comparison](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles).
The OAuth access-token standard does not define a universal grant-type claim, so
any token profile without `gty` needs an exact, operator-controlled subject
mapping:

```dotenv
OAUTH_SERVICE_ACCOUNT_SUBJECTS=scheduled-capture-client,search-indexer-client
```

Whitespace around comma-separated entries is trimmed; matching remains exact and
case-sensitive. Empty entries, duplicates, control characters, more than 256
subjects, and subjects longer than 1,024 characters fail at boot. The setting
requires the OAuth door. It changes attribution only: listing a subject does not
make an invalid token valid and does not broaden its memory scope.

> **Attribution is not authorization.** Every OAuth subject — machine subjects
> included — must ALSO appear in `OAUTH_ALLOWED_SUBJECTS`, the fail-closed
> in-app allowlist that decides which verified subjects are admitted at all (see
> [security-model.md](security-model.md#application-layer)). A service subject
> listed here but missing there is denied, and the boot log warns about that
> mismatch.

The verified service `sub` is also its personal-memory principal. Use a
different provider application for each agent or automation boundary rather than
sharing one M2M client. That gives each agent stable ownership of its own
personal rows and makes compromise and rotation narrower. Workspace and project
audiences remain shared among authenticated callers as described in
[Memory spaces](spaces.md).

## Resource-server configuration

The existing variable names retain `AUTH0_` for compatibility, but the verifier
is issuer-neutral:

```dotenv
AUTH0_ISSUER=https://issuer.example/
AUTH0_JWKS_URI=https://issuer.example/.well-known/jwks.json
AUTH0_AUDIENCE=https://brain.example/mcp
```

All three values are required together. `AUTH0_ISSUER` and `AUTH0_AUDIENCE` must
match the JWT claims exactly, including trailing slashes and paths. The issuer
must publish RSA signing keys at the configured HTTPS JWKS URI. Open Brain does
not accept opaque tokens, token introspection, symmetric signatures, or
algorithms other than RS256.

On the Tailnet/Funnel and Qubes deployments, keep `MCP_ACCESS_KEY` unset and
`ENABLE_NATIVE_TOKENS=false`. The machine flow uses OAuth; it is not a reason to
reopen either `x-brain-key` credential type on the public deployment. A
scheduled agent outside Anthropic's egress range must connect over the tailnet
route, because the public Funnel branch will correctly reject it at Caddy with
403 before OAuth is attempted.

## Auth0 procedure

1. Use the same Auth0 API already configured as Open Brain's audience. Its
   Identifier must equal `AUTH0_AUDIENCE`, and its signing algorithm must be
   RS256.
2. Create a **Machine to Machine Application** for one agent or automation
   boundary. Authorize that application for the Open Brain API. Grant only the
   scopes your tenant policy requires; this Open Brain release validates the
   resource audience but does not yet enforce provider scope strings.
3. Check the API's access-token profile. The default Auth0 profile emits the
   signed `gty` signal; the RFC 9068 profile does not and requires the exact
   verified M2M subject in `OAUTH_SERVICE_ACCOUNT_SUBJECTS`.
4. On the application's **Credentials** tab choose **Client Secret (Post)** for
   the documented path. Record the tenant token endpoint, client ID, and client
   secret in the automation's secret store. Do not copy them into this
   repository or command arguments.
5. Run the browserless smoke test below with `OAUTH_AUDIENCE` set. Auth0 uses
   `client_secret_post` for the documented request, which is the helper's
   default.
6. If the helper reports `signed gty=client-credentials present`, no subject
   entry is needed. If it reports no signed `gty` (including the Auth0 RFC 9068
   profile), perform the one-time verified-subject mapping procedure below.

Auth0's
[Machine-to-Machine application guide](https://auth0.com/docs/get-started/auth0-overview/create-applications/machine-to-machine-apps)
and
[client-credentials token request](https://auth0.com/docs/api/authentication/client-credential-flow/get-token)
are the provider source of truth.

## Supported application authentication methods

Auth0 or the configured issuer authenticates the M2M application at its token
endpoint; Open Brain sees only the resulting bearer token. The tracked helper
supports `client_secret_post` (default, and the documented Auth0 choice) and
`client_secret_basic` (the documented Okta-style choice). It deliberately
refuses token-endpoint redirects so neither form credentials nor an MCP bearer
token can be replayed to a second URL.

The helper does not implement `private_key_jwt`, mTLS client certificates, or
public-client `none` authentication. Auth0 supports Client Secret (Post), Client
Secret (Basic), and—on eligible plans—Private Key JWT; selecting Private Key JWT
requires a separate client-assertion implementation outside this verified
runbook. See Auth0's
[application credential-method documentation](https://auth0.com/docs/get-started/applications/configure-private-key-jwt).

## Okta or another enterprise issuer

For Okta, create an API Services application and a custom authorization-server
scope, then use a token URL such as
`https://issuer.example/oauth2/<authorization-server-id>/v1/token`. Okta's
documented flow authenticates the client with HTTP Basic and requests a scope:

```bash
export OAUTH_CLIENT_AUTH_METHOD=client_secret_basic
export OAUTH_SCOPE='openbrain.use'
```

Follow the provider's current
[client-credentials guide](https://developer.okta.com/docs/guides/implement-grant-type/clientcreds/main/)
for authorization-server and policy setup. For any other issuer, determine its
token endpoint, client authentication method, required audience/resource
parameter, scopes, and JWT signing profile from its documentation.

Auth0 RFC 9068 tokens and most non-Auth0 tokens will not contain `gty`. Run the
smoke once with `OAUTH_SMOKE_PRINT_SUBJECT=true`, copy only the reported
verified subject into `OAUTH_SERVICE_ACCOUNT_SUBJECTS` on the server, recreate
the MCP container, and run the smoke again. Never infer the subject from a
dashboard label: use the exact value in the token that Open Brain successfully
verified.

RFC 9068 recommends that a client-credentials JWT `sub` identify the client
application; it also requires a `client_id` claim for that JWT profile. Open
Brain deliberately does not treat the mere presence of `client_id`, `azp`, or a
provider-specific equivalent as proof of a machine grant, because those claims
can also occur in user flows. Exact subject configuration is the conservative
generic fallback. See [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html).

Open Brain treats a verified literal `gty=client-credentials` as an issuer
assertion regardless of provider name. If a generic issuer lets applications
inject a custom claim literally named `gty`, reserve or block that claim at the
issuer when the human/machine audit distinction matters. This affects
attribution only, not access or memory scope.

## Browserless smoke test

The tracked helper obtains a token and sends a real MCP `initialize` request. It
never opens a browser, prints a token or secret, writes credentials to disk, or
echoes provider response bodies. Run it from the repository root on a tailnet
peer that can reach Open Brain:

```bash
export OAUTH_TOKEN_URL='https://issuer.example/oauth/token'
export OAUTH_CLIENT_ID='<machine-client-id>'
export OAUTH_AUDIENCE='https://brain.example/mcp'  # Auth0/resource-style issuers
export OPENBRAIN_MCP_URL='https://brain.example/mcp'

read -rsp 'OAuth client secret: ' OAUTH_CLIENT_SECRET && echo
export OAUTH_CLIENT_SECRET

deno run \
  --allow-env=OAUTH_TOKEN_URL,OAUTH_CLIENT_ID,OAUTH_CLIENT_SECRET,OAUTH_AUDIENCE,OAUTH_SCOPE,OAUTH_CLIENT_AUTH_METHOD,OPENBRAIN_MCP_URL,OAUTH_SMOKE_TIMEOUT_MS,OAUTH_SMOKE_PRINT_SUBJECT \
  --allow-net=issuer.example,brain.example \
  scripts/verify-service-account.ts

unset OAUTH_CLIENT_SECRET
```

Replace both example hosts and narrow `--allow-net` to the real issuer and MCP
hosts. For Okta-style requests, set `OAUTH_SCOPE` and
`OAUTH_CLIENT_AUTH_METHOD=client_secret_basic`; `OAUTH_AUDIENCE` may be omitted
when the provider does not use it. Set `OAUTH_SMOKE_PRINT_SUBJECT=true` only for
the Auth0 RFC 9068 or generic-issuer discovery run, then unset it.

A successful Auth0 run ends like this, without disclosing the credential:

```text
OK: browserless client_credentials authenticated to open-brain-homelab 1.20.0
Attribution signal: signed gty=client-credentials present; expected server label is service.
```

The helper proves token issuance and end-to-end MCP authentication. The server
test suite separately pins the provenance boundary: a verified M2M token stamps
thoughts with `metadata.door=service` and sessions with `source=service`, while
retaining the verified client subject. To live-check the stamp, let the service
account make one intentional capture and inspect the returned thought metadata
or the stored session provenance. Do not create a disposable memory merely for
testing; thoughts intentionally have no application DELETE path.

## Audit decision

Successful writes distinguish machines from people in durable server-owned
provenance: `service` versus `funnel`, plus the verified `sub`. Caddy access
logs continue to record the actual `tailnet` or `funnel` socket without JWT
contents. These are complementary facts, not interchangeable meanings of `door`.

An operator can summarize successful write attribution without reading thought
content:

```sql
SELECT metadata->>'door' AS credential_class, COUNT(*) AS thoughts
FROM thoughts
GROUP BY credential_class
ORDER BY credential_class;

SELECT source AS credential_class, COUNT(*) AS sessions
FROM sessions.session
GROUP BY source
ORDER BY source;
```

There is intentionally no per-tool successful-read audit in this release, so a
read-only service account leaves Caddy request metadata but no application-level
identity event. Failed Bearer tokens retain the existing
`token_validation_failed` reason rather than a machine/user label: claims from
an unverified token are attacker-controlled and must not enter trusted audit
data. Provider-side logs remain the source of truth for failed token exchanges,
which occur before Open Brain receives a Bearer token.

## Failure modes

| Symptom                                                        | Likely cause and response                                                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token endpoint returns `invalid_client`                        | Wrong secret, wrong client-auth method, disabled application, or a rotated credential. Confirm provider configuration; do not paste the secret into logs.                                                                  |
| Helper refuses a token or MCP redirect                         | Use the final token and MCP endpoint URLs. Redirects are intentionally disabled so a 307/308 cannot replay a client secret or bearer token.                                                                                |
| Token endpoint rejects audience or scope                       | The API was not authorized for the M2M application, the audience differs byte-for-byte, or the authorization-server policy does not grant the requested scope.                                                             |
| Helper reports an opaque/malformed token                       | The provider did not issue the RS256 JWT access-token profile Open Brain accepts. Configure a custom authorization server/API that emits JWTs; introspection is not supported.                                             |
| MCP returns 401                                                | Check `iss`, `aud`, `exp`, `sub`, RS256, the configured JWKS URI, and clock skew. Open Brain deliberately returns the same public message for every validation failure; use the reason-coded auth audit and provider logs. |
| MCP returns 403 before the helper reaches auth                 | The request used the public Funnel path from outside the Anthropic allowlist. Route the scheduled agent over the tailnet.                                                                                                  |
| Authentication works but writes show `door=funnel`             | The issuer supplied no signed `gty=client-credentials`; add the exact verified `sub` to `OAUTH_SERVICE_ACCOUNT_SUBJECTS` and recreate the MCP service.                                                                     |
| The agent cannot see old personal rows after client recreation | Its verified `sub` changed. That isolation is intentional; restore the original client identity or migrate ownership through a reviewed administrative procedure.                                                          |
| Server fails its JWKS boot probe                               | The issuer/JWKS URL is wrong, unreachable, non-HTTPS, or not serving a JSON `keys` array. Fix it before retrying tokens.                                                                                                   |

## Rotation and revocation

Rotate each M2M client secret in the provider and its automation secret store;
Open Brain never stores that secret. Prefer a provider-supported overlap window:
install the new secret in the agent, verify one headless request, then revoke
the old secret. Existing access JWTs remain usable until expiration because Open
Brain validates them locally and does not introspect or revoke them. Choose an
access-token lifetime that bounds that residual window.

Deleting and recreating an application may change its `sub`. For a generic
issuer, update `OAUTH_SERVICE_ACCOUNT_SUBJECTS` only after a successful verified
smoke. For Auth0's default token profile, the signed `gty` signal remains
automatic; the RFC 9068 profile still needs the exact mapped subject. Either
way, a changed `sub` creates a new personal-memory principal.
