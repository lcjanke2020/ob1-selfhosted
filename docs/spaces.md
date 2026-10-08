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
across audiences. Only live thoughts take part: a
[forgotten](#forgetting-and-restoring-thoughts) thought never deduplicates
against a new capture.

Every operation addresses a row through its stored scope. A session recapture or
status update, and a thought update or move, must name the row's CURRENT
audience; supplying another scope gets the same not-found result as an unknown
ID. Session audience is immutable through the application APIs and, from server
1.24.0, through the application role's column-scoped database grant; thoughts
can be corrected and re-scoped in place — see
[Correcting and moving thoughts](#correcting-and-moving-thoughts) — and
[forgotten and restored](#forgetting-and-restoring-thoughts). There is no
application-level delete for either.

## Correcting and moving thoughts

Two mutation tools (server 1.22.0+; MCP `update_thought` / `move_thought`, REST
`PATCH /api/v1/thoughts/:id` / `POST /api/v1/thoughts/:id/move`) exist for the
two ways a capture goes wrong: the text is wrong, or it landed in the wrong
space. Both keep the thought's id, so citations, `fetch`, and the
metadata-degradation history keep pointing at the same row, and both preserve
`created_at`.

**`update_thought(id, content, scope?)`** replaces the content in full (it is
not a patch), re-embeds it, and re-runs metadata extraction so recall reflects
the corrected text. The fresh classifier output replaces the old; the original
capture stamps (`source`, `door`, `sub`, `token_label`) and the caller-asserted
[provenance](thought-provenance.md) survive unchanged, because they describe who
captured the thought, not who corrected it. Content identical to the stored text
is a no-op. Content whose fingerprint already exists in the same audience is
refused as a conflict (REST 409) naming the existing row, so deduplication holds
through edits.

**`move_thought(id, target, scope?)`** changes only the audience. `target` is
deliberately not the ordinary `scope` object: `workspace_id` and `visibility`
are required, `project_id` is required exactly for `project` visibility and
forbidden otherwise, and nothing falls through to the configured default
workspace or the workspace's default visibility. A move never widens implicitly;
a personal → project or personal → workspace move happens only because the owner
spelled it out. A `personal` target is owned by the caller's own verified
principal — never a caller-supplied subject — so a thought can be made
personal-to-you and nobody else. The seeded `sensitive` workspace accepts only
personal targets. Moving a thought onto identical content already present in the
target audience is refused as a conflict; moving it to the audience it is
already in is a no-op. A legacy row captured before content fingerprints existed
(`content_fingerprint IS NULL`) is deduplicated on the fingerprint derived from
its content — whether it is the row being moved or corrected, or an existing
resident of the target audience — and gains that fingerprint when it moves or
when its content is corrected; migration 10 deliberately does not backfill such
rows in bulk.

Both tools apply the same fail-closed rules as capture and recall: the caller
must be able to read the row under the requested current scope (otherwise it is
indistinguishable from an unknown id), personal targets need a trusted
principal, and unknown workspaces or projects fail validation before any
embedding work.

**Revision history.** Every update and move first snapshots the prior state —
content, metadata, workspace/project/visibility/owner, plus the subject, door,
and token label the server verified for the request — into
`public.thought_revisions` (`db/10-thought-mutations.sql`), as `change_kind`
`content` or `scope`. A third kind, `metadata`
(`db/16-thought-metadata-revisions.sql`), is written only by the
maintenance-only superuser tool that
[reclassifies legacy and stub thoughts](metadata-degradation-monitoring.md#reclassifying-legacy-and-stub-thoughts),
never by the server code: it snapshots the same prior state with door
`maintenance` and no subject or token label, because no authenticated request
made the change. The application role can append and read that history but never
rewrite or erase it. Revision rows are readable exactly when their head thought
is readable, so once a misfiled thought has been moved to a narrower audience
its earlier text is no longer visible to the audience it left. `fetch` and
search return heads only; the history is an audit trail, not a second recall
surface. Forgetting and restoring a thought append `forget` and `restore`
revisions the same way (`db/17-forget-thoughts.sql`); see
[Forgetting and restoring thoughts](#forgetting-and-restoring-thoughts). This
attribution is server-verified but still application-trusted at the database
boundary: a compromised `openbrain_app` credential can append fabricated history
or actor fields even though it cannot alter genuine rows. The rationale for
documenting that boundary instead of adding privileged mutation
triggers/functions is in the
[security model](security-model.md#known-limitations).

Under the hood, an update is an ordinary application-role `UPDATE` of the
content columns inside the row's own audience under forced RLS. A move is not:
the application role's `UPDATE` privilege on `thoughts` is column-scoped
(`content`, `embedding`, `content_fingerprint`, `metadata`, `updated_at`) and
excludes the four audience columns outright, so — independent of RLS, which by
itself would still admit an in-workspace re-scope under the union read scope —
crossing an audience is possible only through the narrowly granted
`SECURITY DEFINER` function `memory_scope.move_thought`. It re-checks source
visibility under the transaction-local settings, validates the target against
the registry and the audience-shape rules, stamps the owner from the
transaction-local principal, dedupes on the canonical fingerprint (deriving and
persisting it for a legacy row that has none), and reports a collision as an
outcome whether the pre-check found it or it landed between the pre-check and
the write. Its owner, fixed `search_path`, and app-only execute grant, and the
column-scoped table grant, are pinned by the grants assertion; the boot probe
requires the function and the history table.

## Forgetting and restoring thoughts

Two more tools (server 1.31.0+; MCP `forget_thought` / `restore_thought`, REST
`POST /api/v1/thoughts/:id/forget` / `POST /api/v1/thoughts/:id/restore`, each
with a JSON body carrying only the optional `scope`) retire a thought without
deleting it — for test captures, superseded notes, and mistakes.

**`forget_thought(id, scope?)`** removes the thought from every read path —
`search_thoughts`, `list_thoughts`, `fetch`, `thought_stats`, and the
ChatGPT-compatible `search`/`fetch` — and from `update_thought` and
`move_thought`, which then report it as not found. Its id, content, embedding,
audience, `created_at`, and revision history are kept. Forgetting an
already-forgotten thought is a no-op. Capturing the same text again later
creates a new thought with a new id rather than reviving the forgotten one.

**`restore_thought(id, scope?)`** returns a forgotten thought to recall with its
original id, content, and audience; pass the scope it was forgotten from.
Restoring a thought that is not forgotten is a no-op. If the same text has since
been captured again in that audience, the restore is refused as a conflict
(REST 409) naming the live copy, because restoring would duplicate it; forget or
correct that copy first. There is no tool that lists forgotten thoughts:
`forget_thought` returns the id, and its revision history records it.

Both follow the same rules as update and move: the caller must be able to read
the row under the requested scope (otherwise it is indistinguishable from an
unknown id), so a personal thought can be forgotten or restored only by its
owner. Each change appends a `forget` or `restore` revision with the verified
subject, door, and token label. While a thought is forgotten its revisions are
hidden along with it; they reappear on restore.

**Forgetting is not erasure.** The text stays in the database, in its revision
history and passage index, and in every backup taken while it exists; operators
with the database superuser or the read-only backup role still see it.
Permanently removing a thought is a separate, deliberately gated operation that
does not exist yet.

Under the hood (`db/17-forget-thoughts.sql`), `public.thoughts.forgotten_at`
marks a forgotten row. A restrictive row-level-security policy,
`thoughts_app_not_forgotten`, requires `forgotten_at IS NULL` for every
application-role statement, in addition to the audience policy, so every present
and future read path through the table — and the head-gated revision and
passage-index policies — loses the row at once; the application role also cannot
insert a forgotten row. It has no `UPDATE` privilege on `forgotten_at`: only the
narrowly granted `SECURITY DEFINER` functions `memory_scope.forget_thought` and
`memory_scope.restore_thought`, built like `move_thought`, set or clear it. The
functions that read thoughts with RLS bypassed — both
`memory_scope.search_thought_candidates` overloads and
`memory_scope.move_thought` — filter forgotten rows explicitly, so forgotten
thoughts never occupy search candidate slots or count as move collisions. The
audience-aware fingerprint index covers live rows only; restoring re-enters it,
which is why a live duplicate is a conflict, and a legacy row without a stored
fingerprint is compared on its derived fingerprint and gains it on restore.
`memory_scope.embedding_ready` still covers forgotten rows, and the offline
backfill keeps them indexed, so a restore needs no re-embedding. The grants
assertion and the boot probe pin the column grant, the policy, the index
predicate, the helpers' definer shape, and the filters; re-applying migration
06, 10, 15, or 16 restores a pre-forget definition and must be followed by
migration 17 again.

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
client subject. Native tokens instead use an explicit database principal,
`native:<id>`, independent of their secret and label. Reusing that principal
when rotating a token preserves personal ownership. Different principals cannot
read one another's personal thoughts or sessions. Reserve the `native:`
namespace when assigning subjects in custom OIDC issuers to avoid collisions.

Older native tokens retain `principal=NULL`: workspace/project access remains,
but personal and `sensitive` access fails closed. `MCP_ACCESS_KEY_PRINCIPAL`
applies only when the legacy static `MCP_ACCESS_KEY` is configured. It is never
a fallback for a native token. Before upgrading to 1.27.0, follow the
[legacy personal-memory recovery procedure](native-access-tokens.md#preserve-access-to-older-personal-rows)
to census both stores and preserve a reader for the old owner. A native-only
installation must remove the setting or configure the temporary local static
recovery key described there. Existing personal rows retain their old owners;
there is no automatic reassignment.

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
closes inherited privileges and `SET ROLE` paths. `openbrain_token_admin`
receives no memory-space access. The sink-only `openbrain_monitor` and
`openbrain_ingester` roles do not exist in the corpus cluster at all. The grants
assertion is the completed-catalog check for these invariants.

## Existing-database migration

Fresh installs apply `06-spaces.sql` after sessions and hybrid search. For an
existing deployment, PostgreSQL 15 or newer is required because audience-aware
uniqueness uses `NULLS NOT DISTINCT`. Take a verified backup and run migrations
as a PostgreSQL superuser (normally `postgres`). The superuser is required
because migration 06 sets `BYPASSRLS` on the backup role and creates or replaces
a `LEAKPROOF` function.

Use the complete current upgrade procedure for your deployment:

- [Local Compose upgrade](../deploy/compose-local/README.md#upgrading-an-existing-database)
- [Pattern B upgrade](../deploy/compose-tailnet/README.md#upgrading-an-existing-deployment)
- [Split Qubes upgrade](../deploy/qubes/app-qube/README.md#upgrading-an-existing-deployment)

Each procedure applies all pending migrations through 17 before the final grants
assertion. Server 1.28.0 also requires the offline superuser embedding backfill
and activation; keep all corpus writers/search consumers stopped until
activation succeeds. The split Qubes procedure uses the existing ConnectTCP
route instead of attempting to exec into a local Postgres container.

Migrations 07 and 08 neither extend nor weaken the space boundary; see
[Metadata degradation monitoring](metadata-degradation-monitoring.md) and
[Native access tokens](native-access-tokens.md). 10 adds the head-gated revision
history and the audience-move helper described in
[Correcting and moving thoughts](#correcting-and-moving-thoughts); it also
requires a superuser because the helper is a table-owner `SECURITY DEFINER`
function. Migration 11 narrows session UPDATE to refresh/status content columns
and removes direct artifact UPDATE; it is ACL-only and rewrites no rows.
Migration 12 separates request-path auth-event insertion from the dedicated
report/retention role, removes direct grant-option and persistent-object
creation drift (including dependent delegated grants), and likewise rewrites no
rows. Migration 16 only admits the `metadata` revision kind; it changes no
audience boundary and rewrites no rows. Migration 17 adds
[forgetting](#forgetting-and-restoring-thoughts): it narrows what the
application role can see inside every audience (never widens one), rewrites no
rows, and rebuilds the fingerprint index over live rows only. Because it
redefines the fingerprint index, the search and move helpers, and the
change-kind CHECK that migrations 06, 10, 15, and 16 create, re-running any of
those must be followed by re-running 17.

Migration 06 backfills existing thoughts and sessions into the `default`
workspace at workspace visibility. It takes table locks while adding and
backfilling audience columns and rebuilding the fingerprint unique index, so use
a full maintenance window and budget index headroom. It is idempotent, but not
cheap: every reapplication intentionally restores the canonical `default` and
`sensitive` registry settings and unconditionally drops and rebuilds the
audience-aware fingerprint index — in its pre-forget form, so migration 17 must
follow it. Budget the same lock window and temporary index headroom on every
run. Rollback of a completed migration is restore-from-backup rather than
dropping the new columns: once audience-aware rows exist, removing the boundary
would be a security-sensitive data merge.

After the complete upgrade and activation, test both default and sensitive
capture/recall before reopening the service. The boot probe fails closed if
required registry rows, columns, indexes, application policies, forced-RLS
flags, or the scoped search function are absent.

## Inspiration and lineage

[MihaiBuilds/memory-vault](https://github.com/MihaiBuilds/memory-vault) helped
inspire both memory spaces and parts of this project's search improvements. Its
work is acknowledged as design inspiration; Open Brain's fail-closed RLS,
principal binding, audience-aware deduplication, and hybrid-search integration
in this repository are independently implemented for this stack's contract.
