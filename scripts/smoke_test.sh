#!/bin/bash
# End-to-end install smoke test: proves a deployment actually works, not just
# that the containers are up. Idea ported from upstream OB1's
# brain-smoke-test recipe (theirs is Supabase-shaped; this one speaks our
# stack's MCP streamable-HTTP directly).
#
# Checks, in order (named, fail-fast):
#   health        GET /health (no auth) returns {ok:true}
#   ready         GET /ready (x-brain-key) returns db:"connected"
#   auth-no-key   POST /mcp without credentials → HTTP 401 (RFC 6750 signal)
#   auth-bad-key  POST /mcp with a wrong key → HTTP 200 JSON-RPC error
#                 envelope (transport-preserving shape — see docs/security-model.md)
#   initialize    MCP initialize handshake, serverInfo.name matches
#   capture       capture_thought with a unique marker; extracts the id
#   search        search_thoughts finds the marker semantically
#   fetch         fetch by id returns the marker content
#   update        update_thought metadata_patch lands; a stale
#                 if_unchanged_since is rejected with STALE_READ
#   cleanup       EXIT trap deletes the marker row via the postgres container
#                 superuser (openbrain_app has no DELETE and there is no
#                 delete tool — by design)
#
# Works for all three install paths:
#   compose-local   run as-is from anywhere in the checkout
#   compose-tailnet COMPOSE_DIR=…/deploy/compose-tailnet MCP_URL=http://127.0.0.1:9787/mcp
#                   (loopback curl carries no Tailscale-Funnel-Request header,
#                   so Caddy's tailnet branch passes the x-brain-key through)
#   qubes           same as the compose path you deployed, run inside the app qube
#
# Env overrides:
#   COMPOSE_DIR     compose project holding .env (default deploy/compose-local)
#   MCP_URL         MCP endpoint (default http://127.0.0.1:8787/mcp)
#   MCP_ACCESS_KEY  defaults to the value in $COMPOSE_DIR/.env
#
# Exit codes: 0 — all checks passed; 1 — a named check failed or a
# prerequisite (curl, jq, docker, .env) is missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$REPO_ROOT/deploy/compose-local" && pwd)}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8787/mcp}"
BASE_URL="${MCP_URL%/mcp}"

for bin in curl jq docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[smoke] prerequisite missing: $bin" >&2
    exit 1
  fi
done

cd "$COMPOSE_DIR"
if [[ ! -f .env ]]; then
  echo "[smoke] .env not found in $(pwd); set COMPOSE_DIR to your compose directory" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. .env
set +a
: "${MCP_ACCESS_KEY:?MCP_ACCESS_KEY must be set in .env (or the environment)}"

MARKER="ob1-smoke-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
MARKER_CONTENT="Open Brain install smoke test marker $MARKER — safe to delete."
CAPTURED=false

# Cleanup runs on EXIT — also after a mid-run failure — so a half-finished
# smoke test never leaves marker rows behind. openbrain_app deliberately has
# no DELETE privilege and the server exposes no delete tool, so cleanup goes
# through the container superuser, with psql's --set/:'var' substitution so
# the marker is never interpolated into SQL by the shell.
cleanup() {
  if [[ "$CAPTURED" == true ]]; then
    if ! docker compose exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-openbrain}" \
      --set=marker="$MARKER" >/dev/null <<-'EOSQL'
	DELETE FROM thoughts WHERE content LIKE '%' || :'marker' || '%';
	EOSQL
    then
      echo "[smoke] WARNING: cleanup failed — delete rows matching $MARKER manually" >&2
    fi
  fi
}
trap cleanup EXIT

fail() {
  echo "[smoke] FAIL ($1): $2" >&2
  exit 1
}

pass() {
  echo "[smoke] ok: $1"
}

# POST a JSON-RPC payload to the MCP endpoint and print the response object.
# @hono/mcp may answer SSE-framed (event:/data: lines) or as plain JSON
# depending on version/negotiation — handle both.
mcp_call() {
  local body
  body="$(curl -fsS -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "x-brain-key: $MCP_ACCESS_KEY" \
    --data "$1")"
  if printf '%s' "$body" | grep -q '^data: '; then
    printf '%s' "$body" | sed -n 's/^data: //p' | tail -n 1
  else
    printf '%s' "$body"
  fi
}

# Build a tools/call payload with jq so marker text is JSON-escaped safely.
tools_call() { # $1 = tool name, $2 = arguments (JSON object), $3 = request id
  jq -cn --arg name "$1" --argjson args "$2" --argjson id "$3" \
    '{jsonrpc:"2.0", id:$id, method:"tools/call", params:{name:$name, arguments:$args}}'
}

# ── health ──────────────────────────────────────────────────────────────────
curl -fsS "$BASE_URL/health" | jq -e '.ok == true' >/dev/null \
  || fail health "GET $BASE_URL/health did not return {ok:true}"
pass health

# ── ready (DB connectivity) ─────────────────────────────────────────────────
curl -fsS -H "x-brain-key: $MCP_ACCESS_KEY" "$BASE_URL/ready" \
  | jq -e '.db == "connected"' >/dev/null \
  || fail ready "GET $BASE_URL/ready did not report db:connected"
