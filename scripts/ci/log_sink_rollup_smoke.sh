#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${LOG_SINK_RUNNER_ACTIVE:-}" != 1 ]]; then
  exec "$SCRIPT_DIR/run_log_sink_smokes.sh" rollup
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/log_sink_common.sh"

log_sink_step "Late in-horizon rows recompute their event day exactly"
# Ordinary late-arrival path: summarize an event day while it is still inside
# the 30-day raw-retention horizon, insert more rows for the already-summarized
# day, then prove the next run replaces that summary from all retained raw
# evidence. Raw rows remain until finalization; repeated runs cannot double
# count.
event_ts="(((now() AT TIME ZONE 'UTC')::date - 2) + time '12:00') AT TIME ZONE 'UTC'"

sink_sql openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
  "INSERT INTO funnel_access_log
     (ts, socket, client_ip, method, path, status, duration_ms, bytes_out, user_agent)
   VALUES
     ($event_ts, 'funnel', '203.0.113.17'::inet,
      'GET', '/late/first', 401, 11, 101, 'late-window-first')" \
  >/dev/null
run_sink_rollup >/dev/null

first=$(sink_super_query \
  "SELECT
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent LIKE 'late-window-%'),
     (SELECT COUNT(*) FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
         AND socket = 'funnel' AND status_class = '4xx'),
     COALESCE((SELECT request_count FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
         AND socket = 'funnel' AND status_class = '4xx'), 0)")
test "$first" = "1|1|1" || {
  echo "first in-horizon rollup drifted (raw|rows|count=$first, want 1|1|1)" >&2
  exit 1
}

# One late row repeats the original IP so request_count and unique_ips diverge.
sink_sql openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
  "INSERT INTO funnel_access_log
     (ts, socket, client_ip, method, path, status, duration_ms, bytes_out, user_agent)
   VALUES
     ($event_ts, 'funnel', '203.0.113.18'::inet,
      'GET', '/late/second', 401, 13, 103, 'late-window-second'),
     ($event_ts, 'funnel', '203.0.113.17'::inet,
      'GET', '/late/third', 401, 15, 105, 'late-window-third')" \
  >/dev/null
run_sink_rollup >/dev/null

second=$(sink_super_query \
  "SELECT
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent LIKE 'late-window-%'),
     (SELECT COUNT(*) FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
         AND socket = 'funnel' AND status_class = '4xx'),
     COALESCE((SELECT request_count FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
         AND socket = 'funnel' AND status_class = '4xx'), 0),
     COALESCE((SELECT unique_ips FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
         AND socket = 'funnel' AND status_class = '4xx'), 0)")
test "$second" = "3|1|3|2" || {
  echo "late-row recompute drifted (raw|rows|count|ips=$second, want 3|1|3|2)" >&2
  exit 1
}

