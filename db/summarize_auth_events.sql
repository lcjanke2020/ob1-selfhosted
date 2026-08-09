-- Daily retention + report — the MCP AUTH EVENTS half.
--
-- Owns exactly one relation: `mcp_auth_events`, the reason-coded 401 audit
-- written by the MCP server (server/auth.ts). Companion to
-- db/summarize_funnel.sql, which owns `funnel_access_log` and
-- `funnel_access_summary`; see that file's header for why the two halves are
-- separate files.
--
-- In the three-qube topology this half runs on the APP qube against the
-- canonical corpus on the DB qube, because that is where mcp writes. The
-- Funnel access half runs on the INGRESS qube against its local log sink.
-- Single-host installs run both files in one session (the default resolution
-- of SUMMARY_SQL_FILE in scripts/funnel_daily_summary.sh).
--
-- There is no aggregate table here on purpose. `mcp_auth_events` is small and
-- low-cardinality (a handful of reason codes), so the 30-day raw window is
-- itself the useful record; adding a year-long rollup would buy a trend line
-- nobody has asked for at the cost of another relation in the monitor
-- allowlist that db/03-grants-assertion.sql has to reason about.
--
-- Manual invocation, single-host compose (from deploy/compose-tailnet,
-- invoked the way you start the stack there — the exec has to resolve the
-- same project as the running stack or it finds no container):
--   docker compose exec -T postgres psql -U openbrain_app -d openbrain \
--     < ../../db/summarize_auth_events.sql
--
-- Runs under the same least-privilege role as the funnel half: the DELETE and
-- the SELECT are both covered by openbrain_app's grants in
-- db/02-observability.sql. No superuser, no schema modification.

\set ON_ERROR_STOP on

-- ---------- 1. Retention: drop rows past the 30-day horizon --------------
-- Matched to `funnel_access_log`'s horizon so the two observability records
-- age out together — a 401 in the audit and the request that produced it in
-- the access log disappear on the same day, which keeps "correlate these two
-- by timestamp" honest right up to the edge of the window.
--
-- Interval-granular (not day-granular like the funnel half): there is no
-- summary table whose day buckets this has to line up with, so the simpler
-- rolling boundary is the right one.
--
-- Single statement, so no explicit transaction block: psql autocommits it,
-- and there is no second statement whose failure could leave this one
-- half-applied.
DELETE FROM mcp_auth_events
WHERE ts < now() - interval '30 days';

-- ---------- 2. Markdown report (stdout) ----------------------------------
-- The wrapper captures this output in its configured summary directory.
-- Format matches db/summarize_funnel.sql so a single-host run — which
-- concatenates both files into one psql session — produces one continuous
-- report rather than two differently-shaped ones.

\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only off
\pset border 0

\echo ''
\echo '## Rolling 24h — auth-failure reasons (mcp side)'
\echo ''
SELECT
  middleware,
  reason,
  COUNT(*) AS count,
  COUNT(DISTINCT client_ip) AS unique_ips
FROM mcp_auth_events
WHERE ts > now() - interval '24 hours'
GROUP BY middleware, reason
ORDER BY count DESC;
