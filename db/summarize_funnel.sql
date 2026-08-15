-- Daily summary + retention enforcement — the FUNNEL ACCESS half.
--
-- Owns exactly two relations: `funnel_access_log` (raw, 30-day) and
-- `funnel_access_summary` (aggregate, 365-day). It touches nothing else, and
-- in particular it does NOT touch `mcp_auth_events` — that table's retention
-- and report live in the companion file, db/summarize_auth_events.sql.
--
-- WHY THE SPLIT. These two halves stopped sharing a database. In the
-- three-qube topology the Funnel access log is written by a local sink on the
-- INGRESS qube (deploy/qubes/ingress-qube/README.md § Local log sink), while
-- `mcp_auth_events` is written by mcp into the canonical corpus on the DB
-- qube. One file spanning both would be unrunnable on either qube. Splitting
-- by owning-table also means each half fails independently: a broken edge
-- rollup can no longer stop the corpus side's auth-event retention.
--
-- Every Pattern B install now uses the separate sink, including single-host
-- Compose. scripts/funnel_daily_summary.sh selects this file only when
-- SUMMARY_TARGET=sink and pins the matching service, role, and transport.
--
-- Run by the host-side cron / systemd timer (see deploy/compose-tailnet/README.md §Observability).
-- Wraps everything in a single transaction so partial failure leaves the
-- previous day's summary state intact.
--
-- Manual invocation (after the host wires Pattern B), from
-- deploy/compose-tailnet, invoked the way you start the stack there (its
-- README §"Start the stack" gives both forms) — the exec has to resolve the
-- same project as the running stack or it finds no container:
--   docker compose --env-file .env exec -T log-sink sh -eu -c \
--     'PGPASSWORD="$OPENBRAIN_LOGS_ROLLUP_PASSWORD" exec psql -X -w \
--        -h /var/run/postgresql -U openbrain_logs_rollup -d "$POSTGRES_DB"' \
--     < ../../db/summarize_funnel.sql > /tmp/funnel.md
-- The split Qubes deployment runs this file on the INGRESS qube against the
-- local log sink over its unix socket, via scripts/funnel_daily_summary.sh's
-- postgres backend and the shipped ingress-qube user timer.
--
-- The SELECT at the end emits a markdown report on stdout so the cron
-- wrapper can `tee` it to the summary directory.

\set ON_ERROR_STOP on

