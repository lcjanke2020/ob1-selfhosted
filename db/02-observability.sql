-- Observability schema for the Caddy Funnel door + MCP auth events.
--
-- All tables are idempotent (IF NOT EXISTS) so this file is safe to re-run
-- by hand against an existing database. The docker entrypoint only runs
-- /docker-entrypoint-initdb.d/* on a freshly-initialized data dir, so it
-- never reaches an existing deployment on its own. Apply it from your compose
-- project directory, invoked the way you start the stack there
-- (deploy/compose-tailnet/README.md §"Start the stack" gives both forms) — the
-- exec has to resolve the same project as the running stack or it finds no
-- container:
--
--   docker compose exec -T postgres \
--     psql -U postgres -d openbrain < ../../db/02-observability.sql
--
-- A deployment whose database is not in that compose project has nothing to
-- exec into. The split Qubes topology's procedure — a guarded network psql
-- connection — is in deploy/qubes/app-qube/README.md §"Upgrading an existing
-- deployment"; any other external-Postgres layout applies this same file over
-- its own connection.
--
-- See deploy/compose-tailnet/README.md §"Observability (Pattern B)".

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

-- ---------- MCP auth events (denied AND allowed) --------------------------
-- The MCP server (server/auth_audit.ts, called from `requireAuth` in
-- server/auth.ts) enqueues one row here per auth decision, through a shared
-- best-effort queue (fire-and-forget, single in-flight cap covering both
-- outcomes: under backpressure events of EITHER outcome can drop — counted
-- and warned, so a gap is self-announcing, but not reconstructable):
--
--   outcome = 'denied'  → the 401s the middleware returns. The only way
--                         to distinguish *why* a request failed auth —
--                         Caddy only sees the 401 status, not the reason.
--   outcome = 'allowed' → authenticated requests: which verified identity
--                         (subject / token label), through which door, to
--                         which path. This is the success-side audit that
--                         makes "who accessed this server in the last N
--                         days" answerable from local data (up to the
--                         best-effort queue semantics above) — without it,
--                         an admitted intruder is invisible in the
--                         deployment's own records and the answer depends
--                         on the identity provider's logs.
--
-- Sensitive-data discipline: NO header values, NO token contents, NO
-- request body. The `reason` field is one of a small finite set the
-- server emits internally; the `path` is the matched route; `subject` and
-- `token_label` are server-VERIFIED identities (a JWT `sub` that passed
-- signature/issuer/audience checks, or a verified native-token label) —
-- never as-presented request text.
--
-- Retention (db/summarize_auth_events.sql) keys on whether the row names a
-- verified identity: denied rows 30 days (matched to funnel_access_log so a
-- 401 and the request that produced it age out together) — EXCEPT
-- 'subject_not_allowed' denials, which join the allowed rows on a 365-day
-- horizon. Both long-horizon classes require a tenant-minted Bearer: that
-- bounds WHO can generate them (identity- and time-bounded — not row-count-
-- bounded; a single credential can generate arbitrarily many, which is an
-- accepted storage trade-off with the horizon as the operator lever), and
-- both are what an incident review needs months later: who was admitted,
-- and which real identity knocked and was refused.
CREATE TABLE IF NOT EXISTS mcp_auth_events (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'denied' | 'allowed'. Defaulted (not just backfilled) to 'denied' so a
  -- concurrent old-binary writer during a rolling upgrade still produces
  -- valid rows.
  outcome        TEXT NOT NULL DEFAULT 'denied',
  -- Denied rows only (NULL on allowed rows — enforced below). One of:
  -- 'invalid_brain_key', 'token_validation_failed', 'subject_not_allowed'
  -- (verified Bearer whose sub is not on the OAUTH_ALLOWED_SUBJECTS
  -- allowlist), 'invalid_credentials' (both doors attempted),
  -- 'missing_credentials'. Maps to the codes in server/auth_audit.ts. We
  -- store the code form so a future copy-edit to operator-facing text
  -- doesn't break historical analysis.
  reason         TEXT,
  -- Which middleware emitted. Only 'require_auth' is emitted today (the
  -- historical 'require_brain_key' middleware was retired when the static
  -- key became one of requireAuth's doors); the column stays so a future
  -- second middleware has a home. Mirrors AuthMiddleware in
  -- server/auth_audit.ts.
  middleware     TEXT NOT NULL,
  -- Allowed rows: which credential class admitted the request —
  -- 'funnel' (OAuth user Bearer) | 'service' (OAuth client-credentials
  -- Bearer) | 'tailnet' (x-brain-key / native token). NULL on denied rows
  -- (a rejected request has no verified credential class).
  door           TEXT,
  -- Verified identity. Allowed OAuth rows: the JWT `sub`. Denied rows:
  -- populated ONLY for 'subject_not_allowed' (the sub verified but was
  -- refused by the allowlist). NULL otherwise — in particular the static
  -- shared key has no per-holder identity.
  subject        TEXT,
  -- Verified native-token label on allowed tailnet rows (attribution for
  -- the rotatable-token door); NULL for the static key and OAuth doors.
  token_label    TEXT,
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

-- Upgrade path for deployments whose mcp_auth_events predates the success-
-- side audit (denied-only shape: reason NOT NULL, no outcome/door/subject/
-- token_label). Idempotent — CREATE TABLE IF NOT EXISTS above no-ops on an
-- existing table, so these converge it; on a fresh install they no-op
-- instead. The DEFAULT on `outcome` backfills every pre-existing row as
-- 'denied', which is exactly what they all were.
ALTER TABLE mcp_auth_events ADD COLUMN IF NOT EXISTS outcome     TEXT NOT NULL DEFAULT 'denied';
ALTER TABLE mcp_auth_events ADD COLUMN IF NOT EXISTS door        TEXT;
ALTER TABLE mcp_auth_events ADD COLUMN IF NOT EXISTS subject     TEXT;
ALTER TABLE mcp_auth_events ADD COLUMN IF NOT EXISTS token_label TEXT;
ALTER TABLE mcp_auth_events ALTER COLUMN reason DROP NOT NULL;

-- Row-shape invariants, added conditionally (no ADD CONSTRAINT IF NOT
-- EXISTS in Postgres). Validation runs against existing rows on upgrade:
-- pre-upgrade rows all carry a reason and default to outcome='denied', so
-- they satisfy both constraints by construction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_auth_events_outcome_check'
      AND conrelid = 'mcp_auth_events'::regclass
  ) THEN
    ALTER TABLE mcp_auth_events
      ADD CONSTRAINT mcp_auth_events_outcome_check
      CHECK (outcome IN ('denied', 'allowed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_auth_events_door_check'
      AND conrelid = 'mcp_auth_events'::regclass
  ) THEN
    ALTER TABLE mcp_auth_events
      ADD CONSTRAINT mcp_auth_events_door_check
      CHECK (door IS NULL OR door IN ('funnel', 'tailnet', 'service'));
  END IF;
  -- The load-bearing shape rule: a denied row must say why; an allowed row
  -- must say through which door, and carries no failure reason. Deliberately
  -- silent on subject/token_label so a future attribution refinement isn't a
  -- constraint migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_auth_events_outcome_shape_check'
      AND conrelid = 'mcp_auth_events'::regclass
  ) THEN
    ALTER TABLE mcp_auth_events
      ADD CONSTRAINT mcp_auth_events_outcome_shape_check
      CHECK (
        (outcome = 'denied' AND reason IS NOT NULL AND door IS NULL)
        OR
        (outcome = 'allowed' AND reason IS NULL AND door IS NOT NULL)
      );
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_ts        ON mcp_auth_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_reason_ts ON mcp_auth_events (reason, ts DESC);
-- Serves both the retention DELETEs' per-outcome horizons and the
-- "admissions in the last N days" report scan.
CREATE INDEX IF NOT EXISTS idx_mcp_auth_events_outcome_ts ON mcp_auth_events (outcome, ts DESC);

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

-- openbrain_monitor: SELECT-only on the one table the host-side funnel
-- monitor (scripts/funnel_monitor.sh, ingress qube) probes for its
-- volume and public-door 401 counts. Deliberately NOT openbrain_readonly
-- (SELECT on everything, thoughts included): this credential lives on the
-- internet-adjacent edge, so it reads request metadata only — never
-- thought content. No sequence grants — the monitor only scans/aggregates
-- table rows and, unlike openbrain_readonly, never runs pg_dump. Role created by
-- 00-roles.sh only when OPENBRAIN_MONITOR_PASSWORD is set; the GRANT is
-- wrapped so deployments without a monitor don't error at init time.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openbrain_monitor') THEN
    EXECUTE 'GRANT SELECT ON funnel_access_log TO openbrain_monitor';
    -- Converge existing v3 deployments as well as fresh installs. The v4
    -- monitor deliberately stopped querying the cross-door auth-event table;
    -- its edge-resident credential must lose that obsolete privilege.
    EXECUTE 'REVOKE SELECT ON mcp_auth_events FROM openbrain_monitor';
  ELSE
    RAISE NOTICE 'openbrain_monitor role missing; skipping monitor grants (OPENBRAIN_MONITOR_PASSWORD unset)';
  END IF;
END;
$$ LANGUAGE plpgsql;
