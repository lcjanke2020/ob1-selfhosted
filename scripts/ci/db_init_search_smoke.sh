#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" search
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

smoke_step "Smoke test — session HNSW survives audience and residual filters"
export DB_SMOKE_REBUILDS=1
# Calls the checked-out production searchSessions function as the
# forced-RLS app role. The smoke separately forces and plan-checks
# an exact reference, then verifies commit/rollback GUC restoration
# and repeats after rebuilding the approximate index.
run_deno_db_smoke server/session_search_db_smoke.ts
unset DB_SMOKE_REBUILDS

smoke_step "Smoke test — session lookup and list share effective freshness"
# Calls the checked-out production branch lookup and default list as
# the forced-RLS app role over null, explicit, triggered, and tied
# timestamps.
run_deno_db_smoke server/session_ordering_db_smoke.ts

smoke_step "Smoke test — thought filters keep GIN and scope HNSW iteration"
# The retired RPC must not survive a fresh/replayed schema. Search is
# owned by server/queries.ts for MCP, REST, and future hybrid legs.
retired=$(super_psql -tAc \
  "SELECT to_regprocedure('public.match_thoughts(vector,double precision,integer,jsonb)') IS NULL")
test "$retired" = "t" || { echo "::error::retired match_thoughts RPC still exists"; exit 1; }

# The fixture asserts exact filter semantics, makes one positive term
# selective, verifies transaction-local HNSW iteration, and EXPLAINs
# both live vector+filter query shapes.
plan=$(super_psql < db/search-filter-plan-smoke.sql)
grep -q 'idx_thoughts_metadata' <<< "$plan" || {
  echo "::error::positive metadata containment did not select idx_thoughts_metadata"
  echo "$plan"
  exit 1
}
grep -q 'idx_thoughts_embedding_hnsw' <<< "$plan" || {
  echo "::error::exclude-only vector search did not select idx_thoughts_embedding_hnsw"
  echo "$plan"
  exit 1
}
echo "positive filter selected metadata GIN; filtered search selected HNSW with scoped iteration"

smoke_step "Smoke test — hybrid search finds vector and literal candidates"
# Reapply the upgrade migration to prove its existing-database path
# remains idempotent, then exercise the query shape as the real app
# role rather than relying on superuser-only access.
apply_sql db/05-hybrid-search.sql >/dev/null
plan=$(super_psql < db/hybrid-search-smoke.sql)
grep -q 'idx_thoughts_content_tsv' <<< "$plan" || {
  echo "::error::full-text predicate did not select idx_thoughts_content_tsv"
  echo "$plan"
  exit 1
}
grep -q 'idx_thoughts_content_trgm' <<< "$plan" || {
  echo "::error::literal fallback did not select idx_thoughts_content_trgm"
  echo "$plan"
  exit 1
}
grep -q 'idx_thoughts_embedding_hnsw' <<< "$plan" || {
  echo "::error::hybrid vector candidate leg did not select idx_thoughts_embedding_hnsw"
  echo "$plan"
  exit 1
}
echo "hybrid semantics passed; vector, FTS, and literal legs selected their indexes"
