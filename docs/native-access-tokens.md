# Native access tokens

Native access tokens give a private Open Brain deployment independently
rotatable credentials without requiring an OAuth issuer. They are intended for
the loopback/LAN/private-tailnet local install. The public Funnel and Qubes
postures remain OAuth-only and disable this verifier explicitly.

Each client gets a descriptive label and its own token. Open Brain displays the
plaintext exactly once, stores only its SHA-256 digest, and checks the database
on every request. Revoking a token therefore makes the next request fail with
HTTP 401; there is no authentication-result cache to expire.

## Fresh local install

In `deploy/compose-local/.env`:

```dotenv
ENABLE_NATIVE_TOKENS=true
OPENBRAIN_TOKEN_ADMIN_PASSWORD=<a value from: openssl rand -hex 24>

# Optional during migration from the old shared credential:
MCP_ACCESS_KEY=

# Optional stable owner for personal visibility. Labels are not principals.
MCP_ACCESS_KEY_PRINCIPAL=local-owner
```

Start the stack, then issue the first client token through the profile-gated
administrator container:

```bash
cd deploy/compose-local
docker compose up -d
docker compose --profile tools run --rm token-admin create "laptop client"
```

The final command prints the token once. Copy it directly into the client's
secret store; it cannot be recovered later. Send it in the same header used by
the legacy local credential:

```text
x-brain-key: ob1_<public-prefix>_<secret>
```

Do not put it in a URL, command history, ticket, or log. The prefix and label
are safe for inventory and support conversations; the complete token is a bearer
secret.

## Issue, list, and revoke

Run lifecycle commands only when needed; the administrator credential is not
present in the long-running MCP container:

```bash
# Create another independently revocable client credential.
docker compose --profile tools run --rm token-admin create "backup agent"

# List prefix, state, label, and timestamps. This never reveals a token/hash.
docker compose --profile tools run --rm token-admin list

# Revoke by the public prefix shown by create/list.
docker compose --profile tools run --rm token-admin revoke ob1_AAAAAAAA
```

`--json` is available for automation. Be especially careful with
`create
--json`: its output necessarily contains the one-time plaintext and must
not be captured by routine job logs.

Rotation is create-new, update and verify the client, then revoke-old. A
repeated revoke or an unknown prefix fails without changing another token.
Labels are mutable only by replacing a token, which keeps historical attribution
stable.

## Moving from `MCP_ACCESS_KEY`

The static key remains supported as a migration bridge. Keep it configured while
issuing one native token per client, update and smoke-test each client, then
remove `MCP_ACCESS_KEY` from `.env` and recreate the MCP service:

```bash
docker compose up -d --force-recreate mcp
```

The static key cannot be revoked through the token table. Removing it from the
server environment is the revocation step. Keep `MCP_ACCESS_KEY_PRINCIPAL`
stable during the transition so existing personal rows retain the same owner.

## Existing database upgrade

PostgreSQL init scripts do not rerun on an existing data directory. Quiesce
writes and take a verified backup, then set `OPENBRAIN_TOKEN_ADMIN_PASSWORD` in
`.env` and run:

> The commands below are for the single-box compose install. A deployment whose
> database is not in the compose project has nothing to `exec` into — see
> [Upgrading an existing deployment](../deploy/qubes/app-qube/README.md#upgrading-an-existing-deployment)
> for the equivalent over a network connection. There, the upgrade helper is
> also unusable (it drives `docker compose exec`); leave
> `OPENBRAIN_TOKEN_ADMIN_PASSWORD` unset and migration 08 creates the
> administrator as a `NOLOGIN` role, which is the correct end state for an
> OAuth-only deployment that will not mint native tokens. Should such a
> deployment later want to mint them, grant the login by hand over that same
> connection — `ALTER ROLE openbrain_token_admin WITH LOGIN PASSWORD '…';` —
> which is what the helper would otherwise have run. Reapplying migration 08
> preserves whichever state you chose.

```bash
cd deploy/compose-local
bash ../../scripts/upgrade-enable-token-admin-role.sh
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/08-access-tokens.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/03-grants-assertion.sql
docker compose build mcp token-admin
docker compose up -d --no-deps mcp
```

Migration 08 is required by this server version even when native tokens are
disabled. On an OAuth-only deployment the administrator role may remain
`NOLOGIN`, and `ENABLE_NATIVE_TOKENS=false` keeps every presented `x-brain-key`
outside the accepted credential set.

## Storage, roles, and attribution

A token has a 48-bit public lookup prefix and a 256-bit random secret. The
`native_auth.access_token` table stores only the full-token SHA-256 digest,
prefix, bounded label, creation time, and optional revocation time. The runtime
role can select only the four fields needed for authentication. It cannot
create, change, or revoke tokens.

The dedicated `openbrain_token_admin` role can list non-secret metadata and
execute two fixed-search-path `SECURITY DEFINER` functions. It cannot read token
hashes, memories, or the identity sequence, and it has no direct table mutation
privilege. The completed-catalog grant assertion and database smoke test pin
those boundaries.

Successful thought writes stamp the server-verified label in
`metadata.token_label`; session writes use it as `source_node`. Labels are
attribution, not authorization identities. Every native token shares the
optional deployment-wide `MCP_ACCESS_KEY_PRINCIPAL` for personal scope, while
workspace/project access follows the existing registered-scope rules.

Full backups include token hashes and revocation state, so restoring a backup
also restores the credentials that were active at that point. Plaintext cannot
be reconstructed from the database. Protect dumps as credential material and
review/revoke restored tokens after a recovery.

The lifecycle shape was informed by the MIT-licensed
[memory-vault project](https://github.com/MihaiBuilds/memory-vault); Open
Brain's database roles, request integration, attribution, and public-deployment
gate are implemented for this repository's own trust model.
