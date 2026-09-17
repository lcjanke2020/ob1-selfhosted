# Install path 1 — Local docker-compose

The simplest deployment: Postgres + pgvector, the MCP server, and Ollama on one
machine, every port bound to `127.0.0.1`, gated by labeled, independently
revocable tokens in the `x-brain-key` header. Nothing here needs Tailscale, an
identity provider, a GPU, or even an always-on box — it runs fine on a laptop or
a locked-down work machine where all you have is Docker.

If you later want other devices (or claude.ai / your phone) to reach the same
store, the [tailnet install](../compose-tailnet/README.md) reuses this compose
file unchanged — you upgrade by adding files, not editing them.

## Prerequisites

- Docker Engine with the compose plugin (compose v2)
- ~2 GB disk for the Ollama embedding model, plus your database

A GPU is optional. The compose file requests one for Ollama by default; on a
CPU-only box, comment out the `deploy:` block under the `ollama:` service —
`nomic-embed-text` on CPU is slower per request but still sub-second.

## Setup

### 1. Secrets and config

```bash
cd deploy/compose-local
cp .env.example .env

# Generate strong values and paste into .env:
openssl rand -hex 24    # POSTGRES_PASSWORD
openssl rand -hex 24    # OPENBRAIN_APP_PASSWORD
openssl rand -hex 24    # OPENBRAIN_AUTH_ROLLUP_PASSWORD
openssl rand -hex 24    # OPENBRAIN_READONLY_PASSWORD
openssl rand -hex 24    # OPENBRAIN_TOKEN_ADMIN_PASSWORD
```

Keep `ENABLE_NATIVE_TOKENS=true`, paste the five generated database passwords,
and leave `MCP_ACCESS_KEY` empty on a new install. That static key is supported
as a migration bridge for older clients.

New native tokens use `--principal native:<id>` for personal and `sensitive`
memory. Keep that principal stable across rotations; use a distinct principal
for each role that needs isolated personal memory. `MCP_ACCESS_KEY_PRINCIPAL` is
only for a configured legacy static key. See
[Memory spaces](../../docs/spaces.md).

The server requires `METADATA_FALLBACK_POLICY`; the copied `.env.example`
preselects `off`, the strictest posture, so the cold-start path works without
weakening privacy. Keep `off` for a local-only posture (a primary-classifier
failure stores placeholder metadata and never calls `FALLBACK_CHAT_*`), or
deliberately change it to `alert` to permit fallback only with a configured
Pushover/ntfy channel, or `allow` to permit fallback without requiring delivery.
`allow` is the privacy-weakest option. The server prints the active choice as
`[metadata] fallback policy: ...` at every boot.

### 2. Pre-pull the embedding model

One-time, so the first capture isn't slow:

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull nomic-embed-text
```

(Using an Ollama that already runs elsewhere? Skip this, remove the `ollama`
service, and point `OLLAMA_URL` in `.env` at it.)

### 3. Initialize the database and activate embeddings

> **SELinux hosts (Fedora, RHEL, Qubes).** Before the first start, relabel the
> DB init-script directory so the postgres container can read it:
>
> ```bash
> chcon -Rt container_file_t ../../db
> ```
>
> Without this, postgres logs
> `Permission denied opening /docker-entrypoint-initdb.d/`, never becomes
> healthy, and `mcp`'s `depends_on` keeps it from starting. The label persists
> in the filesystem — one-time fix per checkout.

```bash
docker compose --env-file .env up -d --wait postgres
docker compose --env-file .env build mcp
```

Before starting MCP, complete the
[superuser backfill plan and activation](../../docs/embedding-limits.md#compose-backfill-runner).
This is required even for an empty database: migration 15 leaves the generation
inactive. After the command succeeds and prints `activated`, start the server:

```bash
docker compose --env-file .env up -d --no-deps mcp
docker compose logs -f mcp
```

You should see `open-brain-homelab listening on :8787`. The Postgres init
scripts (corpus roles, pgvector schema, auth-event observability, sessions,
hybrid-search indexes, fail-closed spaces/RLS, and hash-only token storage) run
on the first startup only.

### 4. Issue a client token

The profile-gated administrator runs only for an explicit lifecycle command and
has no access to memories or token hashes:

```bash
docker compose --profile tools run --rm token-admin create "laptop client" --principal native:laptop
```

Copy the printed token now; Open Brain stores only its SHA-256 digest and cannot
show it again. See [Native access tokens](../../docs/native-access-tokens.md)
for list, revoke, rotation, recovery, and existing-database procedures.

### 5. Smoke-test

```bash
# Public health endpoint (no auth, doesn't touch the DB):
curl http://127.0.0.1:8787/health