-- Day boundaries are UTC — keeps interpretation stable across DST and
-- host-tz changes. The `(now() AT TIME ZONE 'UTC')::date` expressions are
-- inlined at each use site below (psql `\set` substitution doesn't compose
-- cleanly inside WHERE clauses without single-quoting gymnastics, and a
-- stored function would need extra grants).
--
-- LIFECYCLE MODEL — supersedes both the original "yesterday only" rollup
-- (which permanently missed any row arriving after its day's run: later
-- runs only looked at newer days and retention deleted the unsummarized
-- evidence, audit finding PR55-OPS-001) and that fix's first revision (a
-- trailing recompute window, whose boundary still dropped a row that
-- arrived during its day's final recompute — caught in review):
--
--   1. While a day is inside the raw-retention horizon (day >= today-30),
--      it is recomputed IN FULL from raw on every run — an idempotent
--      replace via ON CONFLICT. Nothing is deleted.
--   2. The first run where the day has aged past the horizon
--      (day < today-30) FINALIZES it: one last full recompute, and the
--      same transaction deletes the day's raw rows. A finalized day is
--      recognizable ever after because its summary's computed_at sits
--      >= 31 days past `day`; in-horizon recomputes always stamp
--      computed_at - day <= 30. (No schema flag needed — but the
--      heuristic assumes summaries were written BY THIS LIFECYCLE. This
--      deployment's first production run starts from an empty summary
--      table, so that holds. Summaries imported from elsewhere, or left
--      by this file's earlier yesterday-only revision, read as
--      non-finalized: exact for days whose raw is complete, but a day
--      the old revision's instant-based retention partially purged gets
--      recomputed from its remainder once — an undercount. When
--      upgrading such a database, first mark strictly-past-horizon
--      legacy summaries finalized:
--        UPDATE funnel_access_summary
--        SET computed_at = GREATEST(computed_at,
--              ((day + 31)::timestamp AT TIME ZONE 'UTC'))
--        WHERE day < (now() AT TIME ZONE 'UTC')::date - 30;
--      That protects those days from late-row replacement (their late
--      rows take the additive merge path) — but it deliberately does NOT
--      cover the boundary day (day = today-30 at cutover), whose
--      inaccuracy is inherent to the upgrade: its surviving raw rows are
--      already counted in the legacy summary, so marking it finalized
--      would double-count them on merge, while leaving it non-finalized
--      recomputes it from the partial remainder once. Accept the
--      one-time boundary-day imprecision either way.)
--   3. Raw rows appearing for an already-FINALIZED day — ingester
--      backlog, restored data, or a row whose committing transaction was
--      invisible to the finalizing snapshot — are MERGED additively into
--      the existing summary and deleted by the same transaction:
--      request_count adds exactly; top_paths / top_user_agents merge by
--      summing per-key counts and re-taking the top 3; unique_ips takes
--      GREATEST(existing, remainder) — a documented lower bound, since
--      the finalized rows' IPs are gone; the duration percentiles keep
--      their as-of-finalization values. The merge treats remainder rows
--      as new events: re-ingesting rows that were already counted
--      overcounts, consistent with the ingester's documented
--      at-least-once posture (over-counting beats under-counting).
--
--      top_paths / top_user_agents are bounded top-3 SKETCHES, not exact
--      rankings. Finalization discards per-key counts below third place,
--      and a merge can only combine the two truncated lists (keys below
--      either side's own third place contribute nothing), so a dropped
--      key's history can never re-enter: a late surge can leave the true
--      leader under-ranked or absent from the sketch even though every
--      one of its requests is in the exact request_count. Keys that ARE
--      shown carry exact lower-bound counts. Exact ranking would need
--      unbounded per-key state per day — a cardinality liability for a
--      scanner-facing path column — so the bounded sketch is the
--      deliberate trade at this scale; the db-init workflow pins this
--      accepted behavior so any future widening is an explicit decision.
--
-- The invariant that falls out: a raw row is only ever deleted by the
-- transaction that counted it (finalize or merge). Combined with the
-- single REPEATABLE READ snapshot below, that yields eventual accounting:
-- whatever one run's snapshot cannot see, a later run merges — exactly
-- once — before deleting.

-- REPEATABLE READ so every statement shares one snapshot. Under the
-- default READ COMMITTED, each statement snapshots independently: a raw
-- row committed mid-transaction is invisible to the aggregation yet
-- visible to — and deleted by — the retention pass, silently dropping it
-- (reproduced deterministically in review). With one transaction
-- snapshot, a concurrently committed row is invisible to every statement
-- here: it survives untouched and a later run merges it (step 3 above).
-- Serialization failures are a non-issue — the ingester only inserts,
-- and this job is the sole writer of summary rows and sole deleter of
-- raw rows; if one ever fires, ON_ERROR_STOP aborts cleanly and the next
-- scheduled run covers the same work (idempotent by design).
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- ---------- 1. Full recompute of every non-finalized day with raw rows ---
-- ON CONFLICT means a re-run for the same day overwrites cleanly — correct
-- here because a non-finalized day's raw is complete (deletion only ever
-- happens in the finalize/merge transactions, which stamp the finalized
-- computed_at distance). The aggregation is over `funnel_access_log.ts`
-- (the event time from Caddy), not `inserted_at` (the ingest time), so
-- backlogged rows land in the right day. Days at or past the horizon that
-- were never finalized (first-ever run over a backlog, a cron gap, or a
-- never-summarized restored day) take this branch too — their raw is
-- still complete, and the retention statement below finalizes them this
-- same run.
-- The shape: aggregate by (day, socket, status_class) over the recompute
-- set, then for each group compute count / unique_ips / percentiles and
-- subselect top-3 paths + UAs.
WITH recompute_days AS (
  SELECT DISTINCT (ts AT TIME ZONE 'UTC')::date AS day
  FROM funnel_access_log
  WHERE (ts AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date
    AND NOT EXISTS (
      SELECT 1 FROM funnel_access_summary s
      WHERE s.day = (funnel_access_log.ts AT TIME ZONE 'UTC')::date
        AND (s.computed_at AT TIME ZONE 'UTC')::date - s.day >= 31
    )
)
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
  WHERE (ts AT TIME ZONE 'UTC')::date IN (SELECT day FROM recompute_days)
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

-- ---------- 2. Additive merge of late rows into FINALIZED days -----------
-- Same aggregation shape as statement 1, but the day set is the complement
-- (finalized days that have raw rows again) and the conflict action MERGES
-- instead of replacing: the existing summary's raw evidence is gone, so a
-- replace would shrink history to just the remainder. Every remainder row
-- is uncounted by construction — counted rows of a finalized day were
-- deleted by the transaction that counted them — so adding is exact for
-- request_count. Groups new to the day (a status class the finalized
-- summary never saw) insert as-is, including their remainder-only
-- percentiles. On conflict, the duration percentiles are deliberately NOT
-- in the SET list: they keep their as-of-finalization values.
WITH merge_days AS (
  SELECT DISTINCT (ts AT TIME ZONE 'UTC')::date AS day
  FROM funnel_access_log
  WHERE (ts AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date - 30
    AND EXISTS (
      SELECT 1 FROM funnel_access_summary s
      WHERE s.day = (funnel_access_log.ts AT TIME ZONE 'UTC')::date
        AND (s.computed_at AT TIME ZONE 'UTC')::date - s.day >= 31
        -- Finalized by a PREVIOUS transaction only. Statement 1's writes
        -- are visible here (a transaction sees its own writes), so a day
        -- finalized moments ago in this very run would otherwise qualify
        -- and its rows would be counted twice — once by the finalizing
        -- recompute, again by this merge. `now()` is transaction-stable:
        -- rows written this run carry computed_at = now() exactly, prior
        -- runs' rows compare strictly less.
        AND s.computed_at < now()
    )
)
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
  WHERE (ts AT TIME ZONE 'UTC')::date IN (SELECT day FROM merge_days)
  GROUP BY day, socket, status_class
) d
ON CONFLICT (day, socket, status_class) DO UPDATE SET
  request_count = funnel_access_summary.request_count + EXCLUDED.request_count,
  unique_ips    = GREATEST(funnel_access_summary.unique_ips, EXCLUDED.unique_ips),
  top_paths = COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('path', mp.path, 'count', mp.cnt) ORDER BY mp.cnt DESC)
      FROM (
        SELECT u.path, SUM(u.cnt) AS cnt
        FROM (
          SELECT e->>'path' AS path, (e->>'count')::bigint AS cnt
          FROM jsonb_array_elements(funnel_access_summary.top_paths) AS e
          UNION ALL
          SELECT e->>'path', (e->>'count')::bigint
          FROM jsonb_array_elements(EXCLUDED.top_paths) AS e
        ) u
        GROUP BY u.path
        ORDER BY cnt DESC
        LIMIT 3
      ) mp
    ),
    '[]'::jsonb
  ),
  top_user_agents = COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('ua', mu.ua, 'count', mu.cnt) ORDER BY mu.cnt DESC)
      FROM (
        SELECT u.ua, SUM(u.cnt) AS cnt
        FROM (
          SELECT e->>'ua' AS ua, (e->>'count')::bigint AS cnt
          FROM jsonb_array_elements(funnel_access_summary.top_user_agents) AS e
          UNION ALL
          SELECT e->>'ua', (e->>'count')::bigint
          FROM jsonb_array_elements(EXCLUDED.top_user_agents) AS e
        ) u
        GROUP BY u.ua
        ORDER BY cnt DESC
        LIMIT 3
      ) mu
    ),
    '[]'::jsonb
  ),
  computed_at = EXCLUDED.computed_at;

