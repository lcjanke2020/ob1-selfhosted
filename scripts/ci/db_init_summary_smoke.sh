#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${CI_REPO_ROOT:-}" || -z "${DB_INIT_CONTAINER:-}" ]]; then
  exec "$SCRIPT_DIR/run_db_init_smokes.sh" summary
fi
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/db_init_common.sh"

smoke_step "Smoke test — app-qube auth-event wrapper is target-pinned and atomic"
systemd-analyze verify \
  deploy/qubes/app-qube/auth-events-summary.service \
  deploy/qubes/app-qube/auth-events-summary.timer
systemd-analyze calendar '*-*-* 00:30:00 UTC' >/dev/null

smoke_root="$RUNNER_TEMP/auth-events-summary-wrapper"
report_dir="$smoke_root/reports"
env_file="$smoke_root/auth-events-summary.env"
psql_shim="$smoke_root/psql"
probe_bin="$smoke_root/bin"
install -d -m 0700 "$smoke_root" "$report_dir" "$probe_bin"

# The job environment already exports OPENBRAIN_APP_PASSWORD. Assert
# that the wrapper strips that attribute before its first external
# command, not merely before the eventual database client.
cat > "$probe_bin/dirname" <<'SH'
#!/usr/bin/env bash
if [[ -v OPENBRAIN_APP_PASSWORD ]]; then
  echo "OPENBRAIN_APP_PASSWORD leaked into the first external child" >&2
  exit 39
fi
exec /usr/bin/dirname "$@"
SH
chmod 0755 "$probe_bin/dirname"

# Exercise the production host-psql argument path while reusing this
# job's initialized Postgres fixture. The shim crosses into "$DB_INIT_CONTAINER" and
# forwards stdin, args, and PGPASSWORD unchanged.
cat > "$psql_shim" <<'SH'
#!/usr/bin/env bash
test "${PGPASSWORD:-}" = ci_app_pw || {
  echo "expected command-scoped PGPASSWORD" >&2
  exit 40
}
if [[ -v OPENBRAIN_APP_PASSWORD ]]; then
  echo "OPENBRAIN_APP_PASSWORD leaked into the external client" >&2
  exit 41
fi
exec docker exec -i -e PGPASSWORD "$DB_INIT_CONTAINER" psql "$@"
SH
chmod 0755 "$psql_shim"

{
  printf 'SUMMARY_BACKEND=postgres\n'
  printf 'SUMMARY_TARGET=corpus\n'
  printf 'DB_HOST=127.0.0.1\n'
  printf 'DB_PORT=5432\n'
  printf 'POSTGRES_DB=%q\n' "$POSTGRES_DB"
  # Exercise the second guard too: a sourced file may explicitly
  # restore the credential's export attribute after the first-child check.
  printf 'export OPENBRAIN_APP_PASSWORD=%q\n' "$OPENBRAIN_APP_PASSWORD"
  printf 'SUMMARY_DIR=%q\n' "$report_dir"
  printf 'PSQL_BIN=%q\n' "$psql_shim"
} > "$env_file"
chmod 0600 "$env_file"

PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh

mapfile -t reports < <(find "$report_dir" -maxdepth 1 -type f -name 'auth-events-summary-*.md' -print)
if [ "${#reports[@]}" -ne 1 ]; then
  echo "::error::expected exactly one published summary, got ${#reports[@]}"
  find "$report_dir" -maxdepth 1 -ls
  exit 1
fi
report=${reports[0]}
grep -Fq '## Rolling 24h — auth-failure reasons (mcp side)' "$report"
test "$(grep -Fc '````' "$report")" -eq 2
test "$(stat -c '%a' "$report")" = 600
first_hash=$(sha256sum "$report" | awk '{print $1}')

# Refuse to source a credential file after its private mode drifts.
# Rejection happens before report staging or the external client.
chmod 0644 "$env_file"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh \
  >"$smoke_root/insecure.out" 2>"$smoke_root/insecure.err"
