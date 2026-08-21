#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" auth
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

phase="${1:-all}"
case "$phase" in
  all|tokens|audit) ;;
  *)
    echo "usage: ${0##*/} [all|tokens|audit]" >&2
    exit 2
    ;;
esac

if [[ "$phase" == "all" || "$phase" == "tokens" ]]; then
smoke_step "Smoke test — native token lifecycle is hash-only and least-privilege"
# Reapply the migration to pin the existing-database/idempotency path,
# re-check catalog grants, then exercise register/list/revoke through
# the real dedicated and application roles inside a rollback.
apply_sql db/08-access-tokens.sql >/dev/null
apply_sql db/03-grants-assertion.sql >/dev/null
apply_sql db/access-tokens-smoke.sql >/dev/null
run_deno_db_smoke server/access_tokens_db_smoke.ts
echo "native token registration, driver hashing, redacted listing, one-way revocation, and grants passed"
fi

if [[ "$phase" == "all" || "$phase" == "audit" ]]; then
smoke_step "Smoke test — auth audit emitter records both outcomes end-to-end"
# Reapply the observability migration first to pin its documented
# in-place convergence on a live database, then drive the REAL
# auth_audit.ts emitter as openbrain_app through every row shape
# the middleware emits (all unit tests run it disabled), and pin
# the row-shape constraints via the malformed inserts.
apply_sql db/02-observability.sql >/dev/null
run_deno_db_smoke server/auth_audit_db_smoke.ts
smoke_step "Smoke test — pre-1.20 audit shape: refusal, migration, acceptance"
# The emitter smoke above proves fresh-install + idempotent replay;
# this one pins the load-bearing LEGACY convergence a real pre-1.20
# deployment goes through. It clones the initialized database
# (TEMPLATE, so every other schema contract is present), downgrades
# mcp_auth_events to the denied-only shape with legacy rows, and
# runs the full operator sequence: the REAL boot probe refuses with
# migration guidance -> db/02 converges the clone in place -> the
# probe accepts, the legacy rows survive backfilled as denied with
# reasons preserved, and the app role lands an allowed row.
UPGRADE_SMOKE_PHASE=refuse \
  run_deno_db_smoke server/auth_audit_upgrade_db_smoke.ts
super_psql_db openbrain_upgrade -v ON_ERROR_STOP=1 \
  < db/02-observability.sql >/dev/null
UPGRADE_SMOKE_PHASE=accept \
  run_deno_db_smoke server/auth_audit_upgrade_db_smoke.ts
smoke_step "Smoke test — middleware-to-audit seam lands the exact rows"
# Round-3 mutation testing showed the auth.ts -> auth_audit.ts
# wiring could regress silently (emitter calls removed or reason
# codes swapped) while every unit test stays green, because the
# middleware suites run with auditing disabled. This drives the
# REAL requireAuth over real RS256 tokens against the live database
# and asserts the exact rows per credential scenario, including
# subject_not_allowed precedence over the dual-credential collapse.
run_deno_db_smoke server/auth_middleware_audit_db_smoke.ts
fi
