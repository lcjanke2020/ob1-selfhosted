#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" schema
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

phase="${1:-all}"
case "$phase" in
  all|baseline|data) ;;
  *)
    echo "usage: ${0##*/} [all|baseline|data]" >&2
    exit 2
    ;;
esac

if [[ "$phase" == "all" || "$phase" == "baseline" ]]; then
smoke_step "Sanity-check init applied (sessions + spaces + audit present)"
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM information_schema.schemata WHERE schema_name='sessions'" | grep -q 1
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM memory_scope.workspace WHERE id='sensitive' AND personal_only" | grep -q 1
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT to_regclass('public.metadata_degradation_outbox') IS NOT NULL" | grep -q t
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT 1 FROM metadata_degradation_notification_state WHERE singleton" | grep -q 1
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT to_regclass('native_auth.access_token') IS NOT NULL" | grep -q t
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT COUNT(*) = 0 FROM pg_roles
   WHERE rolname IN (
     'openbrain_ingester',
     'openbrain_monitor',
     'openbrain_logs_rollup',
     'openbrain_logs_backup'
   )" | grep -q t
super_psql -v ON_ERROR_STOP=1 -tAc \
  "SELECT to_regclass('public.funnel_access_log') IS NULL
          AND to_regclass('public.funnel_access_summary') IS NULL" | grep -q t
fi

if [[ "$phase" == "all" || "$phase" == "data" ]]; then
smoke_step "Smoke test — metadata audit is append-only and coherent"
# Recreate the first preview's committed schema/data, apply current
# migration 07 over it, and prove that columns, constraints, queued
# history, and grants converge before cleaning the fixture.
apply_sql db/metadata-degradation-legacy-fixture.sql >/dev/null
apply_sql db/07-metadata-degradation.sql >/dev/null
apply_sql db/03-grants-assertion.sql >/dev/null
apply_sql db/metadata-degradation-upgrade-smoke.sql >/dev/null

# Reapply once more to pin idempotency, then use the real app role.
# The SQL fixture rolls back outbox consumption and ledger updates.
apply_sql db/07-metadata-degradation.sql >/dev/null
apply_sql db/metadata-degradation-smoke.sql >/dev/null
run_deno_db_smoke server/metadata_notifications_db_smoke.ts
echo "metadata preview upgrade, audit/outbox, immutable-history, shape, and ledger checks passed"
smoke_step "Smoke test — spaces isolate every audience and pooled reuse"
# Reapply the upgrade migration first: init scripts do not rerun on
# live volumes, so its documented idempotent upgrade path matters.
apply_sql db/06-spaces.sql >/dev/null
apply_sql db/spaces-smoke.sql >/dev/null
echo "spaces RLS, sensitive ownership, dedupe, artifacts, and GUC reuse passed"
smoke_step "Smoke test — thought mutations stay inside the caller's audience"
# Reapply the migration first (idempotent upgrade path on a live
# volume), re-run the completed-catalog assertion so the new
# SECURITY DEFINER helper and append-only history are pinned, then
# exercise the move helper + app-role update path as the real roles.
apply_sql db/10-thought-mutations.sql >/dev/null
apply_sql db/03-grants-assertion.sql >/dev/null
apply_sql db/thought-mutations-smoke.sql >/dev/null
echo "move helper source/target checks, principal-stamped ownership, dedupe conflicts, head-gated append-only history, and the RLS-confined update path passed"
# Then the production query path itself (queries.ts
# updateThoughtContent/moveThought) as the forced-RLS app role: the
# exact bound statements, jsonb stamp merge, recomputed fingerprint,
# generated tsvector, degradation-event enqueue, and outcomes.
run_deno_db_smoke server/thought_mutations_db_smoke.ts
smoke_step "Smoke test — openbrain_readonly can run a full pg_dump"
# The exact operation the off-box backup performs. Exits non-zero
# with "permission denied for sequence/relation" if the read-only
# role is missing SELECT on any dumped object. Run inside the
# container so pg_dump's version matches the server's.
docker exec -e PGPASSWORD="$OPENBRAIN_READONLY_PASSWORD" "$DB_INIT_CONTAINER" \
  pg_dump -h 127.0.0.1 -U openbrain_readonly -d "$POSTGRES_DB" \
  --no-owner --no-privileges > /dev/null
echo "pg_dump as openbrain_readonly succeeded"
fi