insecure_rc=$?
set -e
test "$insecure_rc" -eq 2
grep -Fq 'env file must have no group/other permissions' "$smoke_root/insecure.err"
chmod 0600 "$env_file"
test "$(sha256sum "$report" | awk '{print $1}')" = "$first_hash"
test -z "$(find "$report_dir" -maxdepth 1 -type f -name '.auth-events-summary-*' -print -quit)"

# Do not follow even an owner-created symlink to a credential file;
# the configured path itself must be the inspected regular file.
ln -s "$env_file" "$smoke_root/symlink.env"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$smoke_root/symlink.env" \
  scripts/funnel_daily_summary.sh \
  >"$smoke_root/symlink.out" 2>"$smoke_root/symlink.err"
symlink_rc=$?
set -e
test "$symlink_rc" -eq 2
grep -Fq 'env file must be a regular, non-symlink file' "$smoke_root/symlink.err"
test "$(sha256sum "$report" | awk '{print $1}')" = "$first_hash"
test -z "$(find "$report_dir" -maxdepth 1 -type f -name '.auth-events-summary-*' -print -quit)"

# A failed same-day rerun must leave the prior complete report in
# place, remove its unpublished staging file, and normalize the
# external client's status to the documented runtime-failure code.
cat > "$psql_shim" <<'SH'
#!/usr/bin/env bash
exit 42
SH
chmod 0755 "$psql_shim"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh
failed_rc=$?
set -e
test "$failed_rc" -eq 1
test "$(sha256sum "$report" | awk '{print $1}')" = "$first_hash"
test -z "$(find "$report_dir" -maxdepth 1 -type f -name '.auth-events-summary-*' -print -quit)"

# The retired free-form SQL path is rejected before the client runs;
# the target enum is the only supported way to select a half.
{
  printf 'SUMMARY_BACKEND=postgres\n'
  printf 'SUMMARY_TARGET=corpus\n'
  printf 'DB_HOST=127.0.0.1\n'
  printf 'POSTGRES_DB=%q\n' "$POSTGRES_DB"
  printf 'OPENBRAIN_APP_PASSWORD=%q\n' "$OPENBRAIN_APP_PASSWORD"
  printf 'SUMMARY_SQL_FILE=%q\n' "$GITHUB_WORKSPACE/db/summarize_funnel.sql"
  printf 'SUMMARY_DIR=%q\n' "$smoke_root/retired-knob-reports"
  printf 'PSQL_BIN=%q\n' "$psql_shim"
} > "$env_file"
chmod 0600 "$env_file"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh \
  >"$smoke_root/retired.out" 2>"$smoke_root/retired.err"
retired_rc=$?
set -e
test "$retired_rc" -eq 2
grep -Fq 'SUMMARY_SQL_FILE is retired' "$smoke_root/retired.err"

# A sink target may use only an absolute unix-socket host. This catches
# the pre-Arc-B TCP-to-corpus env shape before psql is invoked.
{
  printf 'SUMMARY_BACKEND=postgres\n'
  printf 'SUMMARY_TARGET=sink\n'
  printf 'DB_HOST=127.0.0.1\n'
  printf 'LOG_SINK_DB=openbrain_logs\n'
  printf 'OPENBRAIN_LOGS_ROLLUP_PASSWORD=ci_sink_rollup_pw\n'
  printf 'SUMMARY_DIR=%q\n' "$smoke_root/wrong-transport-reports"
  printf 'PSQL_BIN=%q\n' "$psql_shim"
} > "$env_file"
chmod 0600 "$env_file"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh \
  >"$smoke_root/transport.out" 2>"$smoke_root/transport.err"
transport_rc=$?
set -e
test "$transport_rc" -eq 2
grep -Fq 'target=sink requires an absolute unix-socket DB_HOST' \
  "$smoke_root/transport.err"

