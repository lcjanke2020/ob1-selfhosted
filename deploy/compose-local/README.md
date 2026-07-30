# Install path 1 — Local docker-compose

The simplest deployment: Postgres + pgvector, the MCP server, and Ollama on one machine, every port bound to `127.0.0.1`, gated by a shared `x-brain-key` header. Nothing here needs Tailscale, a GPU, or even an always-on box — it runs fine on a laptop or a locked-down work machine where all you have is Docker.

If you later want other devices (or claude.ai / your phone) to reach the same store, the [tailnet install](../compose-tailnet/README.md) reuses this compose file unchanged — you upgrade by adding files, not editing them.

## Prerequisites

- Docker Engine with the compose plugin (compose v2)
- ~2 GB disk for the Ollama embedding model, plus your database

A GPU is optional. The compose file requests one for Ollama by default; on a CPU-only box, comment out the `deploy:` block under the `ollama:` service — `nomic-embed-text` on CPU is slower per request but still sub-second.

## Setup

### 1. Secrets and config

```bash
cd deploy/compose-local
cp .env.example .env

# Generate strong values and paste into .env:
openssl rand -hex 24    # POSTGRES_PASSWORD
openssl rand -hex 24    # OPENBRAIN_APP_PASSWORD
openssl rand -hex 24    # OPENBRAIN_READONLY_PASSWORD
openssl rand -hex 32    # MCP_ACCESS_KEY  (minimum 32 chars — enforced at boot)
```

To use personal visibility and the seeded `sensitive` space on this single-user
shared-key install, also set a stable, non-secret `MCP_ACCESS_KEY_PRINCIPAL`
(for example `local-owner`). Without it, personal scope fails closed because a
shared key is not an identity. See [Memory spaces](../../docs/spaces.md).

Also choose `METADATA_FALLBACK_POLICY` explicitly; there is no default. Use
`off` for a local-only posture (a primary-classifier failure stores placeholder
metadata and never calls `FALLBACK_CHAT_*`), `alert` to permit fallback only
with a configured Pushover/ntfy channel, or `allow` to permit fallback without
requiring delivery. `allow` is the privacy-weakest option. The server prints the
active choice as `[metadata] fallback policy: ...` at every boot.

### 2. Pre-pull the embedding model

One-time, so the first capture isn't slow:

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull nomic-embed-text
```

(Using an Ollama that already runs elsewhere? Skip this, remove the `ollama` service, and point `OLLAMA_URL` in `.env` at it.)

### 3. Start everything

> **SELinux hosts (Fedora, RHEL, Qubes).** Before the first start, relabel the DB init-script directory so the postgres container can read it:
>
> ```bash
> chcon -Rt container_file_t ../../db
> ```
>
> Without this, postgres logs `Permission denied opening /docker-entrypoint-initdb.d/`, never becomes healthy, and `mcp`'s `depends_on` keeps it from starting. The label persists in the filesystem — one-time fix per checkout.

```bash
docker compose up -d
docker compose logs -f mcp
```

You should see `open-brain-homelab listening on :8787`. The Postgres init scripts (roles, pgvector schema, observability tables, sessions schema, hybrid-search indexes, fail-closed spaces/RLS) run on the first startup only.

### 4. Smoke-test

```bash
# Public health endpoint (no auth, doesn't touch the DB):
curl http://127.0.0.1:8787/health

# Readiness probe (confirms the DB is reachable). Unauthenticated, but
# internal-only — on a funnel deployment Caddy returns 404 for /ready on the
# public branch, so it stays reachable from loopback/LAN/in-qube only:
curl http://127.0.0.1:8787/ready
```

### 5. Connect a client

The server is gated by an `x-brain-key` header, and is deliberately header-only (no query-string auth — query strings leak into logs and referrers). Claude Desktop's custom-connector UI only offers OAuth fields, so wire the connection through the `mcpServers` config block instead, using [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a stdio→HTTP bridge that injects the header:

| Client | OS | Config file |
|---|---|---|
| Claude Desktop | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | any | `~/.claude.json` |

```json
{
  "mcpServers": {
    "openbrain": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://127.0.0.1:8787/mcp",
        "--header", "x-brain-key: <the value you set in .env>"
      ]
    }
  }
}
```

`mcp-remote` allows plain HTTP for localhost URLs; if your version refuses, add `--allow-http`. It also needs **Node 20+** — on older Node its bundled `undici` dies with `ReferenceError: File is not defined` before any JSON-RPC flows.

> **Windows gotcha.** Claude Desktop spawns subprocesses without a shell, so PATH entries from a node-version manager (`fnm`, `nvm-windows`) often aren't visible — you'll see `spawn npx ENOENT` in the connector log. If you have Bun, `"command": "bun", "args": ["x", "mcp-remote", ...]` usually works out of the box; otherwise hard-code the full path to `npx.cmd`.

After installing or upgrading to server 1.9.0, reconnect or restart the client
so the connector fetches the new scope-aware tool schemas. It should then list
**eleven tools**: `capture_thought`, `search_thoughts`, `list_thoughts`,
`thought_stats`, `search`, `fetch`, plus `session_capture`, `session_lookup`,
`session_search`, `session_list`, `session_update_status`. Test by saying
*"remember that I set up Open Brain today."*

## Verification checklist

1. `docker compose ps` — postgres `(healthy)`, mcp running, ollama running.
2. `docker compose logs postgres` — init scripts ran without errors.
3. `psql 'postgresql://openbrain_readonly:PASS@127.0.0.1/openbrain' -c 'SELECT count(*) FROM thoughts'` returns `0`.
4. The same connection rejects `INSERT` (`permission denied`) — the read-only role works.
5. `curl http://127.0.0.1:8787/health` returns `{"ok":true,...}`.
6. Capture a thought from your client; `SELECT id, vector_dims(embedding) FROM thoughts` shows `768` (or your `EMBED_DIM`).
7. Ask the client "what have I captured?" — hybrid search returns the thought by meaning or exact text.
8. Capture the *same* text again — the row count stays at 1 (dedupe by `content_fingerprint`).
9. `docker compose restart` — thoughts survive.

