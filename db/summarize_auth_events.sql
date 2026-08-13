-- Daily retention + report — the MCP AUTH EVENTS half.
--
-- Owns exactly one relation: `mcp_auth_events`, the auth-decision audit the
-- MCP server (server/auth_audit.ts) enqueues best-effort — reason-coded 401s
-- (outcome='denied') AND per-authenticated-request admission rows
-- (outcome='allowed', with the verified subject / token label and door).
-- Best-effort means gaps are possible under backpressure (either outcome;
-- counted + warned by the server when they happen). Companion to
-- db/summarize_funnel.sql, which owns `funnel_access_log` and
-- `funnel_access_summary`; see that file's header for why the two halves are
-- separate files.
--
-- In the three-qube topology this half runs on the APP qube against the
-- canonical corpus on the DB qube, because that is where mcp writes. The
-- Funnel access half runs on the INGRESS qube against its local log sink.
-- scripts/funnel_daily_summary.sh selects this file only when
-- SUMMARY_TARGET=corpus and pins the matching service, role, and transport.
--
-- There is no aggregate table here on purpose. The denied side is
-- low-cardinality reason codes on a short window; the allowed side and the
-- identity-carrying `subject_not_allowed` denials are the long-horizon
-- record, and the RAW rows are that record — an identity-level "who accessed
-- / who knocked" question is exactly what an aggregate would destroy.
-- Generating a long-horizon row requires a tenant-minted Bearer, which
-- bounds who can write them (not how many rows one credential can produce —
-- the horizon below is the operator's size lever). A rollup would buy
-- nothing but another corpus relation and another grant surface for
-- db/03-grants-assertion.sql to reason about.
--
-- Manual invocation, single-host compose (from deploy/compose-tailnet,
-- invoked the way you start the stack there — the exec has to resolve the
-- same project as the running stack or it finds no container):
--   docker compose --env-file .env exec -T postgres \
--     psql -U openbrain_app -d openbrain \
--     < ../../db/summarize_auth_events.sql
--
-- Runs as the corpus-local openbrain_app role: the DELETE and SELECT are both
-- covered by its grants in db/02-observability.sql. The Funnel half instead
-- runs as openbrain_logs_rollup inside the sink. Neither needs a superuser or
-- schema modification.

\set ON_ERROR_STOP on

-- ---------- 1. Retention: identity-keyed horizons -------------------------
-- Short horizon (30 days): denied rows EXCEPT `subject_not_allowed` —
-- scanner noise and credential fumbles. This uses the same nominal horizon as
-- the sink's `funnel_access_log`; the two independent jobs can lag separately,
-- but neither class is intended as long-term anonymous-request history.
--
-- Long horizon (365 days): allowed rows AND `subject_not_allowed` denials —
-- every row that names a verified identity. The admission record is the one
-- an incident review needs months later ("who accessed this server while X
-- was true"), and a `subject_not_allowed` row is its exact complement
-- ("which real, tenant-minted identity knocked and was refused" — e.g. did
-- a compromised account knock before it was ever allowlisted). Neither can
-- be produced by an unauthenticated scanner: both require a Bearer that
-- passed signature/issuer/audience/exp against the tenant — bounding who
-- can produce them, though not how many rows one credential can produce
-- (this horizon is the size lever). Matches the funnel summary's one-year
-- horizon.
--
-- Interval-granular (not day-granular like the funnel half): there is no
-- summary table whose day buckets this has to line up with, so the simpler
-- rolling boundary is the right one.
--
-- Two independent single statements, no explicit transaction block: psql
-- autocommits each, and a failure between them leaves both horizons
-- individually consistent (the next run converges whichever half lagged).
-- The two WHERE clauses partition the table: every row is denied or
-- allowed, and denied rows split on the one identity-carrying reason.
DELETE FROM mcp_auth_events
WHERE outcome = 'denied'
  AND reason IS DISTINCT FROM 'subject_not_allowed'
  AND ts < now() - interval '30 days';

DELETE FROM mcp_auth_events
WHERE (outcome = 'allowed' OR reason = 'subject_not_allowed')
  AND ts < now() - interval '365 days';

-- ---------- 2. Markdown report (stdout) ----------------------------------
-- The wrapper captures this output in its configured summary directory. Its
-- shape remains consistent with the sink report, but Arc B runs the two
-- target-pinned jobs independently because the relations share no cluster.

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
WHERE outcome = 'denied' AND ts > now() - interval '24 hours'
GROUP BY middleware, reason
ORDER BY count DESC;

-- The success-side mirror: who was admitted, through which door, at what
-- volume. `identity` collapses the two attribution columns (an OAuth row
-- carries subject, a native-token row carries token_label, the static key
-- carries neither) so one line per admitted identity per door reads off
-- directly. This is the daily answer to "who accessed this server" — the
-- question the denied-only audit could never answer.
\echo ''
\echo '## Rolling 24h — admitted identities (mcp side)'
\echo ''
SELECT
  door,
  COALESCE(subject, token_label, '(static shared key)') AS identity,
  COUNT(*) AS requests,
  COUNT(DISTINCT client_ip) AS unique_ips,
  MIN(ts) AS first_seen,
  MAX(ts) AS last_seen
FROM mcp_auth_events
WHERE outcome = 'allowed' AND ts > now() - interval '24 hours'
GROUP BY door, COALESCE(subject, token_label, '(static shared key)')
ORDER BY requests DESC;
