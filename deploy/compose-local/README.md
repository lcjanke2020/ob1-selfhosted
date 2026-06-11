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

You should see `open-brain-homelab listening on :8787`. The Postgres init scripts (roles, pgvector schema, observability tables, sessions schema) run on the first startup only.

### 4. Smoke-test

```bash
# Public health endpoint (no auth, doesn't touch the DB):
curl http://127.0.0.1:8787/health

# Auth-gated readiness probe (confirms the DB is reachable):
curl http://127.0.0.1:8787/ready -H "x-brain-key: <your MCP_ACCESS_KEY>"
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

After a client restart, the connector should list **eleven tools**: `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`, `search`, `fetch`, plus `session_capture`, `session_resume`, `session_search`, `session_list`, `session_update_status`. Test by saying *"remember that I set up Open Brain today."*

## Verification checklist

1. `docker compose ps` — postgres `(healthy)`, mcp running, ollama running.
2. `docker compose logs postgres` — init scripts ran without errors.
3. `psql 'postgresql://openbrain_readonly:PASS@127.0.0.1/openbrain' -c 'SELECT count(*) FROM thoughts'` returns `0`.
4. The same connection rejects `INSERT` (`permission denied`) — the read-only role works.
5. `curl http://127.0.0.1:8787/health` returns `{"ok":true,...}`.
6. Capture a thought from your client; `SELECT id, vector_dims(embedding) FROM thoughts` shows `768` (or your `EMBED_DIM`).
7. Ask the client "what have I captured?" — semantic search returns the thought.
8. Capture the *same* text again — the row count stays at 1 (dedupe by `content_fingerprint`).
9. `docker compose restart` — thoughts survive.

## Common gotchas

- **Embedding dimension mismatch.** If `EMBED_DIM` doesn't match what your model returns, every capture fails with a clear error. Fix `EMBED_DIM` (and `vector(N)` in `../../db/01-schema.sql` if the DB is already initialized).
- **Schema didn't run.** Postgres only runs `/docker-entrypoint-initdb.d/*` when the data dir is empty. After a schema change, either apply it manually with `psql` or `docker compose down -v` to wipe the volume (destroys all thoughts).
- **Host port already in use.** If the box already runs postgres (or anything else) on `5432`, the stack fails to start with `failed to bind host port 127.0.0.1:5432`. Change the host side of the mapping in `docker-compose.yml` (e.g. `"127.0.0.1:15432:5432"`) — the containers talk over the docker network, so only your direct-psql habits change. Same applies to `8787`/`11434`.
- **No GPU detected for Ollama.** Install the NVIDIA Container Toolkit, or remove the `deploy: resources:` block from the `ollama` service.
- **Metadata extraction silently degrading.** With `CHAT_API_BASE`/`CHAT_MODEL` unset (or unreachable), capture still works but every thought gets `{topics: [uncategorized], type: observation}`. Point them at a chat-capable Ollama model or any OpenAI-compatible endpoint to enable real extraction.

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

`MCP_ACCESS_KEY` is the only thing standing between a key-holder and full read/write. Rotate on a regular cadence and immediately if it ever leaves trusted hands:

```bash
NEW_KEY=$(openssl rand -hex 32)
sed -i.bak "s|^MCP_ACCESS_KEY=.*|MCP_ACCESS_KEY=$NEW_KEY|" .env && rm .env.bak
docker compose up -d --force-recreate mcp
echo "$NEW_KEY"   # paste into each client config, then forget it
unset NEW_KEY
```

Data at rest is untouched — the key only gates the MCP transport.