# Readiness probe (confirms the DB is reachable). Unauthenticated, but
# internal-only — on a funnel deployment Caddy returns 404 for /ready on the
# public branch, so it stays reachable from loopback/LAN/in-qube only:
curl http://127.0.0.1:8787/ready
```

### 6. Connect a client

The server accepts the issued token in `x-brain-key` and is deliberately
header-only (no query-string auth — query strings leak into logs and referrers).
Claude Desktop's custom-connector UI only offers OAuth fields, so wire the
connection through the `mcpServers` config block instead, using
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a stdio→HTTP bridge
that injects the header:

| Client         | OS      | Config file                                                       |
| -------------- | ------- | ----------------------------------------------------------------- |
| Claude Desktop | macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop | Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Claude Code    | any     | `~/.claude.json`                                                  |

```json
{
  "mcpServers": {
    "openbrain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8787/mcp",
        "--header",
        "x-brain-key: <the one-time token from step 4>"
      ]
    }
  }
}
```

`mcp-remote` allows plain HTTP for localhost URLs; if your version refuses, add
`--allow-http`. It also needs **Node 20+** — on older Node its bundled `undici`
dies with `ReferenceError: File is not defined` before any JSON-RPC flows.

> **Windows gotcha.** Claude Desktop spawns subprocesses without a shell, so
> PATH entries from a node-version manager (`fnm`, `nvm-windows`) often aren't
> visible — you'll see `spawn npx ENOENT` in the connector log. If you have Bun,
> `"command": "bun", "args": ["x", "mcp-remote", ...]` usually works out of the
> box; otherwise hard-code the full path to `npx.cmd`.

After installing or upgrading to server 1.9.0, reconnect or restart the client
so the connector fetches the new scope-aware tool schemas. It should then list
**eleven tools**: `capture_thought`, `search_thoughts`, `list_thoughts`,
`thought_stats`, `search`, `fetch`, plus `session_capture`, `session_lookup`,
`session_search`, `session_list`, `session_update_status`. Test by saying
_"remember that I set up Open Brain today."_

## Verification checklist

1. `docker compose ps` — postgres `(healthy)`, mcp running, ollama running.
2. `docker compose logs postgres` — init scripts ran without errors.
3. `psql 'postgresql://openbrain_readonly:PASS@127.0.0.1/openbrain' -c 'SELECT count(*) FROM thoughts'`
   returns `0`.
4. The same connection rejects `INSERT` (`permission denied`) — the read-only
   role works.
5. `curl http://127.0.0.1:8787/health` returns `{"ok":true,...}`.
6. Capture a thought from your client;
   `SELECT id, vector_dims(embedding) FROM thoughts` shows `768` (or your
   `EMBED_DIM`).
7. Ask the client "what have I captured?" — hybrid search returns the thought by
   meaning or exact text.
8. Capture the _same_ text again — the row count stays at 1 (dedupe by
   `content_fingerprint`).
9. `docker compose --profile tools run --rm token-admin list` shows the client
   label and prefix but no plaintext or hash.
10. `docker compose restart` — thoughts and the active token survive.

## Upgrading an existing database

