-- Schema for the ingress qube's LOCAL FUNNEL LOG SINK.
--
-- A separate Postgres cluster from the canonical corpus, living on the
-- internet-facing qube so that qube needs no network path to the database
-- qube at all. It holds exactly the two Funnel-access relations and nothing
-- else: no `thoughts`, no `sessions`, no `mcp_auth_events`, no pgvector.
-- See deploy/qubes/ingress-qube/README.md § Local log sink.
--
-- WHAT AN ATTACKER GETS BY OWNING THIS CLUSTER: up to 30 days of request
-- metadata (timestamp, path, status, client IP, user-agent) plus up to a year
-- of daily aggregates of the same. That is a subset of what owning the qube
-- already yields — Caddy's access logs are on the same disk — which is the
-- whole argument for putting the sink here rather than reaching across.
--
-- This file is the SOLE schema owner for Funnel request metadata. The corpus
-- schema deliberately has no copy; db/03-grants-assertion.sql rejects one.
-- db/log-sink/02-log-sink-status-class.sql adds the raw table's generated
-- classification on both fresh and upgraded sinks. The completed-catalog
-- assertion pins the resulting relation and column set, while CI runs every
-- Funnel rollup regression against this schema.
--
-- Idempotent (IF NOT EXISTS throughout), so it is safe to re-run by hand
-- against an existing sink. The docker entrypoint only runs
-- /docker-entrypoint-initdb.d/* on a freshly-initialized data dir.

-- ---------- Raw access log ------------------------------------------------
-- One row per HTTP request hitting Caddy. Populated by the log-ingester
-- sidecar (server/log_ingester.ts), which tails Caddy's JSON access log
-- files (funnel-access.log and tailnet-access.log) and inserts here.
--
-- Sensitive-data discipline: we DO NOT store Authorization header values,
-- x-brain-key values, cookies, request body, or full URL query strings.
-- See server/log_ingester.ts for the input-side scrubbing.
--
-- Retention: 30 days, enforced by db/summarize_funnel.sql's daily DELETE.
CREATE TABLE IF NOT EXISTS funnel_access_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL,
  -- Which Caddy branch served this request (post-Pattern Y,
  -- single :9787 listener with header-discriminated branches; the
  -- log-ingester writes the branch tag based on which log file it read):
  --   'funnel'  → matched Tailscale-Funnel-Request (public-internet door)
  --   'tailnet' → header absent (tailnet door)
  socket         TEXT NOT NULL CHECK (socket IN ('funnel', 'tailnet')),
  client_ip      INET,
  method         TEXT,
  -- Path only (no query string — could contain credentials in misconfigured
  -- clients despite our header-only policy).
  path           TEXT,
  status         SMALLINT,
  -- Caddy reports duration in seconds (float); we store as milliseconds
  -- for compactness and human-readable summaries.
  duration_ms   INTEGER,
  bytes_out      BIGINT,
  -- Truncated to 200 chars at ingest time. Bot UAs can be multi-kilobyte
  -- garbage; we want enough to fingerprint without blowing up storage.
  user_agent     TEXT,
  -- Host header (or :authority for HTTP/2). Useful for spotting probes
  -- that hit the IP directly with a fake Host value.
  host_header    TEXT,
  -- 'h1' | 'h2' | 'h3' from Caddy's request.proto.
  proto          TEXT,
  -- TLS server_name (SNI) if reported. Mostly null on the Caddy side since
  -- Tailscale terminates TLS upstream.
  tls_sni        TEXT,
  -- Parsed from the Caddy 'logger_names' or directly from the listener
  -- socket; redundant with `socket` but kept for ingester-side debugging.
  caddy_logger   TEXT,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- status_class is appended by 02-log-sink-status-class.sql. Keeping the
  -- migration as its sole definition gives fresh and upgraded sinks the same
  -- column order and one idempotent upgrade path.
);

CREATE INDEX IF NOT EXISTS idx_funnel_access_log_ts        ON funnel_access_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_socket_ts ON funnel_access_log (socket, ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_status    ON funnel_access_log (status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_client_ip ON funnel_access_log (client_ip, ts DESC);

-- ---------- Daily summary --------------------------------------------------
-- Populated by db/summarize_funnel.sql once per day. Keeps a year of
-- aggregated stats so we can spot trends (rising scan volume, new
-- countries appearing in client_ip space, etc.) long after the raw
-- per-request rows have been deleted.
--
-- Retention: 365 days, enforced by db/summarize_funnel.sql.
CREATE TABLE IF NOT EXISTS funnel_access_summary (
  -- Composite primary key — one row per (day, socket, status_class) so
  -- re-running the summary script for the same day is idempotent.
  day             DATE NOT NULL,
  socket          TEXT NOT NULL,
  -- Status class: '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other'.
  -- Coarser than the exact status because the long-term value here is "is the
  -- 4xx rate climbing", not the exact code distribution.
  status_class    TEXT NOT NULL,
  request_count   BIGINT NOT NULL,
  unique_ips      BIGINT NOT NULL,
  -- p50 / p95 of duration_ms over the day, computed via
  -- percentile_disc() at summary time.
  duration_ms_p50 INTEGER,
  duration_ms_p95 INTEGER,
  -- Top 3 paths for the day in this bucket, as a JSON array of
  -- {path, count} objects. Bounded so the row stays small even if a
  -- scanner probes many distinct paths.
  top_paths       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Top 3 user agents (truncated upstream to 200 chars each).
  top_user_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, socket, status_class)
);

CREATE INDEX IF NOT EXISTS idx_funnel_access_summary_day ON funnel_access_summary (day DESC);

-- ---------- Grants ---------------------------------------------------------
-- PUBLIC gets nothing. Every role below is named explicitly, and
-- 02-log-sink-assertion.sql fails the init if any of them acquires more.
-- Database TEMPORARY is granted directly to the rollup role: its
-- transaction-local projection needs temporary-table access, and the direct
-- grant keeps hardened installs working after they revoke the stock PUBLIC
-- default.
--
-- The `public` SCHEMA itself: PostgreSQL 15+ already revokes CREATE from
-- PUBLIC, so the three roles can use the schema but not add objects to it.
-- Stated explicitly rather than inherited, because this cluster's whole
-- claim is "these two tables and nothing else".
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO openbrain_ingester, openbrain_logs_rollup;

DO $$
BEGIN
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO openbrain_logs_rollup', current_database());
END;
$$ LANGUAGE plpgsql;

-- openbrain_ingester: INSERT-only on the raw table. This role is sink-only;
-- the corpus assertion rejects the role name and has no matching relation.
-- The ingester parses attacker-controlled Caddy JSON, so it gets no SELECT
-- (it never reads back), no UPDATE, and no DELETE — a compromised ingester
-- can add noise to the log but cannot read or erase what is already there.
GRANT INSERT ON funnel_access_log TO openbrain_ingester;
GRANT USAGE  ON SEQUENCE funnel_access_log_id_seq TO openbrain_ingester;

-- openbrain_logs_rollup: the DML db/summarize_funnel.sql needs — SELECT and
-- DELETE on raw, SELECT/INSERT/UPDATE/DELETE on the aggregate. No sequence
-- grant: the rollup never INSERTs into funnel_access_log, only reads and
-- retires it. Its TEMPORARY database capability above is required by the
-- transaction-local aggregate projection and is pinned by the assertion.
GRANT SELECT, DELETE                         ON funnel_access_log     TO openbrain_logs_rollup;
GRANT SELECT, INSERT, UPDATE, DELETE         ON funnel_access_summary TO openbrain_logs_rollup;

-- openbrain_monitor: SELECT-only on the one table scripts/funnel_monitor.sh
-- probes. Optional role — created by 00-log-sink-roles.sh only when
-- OPENBRAIN_MONITOR_PASSWORD is set — so the grant is wrapped around the
-- sink-local role rather than making monitoring a prerequisite for startup.
--
-- It deliberately gets NO access to funnel_access_summary. The monitor's two
-- probes both scan the raw table; reading the aggregate would widen an
-- edge-resident credential for nothing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO openbrain_monitor';
    EXECUTE 'GRANT SELECT ON funnel_access_log TO openbrain_monitor';
  ELSE
    RAISE NOTICE 'openbrain_monitor role missing; skipping monitor grant (OPENBRAIN_MONITOR_PASSWORD unset)';
  END IF;
END;
$$ LANGUAGE plpgsql;
