# OAuth subject admission

A valid issuer signature proves who minted a token. Open Brain separately checks
whether the operator admitted its exact, case-sensitive `sub`. Admission now
lives in `oauth_auth.allowed_subject`; every Bearer request reads the current
row after signature, issuer, audience, expiration and subject validation. A
missing or revoked row is rejected with the usual uniform 401. A database error
also fails closed. No admission decision is cached.

Use the operator-only `subject-admin` CLI on the trusted application host. It
uses the same `openbrain_token_admin` credential as `token-admin`. There is no
new HTTP or MCP administration endpoint, listener, or authentication provider.
The runtime receives only the application password and SELECT on the three
verification columns: `subject`, `kind` and `revoked_at`. Labels remain
available only to administrators and backups. The administrator can list
admission metadata and invoke fixed-search-path functions; it cannot read
memories or token hashes, or directly change the tables. Backups include subject
labels, kinds and revocation state.

## Commands

After provisioning the administrator below, run from the deployment directory.
Keep `--env-file .env` on every Compose invocation: when `COMPOSE_FILE` selects
a base file in another directory, a bare command can inherit that directory's
`.env`, including its admitted subjects. `COMPOSE_DIR="$PWD"` similarly pins the
provisioning helper to the deployment being administered.

```bash
docker compose --env-file .env --profile tools run --rm subject-admin allow 'issuer|operator' user 'Operator'
docker compose --env-file .env --profile tools run --rm subject-admin allow 'worker@clients' service 'Scheduled worker'
docker compose --env-file .env --profile tools run --rm subject-admin list --json
docker compose --env-file .env --profile tools run --rm subject-admin revoke 'worker@clients'
```

Subjects are identities, never tokens or client secrets. Obtain and verify the
exact subject as described in
[service accounts](service-account-oauth-client.md). Quote subjects in the
shell, including ones containing `|`. Labels are optional. `allow` also updates
the label/kind of an existing entry and **explicitly re-enrolls a revoked
entry**. `revoke` preserves its row and timestamps and takes effect on the next
request; already admitted in-flight requests may finish. Repeated revoke or an
unknown subject exits 1. Invalid command syntax exits 2. `--json` is a trailing
flag; to use a label literally named `--json`, supply it followed by another
`--json`. The same applies when revoking a subject literally named `--json`: use
`subject-admin revoke '--json' --json`. Quoting alone does not distinguish that
subject from the trailing flag.

`kind=service` supplies the classification for issuers without a signed grant
claim. Auth0's signed `gty=client-credentials` still selects `door=service`,
including for a row marked `user`; both paths require an active admission row.
The verified `sub` remains the personal-memory principal. Labels and kinds do
not change ownership or memory-space access.

## Upgrade an existing database

Server 1.26.0 introduced migration 13, required even when OAuth is disabled.
Init scripts run only on fresh data directories. For existing data, preserve the
previous server image and operator configuration, take and verify a backup, and
perform the following during a deployment window. Keep admission changes frozen
until the new server passes its smoke checks.