**Adopting the `COMPOSE_PROJECT_NAME` line** (stacks whose `.env` predates it):
set it to the name `docker compose ls` reports for your running stack — for a
stack started from this directory before the pin existed, that is typically
`compose-local`, not the example's `openbrain`. A changed project name strands
the running containers and re-homes named volumes — including `postgres_data` —
to a fresh, empty project.

Postgres init files run only when the data directory is first created. Before
deploying a server version that uses hybrid thought search, verify pgvector is
0.8.0 or newer with
`SELECT extversion FROM pg_extension WHERE extname = 'vector';` and apply the
idempotent lexical-search migration as the database owner. If the extension is
older, update the pinned pgvector image/package and run
`ALTER EXTENSION vector UPDATE;` before the migration:

Run this as one block. The subshell's `set -e` makes every next step conditional
on the previous one: a build failure leaves the current MCP serving, while any
post-stop failure exits before the MCP restart and leaves it quiesced for
diagnosis. The block uses Python 3 to detect OAuth from the rendered MCP
configuration. An OAuth-off deployment skips import and verification; an
OAuth-enabled deployment must complete them. For later upgrades after legacy env
removal, omit only the `import-env` command, still list and verify
active/revoked admission. If enabling OAuth without a legacy list, enroll the
intended subjects with `subject-admin allow` first and follow that same
list/verify path.

```bash
(
set -eo pipefail
# Inspect the rendered MCP settings without printing configuration values.
# Python 3 reads JSON on stdin; only the yes/no result leaves this pipeline.
oauth_enabled="$(docker compose --env-file .env config --format json | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["mcp"]["environment"]
print("yes" if any(env.get(k) for k in ("AUTH0_ISSUER", "AUTH0_JWKS_URI", "AUTH0_AUDIENCE")) else "no")
')"
# Build the replacement while the current MCP is still serving. Migration 11
# is intentionally incompatible with pre-1.24 recapture SQL, so quiesce MCP
# before replaying the database files and leave it stopped on any SQL failure.
docker compose --env-file .env build mcp subject-admin token-admin
# 1.25.0+: after setting OPENBRAIN_AUTH_ROLLUP_PASSWORD in .env, provision the
# dedicated role before replaying 02-observability.sql, which now grants to it.
bash ../../scripts/upgrade-enable-auth-rollup-role.sh .
docker compose --env-file .env stop mcp
# 1.20.0+: converges mcp_auth_events to the allowed+denied audit shape in
# place (idempotent). The server's boot probe refuses to start against the
# old denied-only shape, so skipping this step turns the container roll
# below into a loud restart loop rather than a silently dead audit trail.
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/02-observability.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/05-hybrid-search.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/06-spaces.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/07-metadata-degradation.sql
# After setting OPENBRAIN_TOKEN_ADMIN_PASSWORD in .env:
COMPOSE_DIR="$PWD" bash ../../scripts/upgrade-enable-token-admin-role.sh
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/08-access-tokens.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/09-retire-corpus-funnel.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/10-thought-mutations.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/11-session-update-grants.sql
docker compose --env-file .env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/12-auth-audit-grants.sql
docker compose --env-file .env exec -T postgres \
  psql -X --single-transaction -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/13-oauth-subjects.sql
docker compose --env-file .env exec -T postgres \
  psql -X --single-transaction -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/14-native-token-principals.sql
# Migration 15 manages its own transaction. Assert only after it commits.
docker compose --env-file .env exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/15-embedding-index.sql
docker compose --env-file .env exec -T postgres \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/03-grants-assertion.sql
# The Compose-backed summary reads its credential inside this service. Recreate
# Postgres once so the newly-added environment value reaches the container;
# the named data volume is preserved.
docker compose --env-file .env up -d --no-deps --force-recreate --wait postgres
if [ "$oauth_enabled" = yes ]; then
  # First upgrade to database admission; later upgrades omit only import-env.
  docker compose --env-file .env --profile tools run --rm subject-admin import-env --json
  docker compose --env-file .env --profile tools run --rm subject-admin list --json
  # Compare exact subjects/kinds and revocations, then remove both legacy env lists.
  read -r -p 'Inventory verified and legacy env lists removed? Type verified: ' admission_review
  test "$admission_review" = verified
fi
# MCP is still stopped. Switch only the embedding backend during maintenance.
docker compose --env-file .env up -d --no-deps ollama
)
```

