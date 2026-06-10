-- Daily summary + retention enforcement.
--
-- Run by the host-side cron / systemd timer (see deploy/compose-tailnet/README.md §Observability).
-- Wraps everything in a single transaction so partial failure leaves the
-- previous day's summary state intact.
--
-- Manual invocation (after the host wires Pattern B):
--   docker compose exec -T postgres psql -U openbrain_app -d openbrain \
--     < db/summarize_funnel.sql > /tmp/funnel.md
--
-- The SELECT at the end emits a markdown report on stdout so the cron
-- wrapper can `tee` it to the summary directory .

\set ON_ERROR_STOP on

-- We operate on "yesterday in the host's local time" so a midnight-aligned
-- cron job (e.g. 00:30) captures the previous calendar day, not whatever
-- partial today happens to span. UTC is intentional — keeps interpretation
-- stable across DST and host-tz changes. The expression
-- `(now() AT TIME ZONE 'UTC')::date - 1` is inlined at each use site
-- below (psql `\set` substitution doesn't compose cleanly inside WHERE
-- clauses without single-quoting gymnastics, and a stored function would
-- need extra grants).

BEGIN;

-- ---------- 1. Roll up yesterday's raw rows into the summary table -------
-- ON CONFLICT means a re-run for the same day overwrites cleanly. The
-- aggregation is over `funnel_access_log.ts` (the event time from Caddy),
-- not `inserted_at` (the ingest time), so even if the ingester is
-- backlogged the right rows land in the right day.
-- The shape: aggregate by (day, socket, status_class) over yesterday's
-- rows, then for each group compute count / unique_ips / percentiles and
-- subselect top-3 paths + UAs.
INSERT INTO funnel_access_summary (
  day, socket, status_class,
  request_count, unique_ips,
  duration_ms_p50, duration_ms_p95,
  top_paths, top_user_agents,
  computed_at
)
SELECT
  d.day,
  d.socket,
  d.status_class,
  d.request_count,
  d.unique_ips,
  d.p50,
  d.p95,
  COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('path', path, 'count', cnt) ORDER BY cnt DESC)
      FROM (
        SELECT path, COUNT(*) AS cnt
        FROM funnel_access_log
        WHERE (ts AT TIME ZONE 'UTC')::date = d.day
          AND socket = d.socket
          AND CASE
                WHEN status BETWEEN 100 AND 199 THEN '1xx'
                WHEN status BETWEEN 200 AND 299 THEN '2xx'
                WHEN status BETWEEN 300 AND 399 THEN '3xx'
                WHEN status BETWEEN 400 AND 499 THEN '4xx'
                WHEN status BETWEEN 500 AND 599 THEN '5xx'
                ELSE 'other'
              END = d.status_class
        GROUP BY path
        ORDER BY cnt DESC
        LIMIT 3
      ) p
    ),
    '[]'::jsonb
  ) AS top_paths,
  COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('ua', user_agent, 'count', cnt) ORDER BY cnt DESC)
      FROM (
        SELECT user_agent, COUNT(*) AS cnt
        FROM funnel_access_log
        WHERE (ts AT TIME ZONE 'UTC')::date = d.day
          AND socket = d.socket
          AND CASE
                WHEN status BETWEEN 100 AND 199 THEN '1xx'
                WHEN status BETWEEN 200 AND 299 THEN '2xx'
                WHEN status BETWEEN 300 AND 399 THEN '3xx'
                WHEN status BETWEEN 400 AND 499 THEN '4xx'
                WHEN status BETWEEN 500 AND 599 THEN '5xx'
                ELSE 'other'
              END = d.status_class
          AND user_agent IS NOT NULL
        GROUP BY user_agent
        ORDER BY cnt DESC
        LIMIT 3
      ) u
    ),
    '[]'::jsonb
  ) AS top_user_agents,
  now()
