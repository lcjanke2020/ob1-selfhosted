# Memory spaces

Spaces partition thoughts and work sessions by workspace, optional project, and
visibility. The boundary is enforced twice: the server validates and resolves a
request's scope, then PostgreSQL row-level security (RLS) applies that audience
to every application-role query. Missing database context matches no rows.

The contract deliberately aligns with upstream Open Brain's `workspace_id`,
`project_id`, and `visibility` vocabulary:

| Field          | Meaning                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_id` | A registered top-level memory space. Omission selects exactly `DEFAULT_WORKSPACE_ID` (`default` unless configured), never every workspace.     |
| `project_id`   | An optional registered project inside that workspace.                                                                                          |
| `visibility`   | `personal`, `project`, or `workspace`. On capture it chooses one audience; on recall it optionally narrows the readable audience to one class. |

Unknown workspaces and projects are validation errors, resolved before content
is sent to an embedder or metadata extractor. Unknown input fields are rejected
rather than stripped into an accidentally broader default.

## Capture and recall semantics

On a write, omitting `visibility` chooses project visibility when `project_id`
is present; otherwise it uses the registered workspace's default visibility. The
canonical audiences are:

- `personal`: the current trusted principal in one workspace; `project_id` is
  stored as null;
- `project`: one registered `(workspace_id, project_id)`; there is no owner;
- `workspace`: everyone admitted to one workspace; `project_id` is stored as
  null.

On a read, an explicit `visibility` reads only that class. When visibility is
omitted, the server computes the useful union inside one workspace:

- workspace-visible rows;
- project-visible rows when a project was supplied;
- the current principal's personal rows when a principal exists.

Omission never means all workspaces. A project read cannot see another project,
and a personal read cannot see another principal. Fetching or updating a known
row ID through the wrong scope looks the same as an unknown ID.

Workspace/project registration is partitioning, not a membership directory.
Every authenticated caller may name any registered workspace or project;
`workspace` and `project` visibility are shared among those callers. Personal
visibility is the current cross-principal isolation boundary. Per-workspace
membership and role administration remain future multi-user work.

Thought deduplication follows the same audience. Identical content deduplicates
inside one exact workspace/project/visibility/owner tuple but remains distinct
across audiences.

Audience is immutable through the normal application APIs. A session recapture
or status update must use the row's stored scope; supplying another scope gets
the same not-found result as an unknown ID. Thoughts have no application-level
move or delete operation. Moving one currently means capturing it into the new
audience and having an administrator delete the old row. A safe transactional
reclassification tool that preserves deduplication and session-artifact
semantics is tracked as follow-up work.

## The seeded `sensitive` space

[`db/06-spaces.sql`](../db/06-spaces.sql) creates two reserved workspaces:

- `default`, with workspace visibility, for backward compatibility;
- `sensitive`, with personal visibility and a database constraint that rejects
  application writes at project or workspace visibility.

For MCP thought tools, supply a strict nested `scope` object:

```json
{
  "content": "A particularly sensitive thought.",
  "scope": {
    "workspace_id": "sensitive",
    "visibility": "personal"
  }
}
```

The visibility can be omitted because `sensitive` defaults to `personal`:

```json
{
  "query": "particularly sensitive",
  "scope": { "workspace_id": "sensitive" }
}
```

Session scope is authored as flat TOML fields, not a nested table:

```toml
+++
title = "Private work log"
status = "active"
workspace_id = "sensitive"
visibility = "personal"
goal = "Keep this session in my personal sensitive audience."
+++
```

For REST POST/PATCH bodies, use the same nested `scope` object as the thought
example. GET endpoints use flat query parameters such as
`?workspace_id=sensitive&visibility=personal`. Session capture remains TOML, so
its three scope fields stay inside `toml_text`.

> [!IMPORTANT]
> `sensitive` is an authorization boundary, not field-level or tablespace
> encryption. Database administrators and the read-only backup role can read it,
> and it is present in database dumps. Protect the host, database-owner
> credential, disks, and backups with controls appropriate for the content. The
> space also does not change the processing pipeline: capture content still
> reaches the configured embedding and metadata-classification endpoints, and
> recall queries reach the embedder. Use local endpoints and set
> `METADATA_FALLBACK_POLICY=off` before storing content that must not leave your
> network.

## What counts as a personal principal

OAuth requests use the verified JWT `sub`; this applies equally to user tokens
and [client-credentials service accounts](service-account-oauth-client.md). A
dedicated M2M application therefore owns its personal rows under its stable
client subject. Native `x-brain-key` tokens have distinct server-verified labels
and revocation state, but those labels are attribution rather than authorization
identities; the legacy static key likewise identifies no person. A local
native/static deployment can opt into personal/sensitive memory by binding that
whole door to one stable, server-controlled subject:

```dotenv
MCP_ACCESS_KEY_PRINCIPAL=local-owner
```

The value is deployment-wide, is never accepted from caller input, and requires
native tokens or `MCP_ACCESS_KEY` to be enabled. Leave it blank when different
credential holders should not be treated as one person. Without a verified or
configured principal, personal scope and the `sensitive` workspace fail with a
validation error.

## Registering workspaces and projects

Registry changes are administrative operations; the application role can read
the registry but cannot mutate it. Run changes through a migration/admin role
(normally `postgres`):

```sql
INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES (
  'writing', 'Writing memories', 'workspace', false
);

