-- Observability schema for the Caddy Funnel door + MCP auth events.
--
-- All tables are idempotent (IF NOT EXISTS) so this file is safe to re-run
-- by hand against an existing database. The docker entrypoint only runs
-- /docker-entrypoint-initdb.d/* on a freshly-initialized data dir, so the
-- expected path for existing deployments is:
--
--   docker compose exec -T postgres \
--     psql -U postgres -d openbrain < db/02-observability.sql
--
-- See deploy/compose-tailnet/README.md §"Observability".

-- ---------- Raw access log ------------------------------------------------
-- One row per HTTP request hitting Caddy. Populated by the log-ingester
-- sidecar (server/log_ingester.ts), which tails Caddy's JSON access log
-- files (funnel-access.log and tailnet-access.log) and inserts here.
--
-- Sensitive-data discipline: we DO NOT store Authorization header values,
-- x-brain-key values, cookies, request body, or full URL query strings.
-- See server/log_ingester.ts for the input-side scrubbing.
--
-- Retention: 30 days, enforced by the summary script's daily DELETE.
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
);

CREATE INDEX IF NOT EXISTS idx_funnel_access_log_ts        ON funnel_access_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_socket_ts ON funnel_access_log (socket, ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_status    ON funnel_access_log (status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_access_log_client_ip ON funnel_access_log (client_ip, ts DESC);

-- ---------- MCP auth 401 events ------------------------------------------
-- The MCP server (server/auth.ts) writes one row here for every 401 it
-- returns from `requireAuth` or `requireBrainKey`. This is the only way
-- to distinguish *why* a request failed auth — Caddy only sees the
-- 401 status, not the reason string in the JSON body.
--
-- Sensitive-data discipline: NO header values, NO token contents, NO
-- request body. The `reason` field is one of a small finite set the
-- server emits internally; the `path` is the matched route.
--
-- Retention: 30 days, same DELETE as funnel_access_log.
CREATE TABLE IF NOT EXISTS mcp_auth_events (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One of: 'invalid_brain_key', 'token_validation_failed',
  -- 'invalid_credentials' (both attempted), 'missing_credentials'.
  -- Maps to the human-readable strings in server/auth.ts. We store the
  -- code form here so a future copy-edit to the WWW-Authenticate text
  -- doesn't break historical analysis.
  reason         TEXT NOT NULL,
  -- Which middleware emitted: 'require_auth' or 'require_brain_key'.
  middleware     TEXT NOT NULL,
  -- Caddy strips the client IP into x-forwarded-for; we capture the
  -- first hop after Caddy. Nullable in case the proxy header is missing
  -- (direct dev access, single-port deploy without Caddy).
  client_ip      INET,
  -- The matched Hono route, not the raw URL path. Currently always one
  -- of '/mcp', '/', '/ready' but recorded so a future route addition
  -- shows up correctly.
  path           TEXT,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_ts        ON mcp_auth_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_reason_ts ON mcp_auth_events (reason, ts DESC);

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
  -- Status class: '1xx' | '2xx' | '3xx' | '4xx' | '5xx'. Coarser than
  -- the exact status because the long-term value here is "is the 4xx
  -- rate climbing", not the exact code distribution.
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
-- openbrain_app: full DML so the mcp server can INSERT into mcp_auth_events,
-- and so the daily summary script can SELECT/INSERT/UPDATE/DELETE
-- against funnel_access_log and funnel_access_summary for aggregation + the
-- 30-day retention DELETE. The ingester does NOT use this role any more —
-- see openbrain_ingester below.
GRANT SELECT, INSERT, UPDATE, DELETE ON funnel_access_log     TO openbrain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_auth_events       TO openbrain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON funnel_access_summary TO openbrain_app;
GRANT USAGE ON SEQUENCE funnel_access_log_id_seq TO openbrain_app;
GRANT USAGE ON SEQUENCE mcp_auth_events_id_seq   TO openbrain_app;

-- openbrain_readonly: SELECT for ad-hoc psql / DBeaver poking around at
-- "what's hitting the funnel today". The sequence SELECTs let
-- `pg_dump -U openbrain_readonly` (the off-box backup) read these BIGSERIAL
-- sequences' state — the explicit per-object mirror of the table grants here.
-- (01-schema.sql also grants future public sequences via ALTER DEFAULT
-- PRIVILEGES, but that only fires for objects created by the role that ran it;
-- these explicit grants don't depend on the creating role.)
GRANT SELECT ON funnel_access_log     TO openbrain_readonly;
GRANT SELECT ON mcp_auth_events       TO openbrain_readonly;
GRANT SELECT ON funnel_access_summary TO openbrain_readonly;
GRANT SELECT ON SEQUENCE funnel_access_log_id_seq TO openbrain_readonly;
GRANT SELECT ON SEQUENCE mcp_auth_events_id_seq   TO openbrain_readonly;

-- openbrain_ingester: INSERT-only on funnel_access_log so the
-- log-ingester sidecar (which parses attacker-controlled Caddy JSON) has
-- the smallest possible blast radius on compromise. No SELECT (the
-- ingester never reads back), no UPDATE, no DELETE, no access to
-- `thoughts` or mcp_auth_events. The role is created by 00-roles.sh
-- only when OPENBRAIN_INGESTER_PASSWORD is set (Pattern B); the GRANT
-- here is wrapped so Pattern A (which doesn't create the role) doesn't
-- error at init time.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_ingester') THEN
    EXECUTE 'GRANT INSERT ON funnel_access_log TO openbrain_ingester';
    EXECUTE 'GRANT USAGE  ON SEQUENCE funnel_access_log_id_seq TO openbrain_ingester';
  ELSE
    RAISE NOTICE 'openbrain_ingester role missing; skipping ingester grants (Pattern A or OPENBRAIN_INGESTER_PASSWORD unset)';
  END IF;
END;
$$ LANGUAGE plpgsql;
