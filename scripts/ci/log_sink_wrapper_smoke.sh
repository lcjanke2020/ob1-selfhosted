#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${LOG_SINK_RUNNER_ACTIVE:-}" != 1 ]]; then
  exec "$SCRIPT_DIR/run_log_sink_smokes.sh" wrapper
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/log_sink_common.sh"

log_sink_step "Target-pinned wrapper selects only the sink contract"
smoke_root="$(mktemp -d "$RUNNER_TEMP/log-sink-summary-wrapper.XXXXXX")"
report_dir="$smoke_root/reports"
env_file="$smoke_root/funnel-summary.env"
psql_shim="$smoke_root/psql"

cleanup_wrapper() {
  local rc=$1
  rm -rf -- "$smoke_root"
  return "$rc"
}
trap 'cleanup_wrapper "$?"' EXIT
install -d -m 0700 "$report_dir"

# In the CI-equivalent all run, the role contract inserts these two rows and
# earlier rollups have already finalized the old one. When this family runs by
# itself, seed the same pair so the command remains independently runnable.
ci_state=$(sink_super_query \
  "SELECT COUNT(*),
          COUNT(*) FILTER (WHERE ts > now() - interval '30 days'),
          COUNT(*) FILTER (WHERE ts < now() - interval '30 days')
   FROM funnel_access_log WHERE user_agent = 'ci'")
case "$ci_state" in
  0\|0\|0)
    sink_sql openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
      "INSERT INTO funnel_access_log
         (ts,socket,client_ip,method,path,status,duration_ms,bytes_out,user_agent)
       VALUES
         (now() - interval '2 hours','funnel','192.0.2.9','GET','/mcp',401,12,0,'ci'),
         (now() - interval '40 days','funnel','192.0.2.9','GET','/old',404,3,0,'ci')" \
      >/dev/null
    ;;
  1\|1\|0|2\|1\|1)
    ;;
  *)
    echo "unexpected wrapper fixture state (total|recent|old=$ci_state)" >&2
    exit 1
    ;;
esac

cat > "$psql_shim" <<'SH'
#!/usr/bin/env bash
test "${PGPASSWORD:-}" = ci_sink_rollup_pw || {
  echo "expected sink rollup password" >&2
  exit 40
}
if [[ -v OPENBRAIN_LOGS_ROLLUP_PASSWORD ]]; then
  echo "sink credential leaked under its source name" >&2
  exit 41
fi
: "${LOG_SINK_CONTAINER:?LOG_SINK_CONTAINER is required}"
exec docker exec -i -e PGPASSWORD "$LOG_SINK_CONTAINER" psql "$@"
SH
chmod 0755 "$psql_shim"

{
  printf 'SUMMARY_BACKEND=postgres\n'
  printf 'SUMMARY_TARGET=sink\n'
  printf 'DB_HOST=/var/run/postgresql\n'
  printf 'DB_PORT=5432\n'
  printf 'LOG_SINK_DB=%q\n' "$POSTGRES_DB"
  printf 'export OPENBRAIN_LOGS_ROLLUP_PASSWORD=%q\n' \
    "$OPENBRAIN_LOGS_ROLLUP_PASSWORD"
  printf 'SUMMARY_DIR=%q\n' "$report_dir"
  printf 'PSQL_BIN=%q\n' "$psql_shim"
} > "$env_file"
chmod 0600 "$env_file"

FUNNEL_SUMMARY_ENV_FILE="$env_file" scripts/funnel_daily_summary.sh
mapfile -t reports < <(
  find "$report_dir" -maxdepth 1 -type f \
    -name 'funnel-summary-*.md' -print
)
test "${#reports[@]}" -eq 1
grep -F '# Funnel observability report' "${reports[0]}"
! grep -qF 'auth-failure reasons' "${reports[0]}" || {
  echo "sink target emitted the corpus auth-events section" >&2
  exit 1
}

# Retention finalized the old row into the summary and deleted it; the recent
# row remains raw.
test "$(sink_query openbrain_logs_rollup "$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
  "select count(*) from funnel_access_log where user_agent='ci';")" = 1
test "$(sink_query openbrain_logs_rollup "$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
  "select count(*) from funnel_access_log where user_agent='ci' and ts < now() - interval '30 days';")" = 0
test "$(sink_query openbrain_logs_rollup "$OPENBRAIN_LOGS_ROLLUP_PASSWORD" \
  'select count(*) from funnel_access_summary;')" -ge 1
echo "sink target selected only the sink role, socket, SQL, database, and report"

cleanup_wrapper 0
trap - EXIT