INSERT INTO memory_scope.project (workspace_id, id, description)
VALUES ('writing', 'book', 'Current book project');
```

IDs are trimmed, non-empty strings up to 128 characters. A personal-only
workspace must default to personal visibility. Registry rows referenced by
memory cannot be deleted or renamed casually because foreign keys use
`ON DELETE RESTRICT` and `ON UPDATE RESTRICT`.

To make omitted requests land somewhere other than `default`, register the
workspace first and set `DEFAULT_WORKSPACE_ID` on the MCP service. The boot
probe refuses to start if that workspace or the spaces schema is missing.

## Enforcement and search

Each application operation opens a transaction, installs workspace, project,
principal, and allowed visibility values with transaction-local PostgreSQL
settings, executes its queries, then commits or rolls back before releasing the
pooled connection. `FORCE ROW LEVEL SECURITY` policies protect thoughts,
sessions, and session artifacts even if an individual query forgets a scope
predicate. Missing settings match nothing, and rollback tests guard against
scope leaking through connection reuse.

The application role is the trusted middle tier: PostgreSQL custom settings are
not cryptographic claims, and someone who steals the `openbrain_app` database
credential can set them directly. RLS isolates normal authenticated callers and
fails closed on application query mistakes; it does not protect personal rows
from a compromised MCP process, application credential, database owner, or
backup role.

PostgreSQL intentionally holds non-leakproof full-text, trigram, and JSONB
predicates behind an RLS security barrier. Hybrid thought search therefore uses
a narrowly granted `SECURITY DEFINER` candidate function with fixed SQL and an
explicit copy of the audience predicate. It returns only candidate IDs and
ranks; the server joins those IDs back through the RLS-protected table before
returning content. The function revokes PostgreSQL's default `PUBLIC` execute
grant and uses a fixed system catalog search path.

The trusted `openbrain_readonly` role retains SELECT grants and `BYPASSRLS` for
administration and `pg_dump`: PostgreSQL's dump client sets `row_security=off`
and otherwise refuses to copy an RLS-protected table. It needs no permissive RLS
policy and receives no DML. `openbrain_app` is explicitly required to be a
standalone role with no memberships, superuser flag, or `BYPASSRLS`; this also
closes inherited privileges and `SET ROLE` paths. `openbrain_monitor`,
`openbrain_ingester`, and `openbrain_token_admin` receive no memory-space
access. The grants assertion is the completed-catalog check for these
invariants.

## Existing-database migration

Fresh installs apply `06-spaces.sql` after sessions and hybrid search. For an
existing deployment, PostgreSQL 15 or newer is required because audience-aware
uniqueness uses `NULLS NOT DISTINCT`. Stop or quiesce the MCP service and take a
verified backup, then run as a PostgreSQL superuser (normally `postgres`). The
superuser is required because the migration sets `BYPASSRLS` on the backup role
and creates or replaces a `LEAKPROOF` function.

A deployment whose database is not in the compose project has nothing to `exec`
into; see
[Upgrading an existing deployment](../deploy/qubes/app-qube/README.md#upgrading-an-existing-deployment)
for the equivalent over a network connection.

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/06-spaces.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/07-metadata-degradation.sql
# After setting OPENBRAIN_TOKEN_ADMIN_PASSWORD in .env:
bash ../../scripts/upgrade-enable-token-admin-role.sh
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/08-access-tokens.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/03-grants-assertion.sql
```

Migrations 07 and 08 are the next required server schemas and are included here
so the completed-catalog grant assertion remains last. Neither extends or
weakens the space boundary; see
[Metadata degradation monitoring](metadata-degradation-monitoring.md) and
[Native access tokens](native-access-tokens.md).

The migration backfills existing thoughts and sessions into the `default`
workspace at workspace visibility. It takes table locks while adding and
backfilling audience columns and rebuilding the fingerprint unique index, so use
a full maintenance window and budget index headroom. It is idempotent, but not
cheap: every reapplication intentionally restores the canonical `default` and
`sensitive` registry settings and unconditionally drops and rebuilds the
audience-aware fingerprint index. Budget the same lock window and temporary
index headroom on every run. Rollback of a completed migration is
restore-from-backup rather than dropping the new columns: once audience-aware
rows exist, removing the boundary would be a security-sensitive data merge.

After the migration, deploy the updated server and test both default and
sensitive capture/recall before reopening the service. The boot probe fails
closed if required registry rows, columns, indexes, application policies,
forced-RLS flags, or the scoped search function are absent.

## Inspiration and lineage

[MihaiBuilds/memory-vault](https://github.com/MihaiBuilds/memory-vault) helped
inspire both memory spaces and parts of this project's search improvements. Its
work is acknowledged as design inspiration; Open Brain's fail-closed RLS,
principal binding, audience-aware deduplication, and hybrid-search integration
in this repository are independently implemented for this stack's contract.