# Name the operator-facing credential, not the internal tuple field,
# when a fresh target config leaves its password blank.
{
  printf 'SUMMARY_BACKEND=postgres\n'
  printf 'SUMMARY_TARGET=sink\n'
  printf 'DB_HOST=/var/run/postgresql\n'
  printf 'LOG_SINK_DB=openbrain_logs\n'
  printf 'SUMMARY_DIR=%q\n' "$smoke_root/missing-credential-reports"
  printf 'PSQL_BIN=/bin/false\n'
} > "$env_file"
chmod 0600 "$env_file"
set +e
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$env_file" \
  scripts/funnel_daily_summary.sh \
  >"$smoke_root/missing.out" 2>"$smoke_root/missing.err"
missing_rc=$?
set -e
test "$missing_rc" -eq 2
grep -Fq 'OPENBRAIN_LOGS_ROLLUP_PASSWORD is required for target=sink' \
  "$smoke_root/missing.err"
echo "auth-event wrapper confined its credential, published atomically, rejected stale free-form SQL, refused sink-over-TCP, and named missing credentials"

smoke_step "Smoke test — Compose project env cannot repin the summary target"
set -euo pipefail
smoke_root="$RUNNER_TEMP/compose-summary-target"
compose_dir="$smoke_root/compose"
report_dir="$smoke_root/reports"
config_env="$smoke_root/funnel-summary.env"
probe_bin="$smoke_root/bin"
install -d -m 0700 "$smoke_root" "$compose_dir" "$report_dir" "$probe_bin"

# This is the regression: a project's ordinary Compose .env may carry
# a stale target value, but it cannot alter the invocation's reviewed
# sink tuple after that tuple has been selected.
cat > "$compose_dir/.env" <<'ENV'
SUMMARY_TARGET=corpus
POSTGRES_DB=poison_corpus
LOG_SINK_DB=ci_sink_from_compose
ENV

{
  printf 'SUMMARY_BACKEND=compose\n'
  printf 'SUMMARY_TARGET=sink\n'
  printf 'COMPOSE_DIR=%q\n' "$compose_dir"
  printf 'SUMMARY_DIR=%q\n' "$report_dir"
} > "$config_env"
chmod 0600 "$config_env"

cat > "$probe_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$COMPOSE_PROBE_LOG"
printf '\n' >> "$COMPOSE_PROBE_LOG"
if [[ " $* " == *" ps --status=running log-sink "* ]]; then
  echo log-sink
  exit 0
fi
if [[ " $* " == *" exec -T log-sink "* ]]; then
  test "${@: -1}" = ci_sink_from_compose
  cat > "$COMPOSE_PROBE_INPUT"
  grep -Fq '# Funnel observability report' "$COMPOSE_PROBE_INPUT"
  ! grep -Fq 'auth-failure reasons' "$COMPOSE_PROBE_INPUT"
  echo '# Funnel observability report'
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 45
SH
chmod 0755 "$probe_bin/docker"

export COMPOSE_PROBE_LOG="$smoke_root/docker.log"
export COMPOSE_PROBE_INPUT="$smoke_root/stdin.sql"
PATH="$probe_bin:$PATH" FUNNEL_SUMMARY_ENV_FILE="$config_env" \
  scripts/funnel_daily_summary.sh

grep -Fq 'exec -T log-sink' "$COMPOSE_PROBE_LOG"
if grep -Fq 'exec -T postgres' "$COMPOSE_PROBE_LOG"; then
  echo "Compose summary unexpectedly targeted the corpus service" >&2
  exit 1
fi
mapfile -t reports < <(
  find "$report_dir" -maxdepth 1 -type f \
    -name 'funnel-summary-*.md' -print
)
test "${#reports[@]}" -eq 1
test -z "$(find "$report_dir" -maxdepth 1 -type f \
  -name 'auth-events-summary-*.md' -print -quit)"
echo "Compose .env could customize the selected sink database name but not flip the target tuple"