FROM (
  SELECT
    (ts AT TIME ZONE 'UTC')::date AS day,
    socket,
    CASE
      WHEN status BETWEEN 100 AND 199 THEN '1xx'
      WHEN status BETWEEN 200 AND 299 THEN '2xx'
      WHEN status BETWEEN 300 AND 399 THEN '3xx'
      WHEN status BETWEEN 400 AND 499 THEN '4xx'
      WHEN status BETWEEN 500 AND 599 THEN '5xx'
      ELSE 'other'
    END AS status_class,
    COUNT(*)                                                        AS request_count,
    COUNT(DISTINCT client_ip)                                       AS unique_ips,
    percentile_disc(0.5)  WITHIN GROUP (ORDER BY duration_ms)::int  AS p50,
    percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int  AS p95
  FROM funnel_access_log
  WHERE (ts AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date - 1
  GROUP BY day, socket, status_class
) d
ON CONFLICT (day, socket, status_class) DO UPDATE SET
  request_count   = EXCLUDED.request_count,
  unique_ips      = EXCLUDED.unique_ips,
  duration_ms_p50 = EXCLUDED.duration_ms_p50,
  duration_ms_p95 = EXCLUDED.duration_ms_p95,
  top_paths       = EXCLUDED.top_paths,
  top_user_agents = EXCLUDED.top_user_agents,
  computed_at     = EXCLUDED.computed_at;

-- ---------- 2. Retention: drop raw rows older than 30 days ---------------
-- Raw retention is short because (a) the daily summary captures the
-- shape we care about for long-term trends, and (b) per-IP raw retention
-- is mildly sensitive (it's a public-internet IP log).
DELETE FROM funnel_access_log
WHERE ts < now() - interval '30 days';

DELETE FROM mcp_auth_events
WHERE ts < now() - interval '30 days';

-- ---------- 3. Retention: drop summary rows older than 365 days ----------
DELETE FROM funnel_access_summary
WHERE day < (now() AT TIME ZONE 'UTC')::date - 365;

COMMIT;

-- ---------- 4. Markdown report (stdout) ----------------------------------
-- Wrapper script captures this output and writes it to the syncthing-replicated
-- directory. Format is intentionally simple — psql's default tabular output
-- with a few `\echo` headers — so it renders well as a fenced text block
-- in any markdown viewer.

\pset format unaligned
\pset fieldsep ' | '
\pset tuples_only off
\pset border 0

\echo '# Funnel observability report'
\echo ''
\echo '## Yesterday (UTC) — request counts by status class'
\echo ''
SELECT
  socket,
  status_class,
  request_count,
  unique_ips,
  duration_ms_p50 AS p50_ms,
  duration_ms_p95 AS p95_ms
FROM funnel_access_summary
WHERE day = (now() AT TIME ZONE 'UTC')::date - 1
ORDER BY socket, status_class;

\echo ''
\echo '## Rolling 24h — top client IPs (raw table)'
\echo ''
SELECT
  socket,
  host(client_ip) AS client_ip,
  COUNT(*)        AS hits,
  MIN(ts)         AS first_seen,
  MAX(ts)         AS last_seen
FROM funnel_access_log
WHERE ts > now() - interval '24 hours'
GROUP BY socket, client_ip
ORDER BY hits DESC
LIMIT 20;

\echo ''
\echo '## Rolling 24h — top 4xx paths by socket+status (scan-detection)'
\echo ''
-- 4xx-only intentionally: legitimate Anthropic egress against /mcp shows
-- as 200, so the interesting signal is "paths a scanner kept hitting but
-- never got a success on". 401 (no auth), 404 (probe paths), 403 (when
-- the Anthropic IP allowlist lands) are the relevant ones.
SELECT
  socket,
  status,
  path,
  COUNT(*) AS hits
FROM funnel_access_log
WHERE ts > now() - interval '24 hours'
  AND status BETWEEN 400 AND 499
GROUP BY socket, status, path
ORDER BY hits DESC
LIMIT 30;

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

\echo ''
\echo '## 7-day trend — request count by socket+status_class'
\echo ''
SELECT
  day,
  socket,
  status_class,
  request_count,
  unique_ips
FROM funnel_access_summary
WHERE day > (now() AT TIME ZONE 'UTC')::date - 8
ORDER BY day DESC, socket, status_class;