pass ready

# ── auth doors ──────────────────────────────────────────────────────────────
PROBE='{"jsonrpc":"2.0","id":0,"method":"tools/list"}'
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data "$PROBE")"
[[ "$status" == "401" ]] \
  || fail auth-no-key "expected HTTP 401 without credentials, got $status"
pass auth-no-key

bad_body_and_status="$(curl -s -w '\n%{http_code}' -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-brain-key: definitely-not-the-key-0000000000000000" \
  --data "$PROBE")"
bad_status="$(printf '%s' "$bad_body_and_status" | tail -n 1)"
bad_body="$(printf '%s' "$bad_body_and_status" | sed '$d')"
[[ "$bad_status" == "200" ]] \
  || fail auth-bad-key "expected HTTP 200 JSON-RPC envelope for a tried-but-wrong key, got $bad_status"
printf '%s' "$bad_body" | jq -e '.error.code != null' >/dev/null \
  || fail auth-bad-key "200 response is not a JSON-RPC error envelope: $bad_body"
pass auth-bad-key

# ── initialize handshake ────────────────────────────────────────────────────
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ob1-smoke-test","version":"0"}}}'
init_resp="$(mcp_call "$INIT")" || fail initialize "initialize POST failed"
server_name="$(printf '%s' "$init_resp" | jq -r '.result.serverInfo.name // empty')"
[[ "$server_name" == "open-brain-homelab" ]] \
  || fail initialize "unexpected serverInfo.name: '$server_name' (resp: $init_resp)"
pass initialize

# ── capture ─────────────────────────────────────────────────────────────────
cap_args="$(jq -cn --arg content "$MARKER_CONTENT" '{content:$content}')"
cap_resp="$(mcp_call "$(tools_call capture_thought "$cap_args" 2)")" \
  || fail capture "capture_thought POST failed"
CAPTURED=true
printf '%s' "$cap_resp" | jq -e '(.result.isError // false) | not' >/dev/null \
  || fail capture "capture_thought returned isError: $cap_resp"
cap_text="$(printf '%s' "$cap_resp" | jq -r '.result.content[0].text')"
thought_id="$(printf '%s' "$cap_text" | sed -nE 's/.*\(id: ([0-9a-f-]{36})\).*/\1/p')"
[[ -n "$thought_id" ]] \
  || fail capture "could not extract thought id from: $cap_text"
pass "capture (id: $thought_id)"

# ── search ──────────────────────────────────────────────────────────────────
search_args="$(jq -cn --arg q "$MARKER_CONTENT" '{query:$q, limit:5}')"
search_resp="$(mcp_call "$(tools_call search_thoughts "$search_args" 3)")" \
  || fail search "search_thoughts POST failed"
printf '%s' "$search_resp" | jq -r '.result.content[0].text' | grep -q "$MARKER" \
  || fail search "marker not found in search results: $search_resp"
pass search

# ── fetch ───────────────────────────────────────────────────────────────────
fetch_args="$(jq -cn --arg id "$thought_id" '{id:$id}')"
fetch_resp="$(mcp_call "$(tools_call fetch "$fetch_args" 4)")" \
  || fail fetch "fetch POST failed"
printf '%s' "$fetch_resp" | jq -r '.result.content[0].text' \
  | jq -e --arg m "$MARKER" '.text | contains($m)' >/dev/null \
  || fail fetch "fetched document does not contain the marker: $fetch_resp"
pass fetch

# ── update_thought round-trip ───────────────────────────────────────────────
upd_args="$(jq -cn --arg id "$thought_id" '{id:$id, metadata_patch:{smoke:"true"}}')"
upd_resp="$(mcp_call "$(tools_call update_thought "$upd_args" 5)")" \
  || fail update "update_thought POST failed"
printf '%s' "$upd_resp" | jq -e '(.result.isError // false) | not' >/dev/null \
  || fail update "update_thought returned isError: $upd_resp"
refetch_resp="$(mcp_call "$(tools_call fetch "$fetch_args" 6)")" \
  || fail update "re-fetch POST failed"
printf '%s' "$refetch_resp" | jq -r '.result.content[0].text' \
  | jq -e '.metadata.smoke == "true"' >/dev/null \
  || fail update "metadata_patch did not land: $refetch_resp"

stale_args="$(jq -cn --arg id "$thought_id" \
  '{id:$id, metadata_patch:{smoke:"again"}, if_unchanged_since:"1970-01-01T00:00:00Z"}')"
stale_resp="$(mcp_call "$(tools_call update_thought "$stale_args" 7)")" \
  || fail update "stale update_thought POST failed"
printf '%s' "$stale_resp" | jq -e '.result.isError == true' >/dev/null \
  || fail update "epoch if_unchanged_since was not rejected: $stale_resp"
printf '%s' "$stale_resp" | jq -r '.result.content[0].text' | grep -q 'STALE_READ' \
  || fail update "rejection is not a STALE_READ error: $stale_resp"
pass update

echo "[smoke] all checks passed — cleanup removes the marker row on exit"