Current 1.28.0 also requires
[migration 14](native-access-tokens.md#existing-database-upgrade), even with
native tokens disabled, plus migration 15 and embedding-generation activation.
Use the complete deployment upgrade procedure, incorporating the
authentication-specific steps below at the corresponding points:

- [Local Compose upgrade](../deploy/compose-local/README.md#upgrading-an-existing-database)
- [Pattern B upgrade](../deploy/compose-tailnet/README.md#upgrading-an-existing-deployment)
- [Split Qubes upgrade](../deploy/qubes/app-qube/README.md#upgrading-an-existing-deployment)

Each procedure keeps corpus writers/search consumers stopped through schema
migration and offline superuser embedding backfill/activation. Previously
admitted OAuth subjects remain unchanged.

1. Put a distinct `OPENBRAIN_TOKEN_ADMIN_PASSWORD` in the deployment's
   owner-only `.env`. It is used only by the tools profile. The role is
   `NOLOGIN` by default until explicitly provisioned. For an external database,
   install the role-scoped HBA entries described below before enabling LOGIN.
   For a local Compose database, run:

   ```bash
   COMPOSE_DIR="$PWD" bash ../../scripts/upgrade-enable-token-admin-role.sh
   ```

   For an external database, including the Qubes app→DB ConnectTCP path, run
   native **psql 15 or newer** from the application host via the same helper.
   `\getenv`, used to read credentials without command arguments, was added in
   [PostgreSQL 15](https://www.postgresql.org/docs/15/release-15.html):

   ```bash
   COMPOSE_DIR="$PWD" bash ../../../scripts/upgrade-enable-token-admin-role.sh --direct
   ```

   The second command is relative to `deploy/qubes/app-qube`. It uses `DB_HOST`,
   `DB_PORT`, `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` from
   `.env`. The helper reconciles LOGIN, password and restricted cluster flags in
   one transaction. Password values are passed through environment variables,
   never command arguments. It does not install or reload `pg_hba.conf`.

2. At the deployment procedure's schema-migration stage, apply all pending
   migrations through 15 as a PostgreSQL superuser, then run the current grants
   assertion. Migration 15 manages its own transaction; use the procedure's
   separate invocation rather than wrapping the entire sequence in
   `--single-transaction`. Keep MCP stopped after the assertion.

3. At the admission-inventory stage, use the tools built from the reviewed
   source to import the legacy lists **before starting the new server**:

   ```bash
   docker compose --env-file .env --profile tools run --rm subject-admin import-env --json
   docker compose --env-file .env --profile tools run --rm subject-admin list --json
   ```

   `import-env` reads `OAUTH_ALLOWED_SUBJECTS` and
   `OAUTH_SERVICE_ACCOUNT_SUBJECTS` from the tools container's environment. It
   imports only the admitted subjects, mapping the intersection with the service
   list to `kind=service`. Service-only entries do not gain admission. The
   import is atomic and serializes with other enrollment writes. Any existing
   row, **including a revoked row**, makes it skip the entire import. An empty
   allowed list is an error. A skipped import requires comparing the existing
   inventory with the intended subjects; it is not proof of a complete
   migration.

4. Verify the inventory and remove both legacy lists from `.env`. Continue the
   deployment procedure through its offline superuser embedding backfill and
   activation before starting MCP, then smoke-test each existing client. Check
   the auth audit for the expected admitted subjects and `subject_not_allowed`
   failures. An `admission_unavailable` denial means the lookup failed (for
   example, table, grants, or connectivity), rather than a bad token; check the
   DB path. Audit delivery is best-effort and can also fail during a
   database-wide outage. An empty or entirely revoked table rejects every Bearer
   and produces a loud boot warning. `/health` remains available.

The bridge is deliberately an explicit administrator step, rather than runtime
boot-time seeding: a read-only verifier must not hold enrollment credentials or
be able to resurrect access. During this transition release, legacy settings
still receive input validation and produce a deprecation warning if nonempty,
but **never authorize or classify requests**. Remove them now; the following
release can reject their presence entirely.

### Split Qubes administrator path

The shipped app-qube Compose file includes `subject-admin` and `token-admin` in
its inactive `tools` profile. Both use the existing host-side ConnectTCP
forwarder; neither depends on a local Postgres container. The DB qube remains
loopback-only. Add the following role/database-scoped records to its persistent
`pg_hba.conf`, using the existing db-qube administration path, then reload:

```conf
host openbrain openbrain_token_admin 127.0.0.1/32 scram-sha-256
host openbrain openbrain_token_admin ::1/128 scram-sha-256
```

They are also in the shipped
[HBA snippet](../deploy/qubes/db-qube/pg_hba.snippet.conf). Keep the existing
app→DB dom0 policy; no new qrexec channel or network listener is needed. Verify
the admin can list subjects in `openbrain`, and that connecting to the
`postgres` maintenance database as that role fails with no HBA entry. Keep the
role `NOLOGIN` until its credential and HBA setup are complete. Enabling the
admin login does not enable native-token HTTP authentication. The Qubes server
defaults to `ENABLE_NATIVE_TOKENS=false`; private tailnet use is a separate
[opt-in after migration 14 and verified ingress confinement](native-access-tokens.md#split-qubes-deployment).
The public Funnel branch remains OAuth-only.

### Rollback and restore

If the upgrade also changed the embedding generation, follow the
[coordinated corpus/runtime/app rollback](embedding-limits.md#reviewed-offline-migration-and-cutover).
The authentication-specific steps below do not replace that recovery procedure.

A failed migration transaction leaves the existing schema intact. Migration 13
is additive and may remain present during an application rollback. If migration
14 has also been applied, the 1.26.0 server cannot boot until its
[token registration contract is restored](native-access-tokens.md#rollback).
Restore the previous server image and its reviewed environment together. A stale
legacy allowlist can undo revocations: if admission changed after rollout,
reconcile that previous allowlist with the **current active database rows**
before restarting the older server. Do not blindly restore a pre-revocation
snapshot.

Revoke the new administrator's login
(`ALTER ROLE openbrain_token_admin NOLOGIN`) and remove its two HBA entries if
rolling back its provisioning, provided no existing token administrator depended
on that login. Keep the preserved original LOGIN state when that role was
already in use. Restoring a full database backup also restores admission as of
the backup; review and reapply later revocations before reconnecting clients.
