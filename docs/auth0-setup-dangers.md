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
> app — so decide who can become a user **before** you expose the endpoint, and
> verify the answer instead of assuming it.

We got this wrong ourselves, found it in a security review, and confirmed the
hole was real by walking through it. This doc is the write-up we wish we had
read first: how the trap works, the checklist that catches it, how to verify
with the Management API instead of the dashboard, and the in-app control that
keeps one dashboard toggle from ever being your entire boundary again.

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
  _before_ any deletion — it is the durable evidence of who ever enrolled.
- **Search for strangers.** The export contained no accounts other than the
  operator's own (including the deliberate Google test account). A server-side
  sweep — edge access logs, ownership markers on stored data, the auth-failure
  audit — corroborated it: no trace of third-party access. The tenant's own logs
  had long expired (see retention, below), which is why the user list and the
  server-side data had to carry the proof.
- **Delete the connection** the same day it was found.
- **Close the honest gap.** At the time, the server audited only _rejected_
  requests — nothing recorded who was successfully admitted, so "nobody got in"
  rested on the tenant's user list and short-retention IdP logs rather than on
  our own data. Both halves are now fixed in-app (server 1.20.0): a fail-closed
  subject allowlist and an audit row for every auth decision, admissions
  included. See
  [What OpenBrain checks](#what-openbrain-checks-and-what-your-app-must) below.

The rest of this doc generalizes that incident into checks you can run today.

## Connection types are not interchangeable

An Auth0 **connection** is a source of users. The types differ in the one
dimension that matters here — how a stranger becomes a user — and the dashboard
presents them as interchangeable checkboxes:

| Connection type              | How a stranger becomes a user                              | The membership control                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**                 | Self sign-up on your hosted login page                     | The **"Disable Sign Ups"** toggle — **off by default**, i.e. sign-ups are _allowed_ until you turn it off                                                                            |
| **Social** (Google, GitHub…) | **They already are one.** They bring their own IdP account | **No sign-up toggle exists** — there is no sign-up step to disable. Only an Action/Rule filtering `sub`/email/domain restricts who may log in, or don't enable the connection at all |
| **Enterprise**               | Membership in your organization's IdP                      | Your IdP's own membership administration                                                                                                                                             |

The social row is the trap, and it deserves to be stated twice:

> The intuition "I only have one account, so only I can log in" is **true and
> irrelevant** for a social connection. Everyone with a Google account already
> holds a credential your tenant will accept. Their first login _is_ their
> enrollment; a user record is created on the spot. There is no sign-up to
> disable because there is no sign-up.

That is exactly what bit us: the database connection's mental model ("nobody
else signed up") silently applied to a connection type where it means nothing.

## The four checks

Run these against every tenant that fronts something you care about. They take
five minutes in the dashboard — or run the Management API versions in the next
section, which are the ones you can keep as evidence.

1. **Which connections are enabled, and on which applications?** Every
   enabled-connection × application pair is a login path. Connections you don't
   recognize or don't need: disable or delete (export first — see below).
2. **For each Database connection: is "Disable Sign Ups" on?** If not, your
   hosted login page has a working sign-up form for the world.
3. **For each Social connection: is there an Action restricting who may log
   in?** If not, **the internet can log in** — every holder of that IdP's
   accounts is one consent screen away from a user record in your tenant.
4. **Is any connection promoted to Domain Level?** Domain-Level promotion
   exposes the connection to third-party applications — our own DCR fallback
   docs require it temporarily and warn that it persists
   ([Codex](codex-oauth-client.md), [Kimi Code](kimi-code-oauth-client.md)).
   Promotion is sticky: disabling Dynamic Client Registration afterwards does
   **not** undo it. If a past DCR window promoted a connection, it is still
   promoted today.

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
views expire quickly. Two Management API calls give you evidence instead. Mint a
short-lived Management API token (Dashboard → Applications → APIs → Auth0
Management API → API Explorer, or a dedicated M2M application) with `read:users`
and `read:logs`, then:

```bash
# Every user that ever enrolled through a given connection — the durable
# artifact (user records persist; logs expire). Swap the connection name
# to audit each enabled connection in turn.
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$TENANT/api/v2/users?search_engine=v3&include_fields=true&fields=user_id,email,identities,created_at,last_login,logins_count&q=identities.connection%3A%22google-oauth2%22"

# Recent authentication events for that connection. Success Signup is
# type "ss", Success Login is "s".
curl -s -H "Authorization: Bearer $MGMT_TOKEN" \
  "https://$TENANT/api/v2/logs?per_page=100&q=connection%3A%22google-oauth2%22"
```

Read the results with these three facts in hand:

- **Log retention is short and plan-tiered:** 1 day on the free tier, 5–10 days
  on paid tiers, 30 on Enterprise. **Absence of log entries proves nothing**
  about any period before that horizon.
- **The Users list is the durable artifact.** A user record is created on first
  successful login and persists indefinitely — it survives log expiration, and
  in our incident it was checkable well after the exposure window. An empty
  result for a connection is real evidence; an empty _log_ is not.
- **Export before you delete.** Auth0's current Management API documentation
  says deleting a connection removes the login path but not the user records.
  Don't bet your incident evidence on that staying true, or on remembering it
  correctly under pressure: exporting the user list first costs one command and
  makes the question moot.

## What OpenBrain checks (and what your app must)

As of server 1.20.0, `verifyBearer` checks, in order — and nothing else:

1. **Signature** against the issuer's JWKS (pinned `AUTH0_JWKS_URI`, RS256
   only);
2. **Issuer** (`iss`) equals the configured `AUTH0_ISSUER`;
3. **Audience** (`aud`) equals the configured `AUTH0_AUDIENCE`;
4. **Expiry** — `exp` must be present and valid (RFC 7519 makes it optional; the
   resource server must demand it);
5. **Subject** — `sub` must be present and a bounded, control-character-free
   string;
6. **Authorization** — the verified `sub` must appear on the
   `OAUTH_ALLOWED_SUBJECTS` allowlist. This list **fails closed**: with the
   OAuth door enabled and the list unset or empty, every Bearer token is
   rejected and the boot log warns. An IdP-side misconfiguration therefore stops
   here instead of equaling full access.

Every rejection — including an allowlist miss — returns the same uniform 401,
and every decision (admitted or refused) is recorded in the `mcp_auth_events`
audit table; allowlist refusals keep the verified subject so you can see which
real identity knocked. "Who accessed this server in the last year" is now a
local SQL query with 365-day retention, not a race against the IdP's log expiry.
(The audit write is best-effort telemetry, not a durable ledger — the contract
and its limits are stated plainly in [security-model.md](security-model.md).)

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
  deliberately (the four checks) because no app-side control can un-mint a token
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
