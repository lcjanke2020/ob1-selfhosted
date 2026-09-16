# Native access tokens

Native tokens provide independently revocable credentials without an OAuth
issuer. They work on the private local install and, when explicitly enabled, the
**tailnet branch of the split Qubes deployment**. The public Funnel branch
remains OAuth-only. The single-host Pattern B override still disables native
verification; sharing its Caddyfile does not enable tokens there.

Each token has a descriptive label and a stable operator-assigned principal. The
secret is shown once, only its SHA-256 digest is stored, and every request
checks current revocation state. Revocation takes effect on the next request.

## Fresh local install

In `deploy/compose-local/.env`:

```dotenv
ENABLE_NATIVE_TOKENS=true
REQUIRE_TAILNET_TOKEN_MARKER=false
OPENBRAIN_TOKEN_ADMIN_PASSWORD=<a value from: openssl rand -hex 24>
MCP_ACCESS_KEY=
MCP_ACCESS_KEY_PRINCIPAL=
```

Complete the remaining config and CPU/GPU prerequisites in the
[local setup guide](../deploy/compose-local/README.md#setup), then prepare the
embedding runtime and database:

```bash
cd deploy/compose-local
docker compose --env-file .env up -d ollama
docker compose --env-file .env exec ollama ollama pull nomic-embed-text
docker compose --env-file .env up -d --wait postgres
docker compose --env-file .env build mcp
```

Before starting MCP, run the
[superuser backfill plan and activation](embedding-limits.md#compose-backfill-runner).
This is required even for an empty database. Once it prints `activated`, start
MCP and create a token using its restricted administration container:

```bash
docker compose --env-file .env up -d --no-deps mcp
docker compose --env-file .env --profile tools run --rm token-admin \
  create "laptop client" --principal native:laptop
```

Store the displayed secret directly in the client's secret store. Send it as
`x-brain-key: ob1_<public-prefix>_<secret>`. Never put the complete token in a
URL, ticket, routine job log, or shell history. Prefix, label, and principal are
non-secret inventory metadata. The administrator password is never passed to the
long-running MCP container.

## Issue, list, and revoke

```bash
# Create requires an explicit principal; labels do not select ownership.
docker compose --env-file .env --profile tools run --rm token-admin \
  create "backup agent" --principal native:backup

# Metadata only: prefix, state, label, principal, creation/revocation timestamps.
docker compose --env-file .env --profile tools run --rm token-admin list --json

docker compose --env-file .env --profile tools run --rm token-admin revoke ob1_AAAAAAAA
```

All three commands accept a trailing `--json`. Creation output contains the
one-time secret; redirect it to an owner-only file if automation needs it, and
keep that file outside synchronized folders and repositories.

A principal has the form `native:<id>`: the ID is 1–121 ASCII letters, digits,
dots, underscores or hyphens, starting with a letter or digit. The complete
principal is at most 128 characters. It is deliberately separate from a label,
token prefix, and Auth0 user/M2M subjects. Reserve this namespace for native
identities when configuring another OIDC issuer; OAuth subjects share the
underlying ownership namespace and must not collide with native principals.

**Rotate without changing ownership:** create a replacement with the **same
principal**, update and verify the client, then revoke the old prefix. A new
label can distinguish the replacement's attribution. Two tokens with the same
principal intentionally share personal memory; use different principals for
roles that must remain separate. There is no in-place principal edit or unrevoke
API. Repeated/unknown revocations do not change another token.

## Personal memory and older credentials

Native-token personal and `sensitive` rows belong to the token's stored
principal. Thoughts stamp `metadata.sub` with it and `metadata.token_label` with
the label; sessions retain the label in `source_node` while ownership uses the
principal. `door`/`source` stays `tailnet`. Workspace/project audiences are
still shared among authenticated callers; this is not a membership ACL.

Migration 14 leaves older tokens with `principal=NULL`. They retain
workspace/project access, but personal and `sensitive` access fails closed.
Rotate them with an explicit principal; neither their label nor the legacy
shared-key setting supplies an identity automatically.

`MCP_ACCESS_KEY_PRINCIPAL` now binds **only the static `MCP_ACCESS_KEY`**.
Before starting 1.27.0, a native-token-only deployment must remove that setting
or configure the temporary local recovery key described below. If a static key
is still configured, its binding remains unchanged; native tokens never inherit
it. Previously captured personal rows retain their old owner. No automatic
migration of OAuth/shared-key memories occurs. The existing `move_thought`
operation makes a readable thought personal to the calling principal; it cannot
silently transfer someone else's personal rows. Any ownership reassignment needs
a separate operator-reviewed data migration.

### Preserve access to older personal rows

Before removing the old principal setting or the last credential that can read
its rows, record the exact former effective `MCP_ACCESS_KEY_PRINCIPAL`. Run this
read-only census as the database superuser (`postgres` by default), replacing
the example owner with that value. The restricted credential administrator
`openbrain_token_admin` cannot read memory and cannot run this census. The
census counts both stores across all workspaces, including `sensitive`, without
returning memory contents:

```sql
\set legacy_owner 'legacy-owner'
BEGIN READ ONLY;
SELECT 'thoughts' AS store, workspace_id, project_id, owner_subject,
       count(*) AS row_count
FROM public.thoughts
WHERE visibility = 'personal' AND owner_subject = :'legacy_owner'
GROUP BY workspace_id, project_id, owner_subject
UNION ALL
SELECT 'sessions' AS store, workspace_id, project_id, owner_subject,
       count(*) AS row_count
FROM sessions.session
WHERE visibility = 'personal' AND owner_subject = :'legacy_owner'
GROUP BY workspace_id, project_id, owner_subject
ORDER BY store, workspace_id, project_id, owner_subject;
ROLLBACK;
```

Confirm the provenance of those rows before deciding who should own them. An
owner without the `native:` prefix can also be an OAuth subject; the prefix
alone is not evidence that a row came from an old native token. Do not select
every non-native owner for reassignment.

If the old owner already satisfies the `native:<id>` grammar, deliberately
reusing that exact value for a replacement token preserves ownership. Adding
`native:` to an arbitrary old owner creates a different identity:
`native:legacy-owner` cannot read rows owned by `legacy-owner`.

For a **private local installation** with such rows, retain the existing static
key or configure a temporary static recovery key from at least 32 random bytes
in a trusted secret store. Bind `MCP_ACCESS_KEY_PRINCIPAL` to the exact old
owner and recreate MCP. Verify this credential can read the expected personal
thoughts and sessions, including `sensitive`; new native tokens still use only
their own stored principals. Keep the recovery key until an operator-reviewed
ownership migration has been backed up, applied, and verified for both stores.
Then remove both static-key variables and recreate MCP again.

The supplied Qubes and Pattern B deployments keep the static key absent. Do not
enable a static key there to recover unexpected legacy rows; arrange a reviewed
data migration through the existing database-administration path before retiring
the last working reader. No ownership updates are performed by migration 14 or
by token rotation.

## Existing database upgrade

Server **1.27.0 requires migration 14 even with native tokens disabled**.
Starting it against an older schema or unreadable verification columns fails
with migration guidance. For a 1.26.0 database, preserve the old image and
environment, take a verified backup, and build the replacement before stopping
MCP. Then apply the migration and final grants assertion in one transaction:

```bash
cd deploy/compose-local
docker compose --env-file .env build mcp token-admin
docker compose --env-file .env stop mcp
cat ../../db/14-native-token-principals.sql ../../db/03-grants-assertion.sql |
  docker compose --env-file .env exec -T postgres \
    psql -X --single-transaction -v ON_ERROR_STOP=1 -U postgres -d openbrain
docker compose --env-file .env --profile tools run --rm token-admin list --json
# Resolve any legacy personal ownership and remove a native-only shared principal.
docker compose --env-file .env up -d --no-deps mcp
```

Migration 14 changes the token registration function's signature. The 1.26.0
server cannot boot against that catalog, and its token-creation CLI no longer
works. Returning to the old image requires the [schema rollback](#rollback)
before restarting it; changing the image tag alone is insufficient.

Older installations must apply the intervening migrations in the
[local upgrade sequence](../deploy/compose-local/README.md#upgrading-an-existing-database),
including 08 and 13 **before** 14. Reapplying 14 preserves principals and
revocation state and reconciles verification/admin column grants. Reapplying 08
alone restores its retired registration overload; always finish with 14 and the
current grants assertion.

Before committing a production migration, rehearse that exact sequence with
`BEGIN`/`ROLLBACK` and verify the old catalog afterward. Do not run a second
runtime against the real database for tests.

## Split Qubes deployment

Use the existing restricted administrator login and role-scoped HBA entries over
the app→DB ConnectTCP forwarder, as described in
[OAuth subject admission](oauth-subjects.md#split-qubes-administrator-path).
Both `token-admin` and `subject-admin` exist in the app Compose `tools` profile.
From `deploy/qubes/app-qube`, the lifecycle commands above work unchanged. No
new HTTP admin listener, SSH access to the DB qube, or qrexec policy is needed
when that path is already provisioned.

The supplied app Compose defaults `ENABLE_NATIVE_TOKENS=false`, keeps the static
key absent, and pins `REQUIRE_TAILNET_TOKEN_MARKER=true`. Enable native tokens
only after all of these deployment steps have passed:

1. Preserve the prior app/ingress image IDs and owner-only environment backups;
   verify an encrypted database backup and the migration rollback rehearsal.
2. Deploy the reviewed shared Caddyfile on ingress. Public requests lose both
   `X-Brain-Key` and `X-OpenBrain-Tailnet`; the tailnet proxy replaces the
   marker with `1`. Verify the branch matrix below before enabling the runtime
   flag.
3. Stop MCP, apply migration 14 plus the full grant assertion atomically through
   the existing app→DB route, inspect the administrator's token inventory, and
   start the new runtime with `ENABLE_NATIVE_TOKENS=true`.
4. Create one token per intended role with a distinct principal. Store its
   secret directly on that role's trusted account and smoke-test its client.
   Keep existing OAuth clients until each replacement works.
5. Confirm the boot message describes the required trusted marker, the app still
   has only its loopback listener, and the public IP perimeter remains intact.
   Take the ordinary post-deployment backup.

The marker is **not a secret or an authentication credential**. Its authority
comes from the app listener being reachable only by the trusted ingress path. A
host-root/container-network or permitted qrexec caller can forge it. Never
expose the app port, add another untrusted proxy route, or let arbitrary clients
reach the Caddy loopback socket. The app rejects a token unless the marker is
exactly `1` and the Funnel discriminator is absent; it still verifies the token
itself. Static-key verification, if configured outside the supplied Qubes
Compose, is subject to the same marker gate.

| Route / credentials                                                      | Expected result                          |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| Tailnet, active native token                                             | admitted with stored principal and label |
| Tailnet, revoked token                                                   | 401 on the next request                  |
| Public allowlisted Funnel, native token only, even with a spoofed marker | 401; `missing_credentials` audit reason  |
| Public allowlisted Funnel, valid OAuth Bearer plus any native header     | admitted through OAuth                   |
| Public non-allowlisted Funnel                                            | 403 at Caddy                             |
| Direct backend without marker, valid native token                        | 401; no native lookup                    |

Use synthetic branch probes only on a trusted local test socket; sending a
public request from a non-allowlisted network proves only the IP perimeter. CI
runs the actual Caddyfile in an isolated container and separately exercises real
auth→audit and auth→RLS paths against disposable PostgreSQL.

## Rollback

Turn native tokens off, stop MCP, and pause token administration first. Confirm
that the saved environment has a working OAuth fallback; a local deployment may
instead use its existing static key and explicit principal. If neither is
available, leave MCP stopped until a fallback is configured and verified.

Before restarting the 1.26.0 image, restore its token registration contract in a
transaction: drop `native_auth.register_access_token(text,bytea,text,text)`
without CASCADE, reapply the **1.26.0** `db/08-access-tokens.sql`, then run its
matching final grants assertion. Retain the new principal column/data; the old
runtime ignores it. Run the old assertion before committing, then start the
previous image with its saved fallback environment and verify authentication.
Native tokens must remain disabled during this rollback; the old runtime does
not use their stored principals. For Qubes, retain its OAuth-only environment
and keep the new ingress strip in place until the key door is confirmed off;
only then restore the previous ingress image if necessary. A full database
restore is a separate recovery action and can discard post-backup writes.

## Storage and roles

Tokens contain a 48-bit public lookup prefix and a 256-bit random secret.
`native_auth.access_token` stores its digest, label, principal and lifecycle
metadata. The runtime can read exactly prefix/hash/label/principal/revocation;
the administrator lists metadata and invokes fixed-search-path owner-controlled
functions, with no hash/memory reads or direct table mutations. Full grants
assertions and database tests cover these boundaries.

Backups include hashes, principals and revocation state. Restoring one can
reactivate credentials revoked since that backup; review restored inventory.
Protect dumps as credential material. Plaintext tokens cannot be reconstructed.

The lifecycle shape was informed by the MIT-licensed
[memory-vault project](https://github.com/MihaiBuilds/memory-vault).
