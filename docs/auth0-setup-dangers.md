# Auth0 setup dangers — what the dashboard won't tell you

This doc is for anyone wiring a self-hosted app to an Auth0 tenant — OpenBrain
or otherwise. Auth0's dashboard is genuinely daunting for a newcomer, and the
setup guides (including, until this doc, ours) all walk the same path: tenant
profile, API identifier, RS256, callback URLs, client credentials. Every one of
those steps has a wizard, a validation error, or a copy-paste field to keep you
honest.

The most important decision in the whole setup has none of those. Nothing in the
dashboard ever asks it, and no error fires if you skip it:

> **Who is allowed to become a user of this tenant?**
>
> Your tenant mints tokens. Your app trusts tokens your tenant mints for its
> audience. Whoever can become a user of your tenant can therefore reach your
> app through any application that enables their connection and is authorized
> for the API — and allow-all is the documented default policy for a new API's
> user flows — so decide who can become a user **before** you expose the
> endpoint, and verify the answer instead of assuming it.

We got this wrong ourselves, found it in a security review, and confirmed the
hole was real by walking through it. This doc is the write-up we wish we had
read first: how the trap works, the checklist that catches it, how to gather
outcome evidence with the Management API instead of trusting the dashboard, and
the in-app control that keeps one dashboard toggle from ever being your entire
boundary again.

## How this bit us

During an August 2026 adversarial review of this project, two findings landed in
the same afternoon:

1. **The server authenticated but never authorized.** `verifyBearer` at the time
   checked signature, issuer, audience, and expiry — and nothing else. Any
   validly-signed, correctly-audienced token from the tenant was served. The
   tenant's membership control was, in effect, the entire access-control system.
2. **The tenant's `google-oauth2` social connection was enabled.** It had been
   on for an unknown period — most plausibly since initial setup, enabled
   alongside the intended database connection and never revisited, because no
   setup step had ever said "now decide who may log in."

Either finding alone is survivable. Together they meant: any Google account on
the internet could sign in to the tenant, receive a valid token for the API
audience, and be served.

The operator confirmed it rather than assuming it: signing in with a personal
Google account produced a brand-new user record and a successful login — no
sign-up step, no approval, no notification. That's not a bypass; it's the
designed behavior of an open social connection (see the table below).

Containment, in the order that matters:

- **Export first.** The full user list was exported via the Management API
  _before_ any deletion — a point-in-time snapshot of every profile then in the
  tenant, and the only artifact guaranteed to survive the cleanup that followed.
- **Search for strangers.** The export contained no accounts other than the
  operator's own (including the deliberate Google test account). A server-side
  sweep — edge access logs, ownership markers on stored data, the auth-failure
  audit — corroborated it: no trace of third-party access. The tenant's own logs
  had long expired (see retention, below), which is why the user list and the
  server-side data had to carry the proof.
- **Delete the connection** the same day it was found — at which point the
  export became the only record of enrollment through it that was guaranteed to
  survive (deletion can destroy a connection's user records; see Verification
  below).