For **1.28.0**, keep all corpus writers/search consumers stopped and complete
the
[superuser backfill plan and activation](../../docs/embedding-limits.md#compose-backfill-runner)
against the validated runtime. With an external Ollama, switch/validate that
backend instead of the last Compose command. Do not resume the old app against
the corrected runtime. Only after successful activation:

```bash
docker compose --env-file .env up -d --no-deps mcp
docker compose --env-file .env logs mcp
```

Upgrading to **1.25.0+** adds a dedicated `openbrain_auth_rollup` login for the
auth-event report and retention pass. Set its new password, run the role helper
while the current server is still live, then apply `12-auth-audit-grants.sql`.
The migration removes auth-event UPDATE/DELETE from `openbrain_app`, grants the
new role SELECT/DELETE on that table alone, and is safe to reapply. The boot
probe and final assertion reject both the historical broad app grant and an
over-privileged rollup role. The controlled Postgres recreation at the end
preserves the named data volume and makes the new credential available to the
Compose-backed summary job.

Migration 09 is the Arc B corpus boundary. On an older data directory it refuses
to drop either legacy Funnel table while it contains a row. If this database
ever ran Pattern B, follow the archive, verified-restore, explicit truncate, and
sink-cutover procedure in
[`compose-tailnet/README.md`](../compose-tailnet/README.md#upgrading-an-existing-deployment)
before this block. Even a pure local install must inspect both tables rather
than bypass the guard; the final assertion rejects the old relations and edge
role names entirely.

> **OAuth-enabled upgrades:** complete the
> [admission-table migration](../../docs/oauth-subjects.md) before the MCP roll.
> Having the old environment allowlist alone no longer grants access.

The migration backfills a stored `tsvector` under an access-exclusive lock that
is held through both regular GIN index builds until commit, blocking searches
and captures for the migration's duration. Use a full application maintenance
window on a large `thoughts` table and budget disk for the column plus both
indexes. `06-spaces.sql` requires PostgreSQL 15 or newer and the `postgres`
superuser. It then backfills legacy thoughts and sessions into the `default`
workspace, adds audience-aware indexes, and forces RLS; it also takes table
locks, so keep the same maintenance window through both migrations. Migration 07
adds the append-only metadata-degradation audit, transactional outbox, and
notification ledger; it does not rewrite `thoughts` or build an index over that
table. Migration 08 adds hash-only native-token storage and the dedicated
lifecycle role/functions. The updated server refuses to boot until all four
schema contracts exist. It also refuses to boot until `METADATA_FALLBACK_POLICY`
is explicitly set; choose `off`, `alert`, or `allow` in `.env` before recreating
the container. Re-running the files is safe, but re-running `06-spaces.sql`
still rebuilds its fingerprint index and needs the full lock window and index
headroom. Details are in [`docs/hybrid-search.md`](../../docs/hybrid-search.md)
and [`docs/spaces.md`](../../docs/spaces.md); alert configuration and audit
queries are in
[metadata degradation monitoring](../../docs/metadata-degradation-monitoring.md).
Native token rollout and static-key migration are in
[Native access tokens](../../docs/native-access-tokens.md).

## Common gotchas

- **Embedding dimension mismatch.** If `EMBED_DIM` doesn't match what your model
  returns, every capture fails with a clear error. Fix `EMBED_DIM` (and
  `vector(N)` in `../../db/01-schema.sql` if the DB is already initialized).
- **Schema didn't run.** Postgres only runs `/docker-entrypoint-initdb.d/*` when
  the data dir is empty. After a schema change, either apply it manually with
  `psql` or `docker compose down -v` to wipe the volume (destroys all thoughts).
- **Host port already in use.** If the box already runs postgres (or anything
  else) on `5432`, the stack fails to start with
  `failed to bind host port 127.0.0.1:5432`. Change the host side of the mapping
  in `docker-compose.yml` (e.g. `"127.0.0.1:15432:5432"`) — the containers talk
  over the docker network, so only your direct-psql habits change. Same applies
  to `8787`/`11434`.
- **No GPU detected for Ollama.** Install the NVIDIA Container Toolkit, or
  remove the `deploy: resources:` block from the `ollama` service.
- **Metadata extraction degrading.** With `CHAT_API_BASE`/`CHAT_MODEL` unset or
  unreachable, capture still works. Policy `off` stores
  `{topics: [uncategorized], type: observation}` without contacting the
  fallback; `alert` or `allow` may classify through `FALLBACK_CHAT_*` when it is
  configured. A configured path that fails is recorded in the durable audit;
  `alert` additionally requires a fully configured Pushover/ntfy adapter at
  boot. Provider reachability and delivery remain best-effort: live-fire the
  configured path and watch `[metadata_notify] ... delivery failed` plus
  `last_failed_channels` before relying on it. See
  [metadata degradation monitoring](../../docs/metadata-degradation-monitoring.md).

## Backups

This is your memory. Back it up.

```bash
# Daily, via cron:
docker compose exec -T postgres pg_dump -U postgres openbrain | gzip > /backups/openbrain-$(date +%Y%m%d).sql.gz

# Restore:
gunzip -c /backups/openbrain-20260503.sql.gz | docker compose exec -T postgres psql -U postgres openbrain
```

If you switch embedding models later, old embeddings are mathematically
incompatible with the new model — re-embed all rows from the original `content`
text.

## Key rotation

Native tokens rotate without restarting Open Brain or disrupting other clients:

```bash
# Look up the old prefix and reuse its exact non-null principal.
docker compose --profile tools run --rm token-admin list --json
# Example: the old token's principal is native:laptop.
docker compose --profile tools run --rm token-admin \
  create "laptop replacement" --principal native:laptop
# Update and smoke-test that client, then revoke the old public prefix:
docker compose --profile tools run --rm token-admin revoke ob1_AAAAAAAA
```

The replacement must use the old token's principal, not its label or prefix, to
retain personal ownership. A legacy token with `principal=null` has no stored
identity to reuse: assign an explicit principal and follow the
[legacy personal-memory recovery procedure](../../docs/native-access-tokens.md#preserve-access-to-older-personal-rows).

The revoked credential receives HTTP 401 on its next request. Data at rest is
untouched. If an older deployment still uses `MCP_ACCESS_KEY`, migrate clients
one at a time and verify access to any older personal rows before removing that
variable and recreating `mcp`. Keep the local recovery credential described in
that procedure while an ownership migration is pending. The static key is not
represented in the token inventory and cannot be revoked there.

## Database-backed OAuth admission

Use the [complete upgrade procedure](#upgrading-an-existing-database), including
migrations through 15 and embedding activation before MCP starts. At its
admission stage, import or explicitly enroll existing OAuth subjects with the
tools-profile `subject-admin` CLI. Follow
[OAuth subject admission](../../docs/oauth-subjects.md) for the dedicated
administrator setup, identity verification and authentication rollback details.
Legacy `OAUTH_ALLOWED_SUBJECTS` / `OAUTH_SERVICE_ACCOUNT_SUBJECTS` values are
transition inputs only; they no longer authorize or classify requests. After
import, remove them from the deployment environment. Enrollment and revocation
then apply on the next request without restarting the server.

Server 1.27.0 also requires migration 14 for per-token principals. Remove
`MCP_ACCESS_KEY_PRINCIPAL` if the static key is unset; native tokens no longer
inherit it. Existing tokens retain workspace/project access but require a
rotation with an explicit principal for personal memory. Before production
upgrade, rehearse the migration and final assertion in one transaction and
verify rollback. See
[native token upgrade](../../docs/native-access-tokens.md#existing-database-upgrade).