# A third pass sees the same complete raw set and must be exactly idempotent.
run_sink_rollup >/dev/null
third=$(sink_super_query \
  "SELECT COUNT(*), COALESCE(MAX(request_count), 0),
          COALESCE(MAX(unique_ips), 0)
   FROM funnel_access_summary
   WHERE day = (now() AT TIME ZONE 'UTC')::date - 2
     AND socket = 'funnel' AND status_class = '4xx'")
test "$third" = "1|3|2" || {
  echo "in-horizon re-run was not idempotent (rows|count|ips=$third, want 1|3|2)" >&2
  exit 1
}
echo "late in-horizon row recomputed exactly; raw retained; re-run idempotent"

log_sink_step "Late rows are summarized before retention deletes them"
# A row whose event day is beyond the raw-retention horizon must reach the
# summary in the same transaction whose retention pass deletes its evidence.
sink_sql openbrain_ingester "$OPENBRAIN_INGESTER_PASSWORD" \
  "INSERT INTO funnel_access_log
     (ts, socket, client_ip, method, path, status, duration_ms, bytes_out, user_agent)
   VALUES
     (now() - interval '31 days', 'funnel', '203.0.113.7'::inet,
      'GET', '/mcp', 401, 12, 100, 'late-summary-smoke')" \
  >/dev/null
run_sink_rollup >/dev/null

verdict=$(sink_super_query \
  "SELECT
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent = 'late-summary-smoke'),
     (SELECT COUNT(*) FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 31
         AND socket = 'funnel' AND status_class = '4xx'
         AND request_count = 1)")
test "$verdict" = "0|1" || {
  echo "expected raw row deleted + one summary row (raw|summary=0|1), got $verdict" >&2
  exit 1
}

# Idempotency: a second run must neither double-count nor resurrect the day.
run_sink_rollup >/dev/null
verdict2=$(sink_super_query \
  "SELECT COUNT(*), COALESCE(MAX(request_count), 0)
   FROM funnel_access_summary
   WHERE day = (now() AT TIME ZONE 'UTC')::date - 31")
test "$verdict2" = "1|1" || {
  echo "second run changed the late-day summary (rows|count=$verdict2, expected 1|1)" >&2
  exit 1
}
echo "late 31-day-old row summarized before deletion; re-run idempotent"

log_sink_step "Concurrent insert survives the rollup and retention transaction"
# Hold a lock on the summary row after the rollup takes its REPEATABLE READ
# snapshot, commit another raw row, release the lock, and prove that the new
# row survives for the next run instead of being deleted unseen.
sink_super_sql \
  "INSERT INTO funnel_access_log (ts, socket, status, user_agent)
   VALUES (now() - interval '31 days', 'tailnet', 200, 'rr-seed');
   INSERT INTO funnel_access_summary
     (day, socket, status_class, request_count, unique_ips,
      top_paths, top_user_agents, computed_at)
   VALUES ((now() AT TIME ZONE 'UTC')::date - 31, 'tailnet', '2xx',
           0, 0, '[]'::jsonb, '[]'::jsonb, now())" >/dev/null

lock_dir="$(mktemp -d "$RUNNER_TEMP/log-sink-rollup-lock.XXXXXX")"
lock_ctl="$lock_dir/lock_ctl"
mkfifo "$lock_ctl"
locker_pid=
rollup_pid=
lock_fd=
cleanup_concurrency() {
  local rc=$1
  if [[ -n "$lock_fd" ]]; then
    exec {lock_fd}>&-
    lock_fd=
  fi
  for pid in "$rollup_pid" "$locker_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  rm -rf -- "$lock_dir"
  return "$rc"
}
trap 'cleanup_concurrency "$?"' EXIT

sink_psql "$POSTGRES_USER" "$POSTGRES_PASSWORD" \
  < "$lock_ctl" >/dev/null &
locker_pid=$!
exec {lock_fd}> "$lock_ctl"
printf '%s\n' \
  "BEGIN;
   SELECT 1 FROM funnel_access_summary
   WHERE day = (now() AT TIME ZONE 'UTC')::date - 31
     AND socket = 'tailnet' AND status_class = '2xx'
   FOR UPDATE;" >&"$lock_fd"

# Wait until the locker's backend is parked idle in its open transaction.
locker_count=0
for _ in $(seq 1 30); do
  locker_count=$(sink_super_query \
    "SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'idle in transaction'")
  [[ "$locker_count" -ge 1 ]] && break
  sleep 1
done
[[ "$locker_count" -ge 1 ]] || {
  echo "locker never took the summary-row lock" >&2
  exit 1
}

run_sink_rollup >/dev/null &
rollup_pid=$!

# Wait until the rollup is genuinely blocked on that row lock.
blocked_count=0
for _ in $(seq 1 30); do
  blocked_count=$(sink_super_query \
    "SELECT COUNT(*) FROM pg_stat_activity
     WHERE wait_event_type = 'Lock'
       AND query LIKE '%funnel_access_summary%'")
  [[ "$blocked_count" -ge 1 ]] && break
  sleep 1
done
[[ "$blocked_count" -ge 1 ]] || {
  echo "rollup never blocked on the summary-row lock" >&2
  exit 1
}

sink_super_sql \
  "INSERT INTO funnel_access_log (ts, socket, status, user_agent)
   VALUES (now() - interval '31 days', 'tailnet', 200, 'rr-concurrent')" \
  >/dev/null

printf '%s\n' "COMMIT;" >&"$lock_fd"
exec {lock_fd}>&-
lock_fd=
wait "$rollup_pid" || {
  echo "rollup transaction failed" >&2
  exit 1
}
rollup_pid=
wait "$locker_pid" || true
locker_pid=

verdict=$(sink_super_query \
  "SELECT
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent = 'rr-concurrent'),
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent = 'rr-seed'),
     (SELECT request_count FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 31
         AND socket = 'tailnet' AND status_class = '2xx')")
test "$verdict" = "1|0|1" || {
  echo "concurrent row lost to snapshot race (concurrent|seed|count=$verdict, want 1|0|1)" >&2
  exit 1
}
echo "concurrent insert survived; seed summarized and retired (1|0|1)"

# The next run must merge the survivor into the finalized total rather than
# replacing the total with only the surviving raw evidence.
run_sink_rollup >/dev/null
verdict2=$(sink_super_query \
  "SELECT
     (SELECT COUNT(*) FROM funnel_access_log
       WHERE user_agent IN ('rr-seed', 'rr-concurrent')),
     (SELECT request_count FROM funnel_access_summary
       WHERE day = (now() AT TIME ZONE 'UTC')::date - 31
         AND socket = 'tailnet' AND status_class = '2xx')")
test "$verdict2" = "0|2" || {
  echo "survivor was not merged into finalized summary (raw|count=$verdict2, want 0|2)" >&2
  exit 1
}
echo "next run merged the survivor additively into the finalized day (0|2)"

cleanup_concurrency 0
trap - EXIT

log_sink_step "Bounded top-3 sketch semantics remain pinned"
# Finalized tops are /a:10 /b:9 /c:8; an historical /d:7 has already been
# discarded. A late /d x5 makes its unknowable true total 12, but the bounded
# sketch sees only 5 and must retain the existing top three while exact
# request_count still advances from 34 to 39.
sink_super_sql \
  "INSERT INTO funnel_access_summary
     (day, socket, status_class, request_count, unique_ips,
      top_paths, top_user_agents, computed_at)
   VALUES ((now() AT TIME ZONE 'UTC')::date - 40, 'funnel', '2xx', 34, 4,
           '[{\"path\": \"/a\", \"count\": 10}, {\"path\": \"/b\", \"count\": 9}, {\"path\": \"/c\", \"count\": 8}]'::jsonb,
           '[]'::jsonb, now() - interval '9 days');
   INSERT INTO funnel_access_log (ts, socket, status, path, user_agent)
   SELECT now() - interval '40 days', 'funnel', 200, '/d', 'sketch-pin'
   FROM generate_series(1, 5)" >/dev/null
run_sink_rollup >/dev/null

verdict=$(sink_super_query \
  "SELECT request_count,
          (SELECT string_agg(e->>'path', ',' ORDER BY (e->>'count')::bigint DESC)
             FROM jsonb_array_elements(top_paths) AS e),
          (SELECT COUNT(*) FROM funnel_access_log
            WHERE user_agent = 'sketch-pin')
   FROM funnel_access_summary
   WHERE day = (now() AT TIME ZONE 'UTC')::date - 40
     AND socket = 'funnel' AND status_class = '2xx'")
test "$verdict" = "39|/a,/b,/c|0" || {
  echo "top-N sketch drifted (count|tops|raw=$verdict, want 39|/a,/b,/c|0)" >&2
  exit 1
}
echo "sketch pinned: exact count 34+5=39; below-third /d stays out; raw retired"