- **Close the honest gap.** At the time, the server audited only _rejected_
  requests — nothing recorded who was successfully admitted, so "nobody got in"
  rested on the tenant's user list and short-retention IdP logs rather than on
  our own data. Both halves are now fixed in-app (server 1.20.0): a fail-closed
  subject allowlist, and every auth decision — admissions included — now
  enqueues a best-effort audit row. See
  [What OpenBrain checks](#what-openbrain-checks-and-what-your-app-must) below.

The rest of this doc generalizes that incident into checks you can run today.

## Connection types are not interchangeable

An Auth0 **connection** is a source of users. The types differ in the one
dimension that matters here — how a stranger becomes a user — and the dashboard
presents them as interchangeable checkboxes:

| Connection type              | How a stranger becomes a user                              | The membership control                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**                 | Self sign-up on your hosted login page                     | The **"Disable Sign Ups"** toggle — **off by default**, i.e. sign-ups are _allowed_ until you turn it off                                                                                                                                        |
| **Social** (Google, GitHub…) | **They already are one.** They bring their own IdP account | **No sign-up toggle exists** — there is no sign-up step to disable. Only a fail-closed Action can restrict who may log in (legacy Rules are end-of-life; check 3 covers what the Action must actually do), or don't enable the connection at all |
| **Enterprise**               | Membership in your organization's IdP                      | Your IdP's own membership administration                                                                                                                                                                                                         |

The social row is the trap, and it deserves to be stated twice:

> The intuition "I only have one account, so only I can log in" is **true and
> irrelevant** for a social connection. Everyone with a Google account already
> holds a credential your tenant will accept. Their first login _is_ their
> enrollment; a user record is created on the spot. There is no sign-up to
> disable because there is no sign-up.

That is exactly what bit us: the database connection's mental model ("nobody
else signed up") silently applied to a connection type where it means nothing.

## The five checks

Run these against every tenant that fronts something you care about. They take
five minutes in the dashboard. Note the division of labor: these are
**configuration** checks — dashboard work (the state is also readable through
the Management API's configuration endpoint families: `connections`, `clients`,
`client-grants`, `organizations` enabled-connections, `actions` trigger
bindings, `resource-servers` — but this doc does not supply those commands); the
next section captures **outcome** evidence — who enrolled, what the logs still
retain. Running the evidence commands does not audit the configuration.

1. **Which connections are enabled, and on which applications?** Every
   enabled-connection × application pair is a login path. Connections you don't
   recognize or don't need: disable or delete (export first — see below).
2. **For each Database connection: is "Disable Sign Ups" on?** If not, your
   hosted login page has a working sign-up form for the world. If the tenant
   uses **Auth0 Organizations**, check each organization too: Organization
   Signup takes priority over the connection's own signup configuration, so an
   organization can re-open the self-registration this toggle appears to close.
3. **For each Social connection: is there a fail-closed Action restricting who
   may log in?** If not, **the internet can log in** — every holder of that
   IdP's accounts is one consent screen away from a user record in your tenant.
   And "an Action exists" is not itself the control. It must deny by default and
   admit by **exact `sub` match** — the immutable identifier is the safe
   baseline. Auth0's own guidance warns against authorizing by email domain; if
   you must match on email, require `email_verified === true` and exact
   normalized addresses, and remember a federated email attribute is asserted by
   the upstream IdP, not proven by your tenant. And know where the scoping
   lives: a Post-Login Action is attached to the tenant's Login flow and runs
   for **every** application and connection — there is no per-connection binding
   to configure — so the restriction is code: deny by default across the whole
   tenant (simplest), or condition on `event.connection.id` /
   `event.client.client_id` and fail closed when that context is missing or
   unexpected. Know the Action's limit, too: it denies the login and token
   issuance, but the first authentication can still create the user profile
   before the Action's verdict — see
   [Verification, not assertion](#verification-not-assertion) for what a user
   record does and doesn't prove.
4. **Is any connection promoted to Domain Level?** Domain-Level promotion
   exposes the connection to third-party applications — our own DCR fallback
   docs require it temporarily and warn that it persists
   ([Codex](codex-oauth-client.md), [Kimi Code](kimi-code-oauth-client.md)).
   Promotion is sticky: disabling Dynamic Client Registration afterwards does
   **not** undo it. If a past DCR window promoted a connection, it is still
   promoted today.
5. **Which applications are authorized for your API — and what is its
   user-delegated access policy?** Tenant membership is not the only gate Auth0
   offers. An API's policy for user-delegated tokens can be `allow_all` (the
   documented default for a new API), `require_client_grant`, or `deny_all`;
   under `require_client_grant`, only applications explicitly granted to your
   API can obtain tokens for its audience — a real intermediate layer between
   tenant enrollment and your app's own allowlist. Prefer it — and plan the
   switch around its prerequisite: every application that should keep working
   needs a **User-Delegated Access grant** for your API. Auth0's documented
   dashboard order is switch-then-grant: enable Per-app authorization and save,
   then immediately grant access to each application intended to use this API
   (Application Access → Edit → Grant Access — the control appears once the
   policy is per-app), then exercise each client's OAuth flow to confirm. To
   avoid even that brief transition window, pre-create the grants through the
   Management API (`POST /api/v2/client-grants` with the application's
   `client_id`, your API's audience, the intended permissions, and
   `subject_type: "user"`) before changing the policy. Grant only the
   applications that are meant to use this API — blanket grants defeat the
   least-privilege point of the policy. Without a grant, Auth0 will not issue
   that application an access token for this API; where the failure surfaces
   varies by flow, so read **Monitoring → Logs** for the actual error. Then
   audit which applications hold grants for your API.

## DCR and Domain-Level promotion: time-box, then check the residue

Dynamic Client Registration is the one place our own discipline was already
good, and the pattern is worth restating because it's the same shape as the
connection problem — a tenant-wide toggle whose exposure outlives the reason you
flipped it:

- **Open the window only as long as the registration needs.** Enable DCR,
  register the client, disable DCR — in one sitting.
- **Know the two residues that survive closing it.** DCR-created clients and
  their refresh tokens keep working after DCR is off (that's the point — don't
  delete them), and the Domain-Level connection promotion the flow required
  **persists** until you demote it deliberately.

The client-specific procedures live in
[codex-oauth-client.md](codex-oauth-client.md) and
[kimi-code-oauth-client.md](kimi-code-oauth-client.md).

## Verification, not assertion

The dashboard shows you configuration; it does not show you history, and its log
views expire quickly. The Management API gives you evidence instead. Mint a
short-lived Management API token (Dashboard → Applications → APIs → Auth0
Management API → API Explorer, or a dedicated M2M application) with `read:users`
and `read:logs`, then:

```bash
# Quick audit: which profiles currently exist for a given connection?
# Paginate explicitly — repeat with page=1,2,... until an empty page.
# per_page=50 is valid on every plan (Auth0's current docs cap Public
# Cloud tenants lower than Private Cloud); user search is capped at 1,000
# results and eventually consistent. Enough to spot strangers on a small
# tenant, NOT a complete export.
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$TENANT/api/v2/users?search_engine=v3&page=0&per_page=50&include_fields=true&fields=user_id,email,identities,created_at,last_login,logins_count&q=identities.connection%3A%22google-oauth2%22"

# The artifact to save: a bulk user-export job — a complete point-in-time
# snapshot of current profiles. Auth0's docs don't pin the omitted-"limit"
# behavior (staff guidance says everything; the endpoint schema suggests a
# small default) — so always check the downloaded record count against
# your expected user population.
# Add "connection_id" (a con_... id) to scope it to one connection, or omit
# it to export every user in the tenant. Poll the returned job id until
# "completed", download the file at its "location", verify the count — and
# only then delete anything.
curl -s -X POST -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format": "json", "fields": [{"name": "user_id"}, {"name": "email"}, {"name": "identities"}, {"name": "created_at"}, {"name": "last_login"}, {"name": "logins_count"}]}' \
  "https://$TENANT/api/v2/jobs/users-exports"
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$TENANT/api/v2/jobs/$JOB_ID"

# Recent authentication events for a connection. Success Signup is type
# "ss", Success Login is "s". Repeat with page=1,2,... until an empty
# page — log search returns at most 100 events per request and 1,000 in
# total. Checkpoint pagination (from=<log_id>&take=100) is unbounded but
# reads FORWARD only: it returns events newer than the exclusive seed id,
# ignores every other parameter (including q — filter locally), and pages
# via the response's Link: rel="next" header. It cannot reach further back
# than its seed, so it does not turn a late start into a complete history;
# the only complete-window path is a log stream set up in advance.
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$TENANT/api/v2/logs?page=0&per_page=100&q=connection%3A%22google-oauth2%22"
```

Read the results with these four facts in hand:

- **Log retention is short and plan-tiered:** 1 day on the free tier, 5–10 days
  on paid tiers, 30 on Enterprise. **Absence of log entries proves nothing**
  about any period before that horizon.
- **A user record proves an enrollment attempt, not an admission.** The record
  is created on the first authentication through the connection; Auth0 documents
  that this can happen even when a Post-Login Action then denies the login. The
  Action's authoritative verdict lives in the tenant's logs (or a log stream you
  set up in advance): a denied login never produces a token, so no request
  reaches your resource server and its audit cannot capture the verdict. The
  initiating application _may_ receive the `access_denied` response — only when
  its redirect policy permits error callbacks; strict third-party clients get
  Auth0's own error page instead — and client-side logs are not evidence you can
  rely on either way. Your own audit answers a different question — a present
  admission row proves a request passed your server's checks; an absent row
  proves nothing.
- **The user list and the export are snapshots, not history.** Both show the
  profiles that exist _at query time_. A present record is positive evidence an
  attempt reached your tenant; an empty result proves only that nothing matches
  _now_ — profiles removed before you looked (a connection deletion, an
  administrator, or Auth0's own Action-cleanup workaround for social logins)
  leave no trace here. Historical absence needs logs retained from the period in
  question, or your own app/edge evidence.
- **Export before you delete — deletion destroys the evidence.** Auth0's support
  guidance is that deleting a connection **deletes the users under it** (a batch
  job, irreversible), even though the endpoint description mentions only the
  login path. Whichever behavior your tenant exhibits, the conclusion is the
  same: run the export job, confirm it completed, save the file somewhere
  durable, and check its record count against your expected user population —
  only then delete.

## What OpenBrain checks (and what your app must)

As of server 1.20.0, `verifyBearer` checks, in order — and, beyond the library's
standard claim validation (jose also enforces `nbf` and a well-formed `iat`
automatically when those claims are present), nothing else:

1. **Signature** against the issuer's JWKS (pinned `AUTH0_JWKS_URI`, RS256
   only);
2. **Issuer** (`iss`) equals the configured `AUTH0_ISSUER`;
3. **Audience** — the configured `AUTH0_AUDIENCE` must be among the token's
   `aud` values (an `aud` claim may be a string or an array; the check is
   membership, not string equality);
4. **Expiry** — `exp` must be present and valid (RFC 7519 makes it optional; the
   resource server must demand it);
5. **Subject** — `sub` must be present and a bounded string free of ASCII
   control characters;
6. **Authorization** — the verified `sub` must appear on the
   `OAUTH_ALLOWED_SUBJECTS` allowlist. This list **fails closed**: with the
   OAuth door enabled and the list unset or empty, every Bearer token is
   rejected and the boot log warns. An IdP-side misconfiguration therefore stops
   here instead of equaling full access.

Every rejection — including an allowlist miss — returns the same uniform 401,
and every decision (admitted or refused) **enqueues** an audit row for the
`mcp_auth_events` table; allowlist refusals carry the verified subject so you
can see which real identity knocked. The write is best-effort telemetry, not a
durable ledger — under saturation either outcome can drop, counted and warned;
the full contract is stated plainly in [security-model.md](security-model.md) —
but when the rows are present, "who accessed this server in the last year" is a
local SQL query with 365-day retention instead of a race against the IdP's log
expiry.

Before 1.20.0, the list stopped at item 5 — which is the point of this doc:

> **If your tenant will mint a token for someone, and your app checks only
> signature/issuer/audience/expiry, your app will serve them.** That is the
> default shape of nearly every resource-server example on the internet. Read
> your verifier before you trust it; if it has no authorization step, the
> tenant's membership configuration is your entire access-control system, and
> every trap in this doc is load-bearing.

One practical note for the allowlist pattern: there's a bootstrap
chicken-and-egg — you need your own `sub` before you can allowlist yourself.
Read it from the dashboard (User Management → Users → `user_id`), or decode it
locally from a token you already hold; OpenBrain's
[service-account helper](service-account-oauth-client.md) prints the decoded
subject preflight for exactly this reason.

## The two-layer rule

The durable lesson, in one line: **tenant membership control and an in-app
allowlist are two different layers, and you want both.**

- The tenant layer is where enrollment actually happens — it must be configured
  deliberately (the five checks) because no app-side control can un-mint a token
  or delete a user record.
- The app layer is what makes a single dashboard toggle survivable. Tenant
  configuration is mutable, invisible to your repo, outside your change control,
  and — as the social-connection row shows — easy to hold a wrong mental model
  about. A fail-closed allowlist in code you version-control turns "the tenant
  is misconfigured" from a breach into a log line.

Two smaller dashboard truths, same spirit, worth internalizing on the way out:

- **A `client_id` is not a credential.** Public clients embed it, it appears in
  every authorization URL, and treating it as secret buys nothing. The
  `client_secret` is the credential; who may _enroll_ is the boundary.
- **"Nobody knows my URL" is not a control.** If your endpoint has a TLS
  certificate, its hostname is in public Certificate Transparency logs from the
  moment of issuance ([funnel-mcp-perimeter.md](funnel-mcp-perimeter.md)).
  Assume the login page is discovered on day one, and make the enrollment
  question the thing that protects you.