## Upgrading an existing database for hybrid search, spaces, and metadata audit

Postgres init files run only when the data directory is first created. Before
deploying a server version that uses hybrid thought search, verify pgvector is
0.8.0 or newer with
`SELECT extversion FROM pg_extension WHERE extname = 'vector';` and apply the
idempotent lexical-search migration as the database owner. If the extension is
older, update the pinned pgvector image/package and run
`ALTER EXTENSION vector UPDATE;` before the migration:

```bash
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/05-hybrid-search.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/06-spaces.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/07-metadata-degradation.sql
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d openbrain \
  < ../../db/03-grants-assertion.sql
docker compose build mcp
docker compose up -d --no-deps mcp
```

The migration backfills a stored `tsvector` under an access-exclusive lock that
is held through both regular GIN index builds until commit, blocking searches
and captures for the migration's duration. Use a full application maintenance
window on a large `thoughts` table and budget disk for the column plus both
indexes.
`06-spaces.sql` requires PostgreSQL 15 or newer and the `postgres` superuser. It
then backfills legacy thoughts and sessions into the `default` workspace, adds
audience-aware indexes, and forces RLS; it also takes table locks, so keep the
same maintenance window through both migrations. Migration 07 then adds the
append-only metadata-degradation audit, transactional outbox, and notification
ledger; it does not rewrite `thoughts` or build an index over that table. The
updated server refuses to boot until all three schema contracts exist.
It also refuses to boot until `METADATA_FALLBACK_POLICY` is explicitly set;
choose `off`, `alert`, or `allow` in `.env` before recreating the container.
Re-running the files is safe,
but re-running `06-spaces.sql` still rebuilds its fingerprint index and needs the
full lock window and index headroom. Details are in
[`docs/hybrid-search.md`](../../docs/hybrid-search.md) and
[`docs/spaces.md`](../../docs/spaces.md); alert configuration and audit queries
are in [metadata degradation monitoring](../../docs/metadata-degradation-monitoring.md).

## Common gotchas

- **Embedding dimension mismatch.** If `EMBED_DIM` doesn't match what your model returns, every capture fails with a clear error. Fix `EMBED_DIM` (and `vector(N)` in `../../db/01-schema.sql` if the DB is already initialized).
- **Schema didn't run.** Postgres only runs `/docker-entrypoint-initdb.d/*` when the data dir is empty. After a schema change, either apply it manually with `psql` or `docker compose down -v` to wipe the volume (destroys all thoughts).
- **Host port already in use.** If the box already runs postgres (or anything else) on `5432`, the stack fails to start with `failed to bind host port 127.0.0.1:5432`. Change the host side of the mapping in `docker-compose.yml` (e.g. `"127.0.0.1:15432:5432"`) — the containers talk over the docker network, so only your direct-psql habits change. Same applies to `8787`/`11434`.
- **No GPU detected for Ollama.** Install the NVIDIA Container Toolkit, or remove the `deploy: resources:` block from the `ollama` service.
- **Metadata extraction degrading.** With `CHAT_API_BASE`/`CHAT_MODEL` unset or
  unreachable, capture still works. Policy `off` stores
  `{topics: [uncategorized], type: observation}` without contacting the
  fallback; `alert` or `allow` may classify through `FALLBACK_CHAT_*` when it is
  configured. A configured path that fails is recorded in the durable audit;
  `alert` additionally requires content-free Pushover/ntfy delivery at boot.
  See [metadata degradation monitoring](../../docs/metadata-degradation-monitoring.md).

## Backups

This is your memory. Back it up.

```bash
# Daily, via cron:
docker compose exec -T postgres pg_dump -U postgres openbrain | gzip > /backups/openbrain-$(date +%Y%m%d).sql.gz

# Restore:
gunzip -c /backups/openbrain-20260503.sql.gz | docker compose exec -T postgres psql -U postgres openbrain
```

If you switch embedding models later, old embeddings are mathematically incompatible with the new model — re-embed all rows from the original `content` text.

## Key rotation

`MCP_ACCESS_KEY` is the door to every registered non-personal audience (and to
the one configured personal principal, when bound). Rotate it on a regular
cadence and immediately if it ever leaves trusted hands:

```bash
NEW_KEY=$(openssl rand -hex 32)
sed -i.bak "s|^MCP_ACCESS_KEY=.*|MCP_ACCESS_KEY=$NEW_KEY|" .env && rm .env.bak
docker compose up -d --force-recreate mcp
echo "$NEW_KEY"   # paste into each client config, then forget it
unset NEW_KEY
```

Data at rest is untouched — the key only gates the MCP transport.