-- ---------- 3. Retention: drop raw rows past the 30-day horizon ----------
-- Raw retention is short because (a) the daily summary captures the
-- shape we care about for long-term trends, and (b) per-IP raw retention
-- is mildly sensitive (it's a public-internet IP log).
--
-- Day-granular at UTC midnight, matching the day buckets above. Every raw
-- row this statement can see was counted THIS RUN — its day either had no
-- finalized summary (statement 1 recomputed it in full: finalization) or
-- had one (statement 2 merged the remainder) — and all three statements
-- share one REPEATABLE READ snapshot, so a concurrently committed row is
-- invisible here too and survives for a later run's merge. The sargable
-- form below is equivalent to
-- `(ts AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date - 30`.
DELETE FROM funnel_access_log
WHERE ts < (((now() AT TIME ZONE 'UTC')::date - 30)::timestamp AT TIME ZONE 'UTC');

-- `mcp_auth_events` retention lives in summarize_auth_events.sql, not here:
-- the two tables no longer share a database in the split topology. See this
-- file's header.

-- ---------- 4. Retention: drop summary rows older than 365 days ----------
DELETE FROM funnel_access_summary
WHERE day < (now() AT TIME ZONE 'UTC')::date - 365;

COMMIT;

-- ---------- 5. Markdown report (stdout) ----------------------------------
-- The wrapper captures this output in its configured summary directory (local
-- by default, optionally replicated to a trusted destination). Format is
-- intentionally simple — psql's default tabular output with a few `\echo`
-- headers — so it renders well as a fenced text block in any markdown viewer.

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
