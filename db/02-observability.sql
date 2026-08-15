-- Corpus-side observability schema for MCP auth events.
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
--   docker compose --env-file .env exec -T postgres \
--     psql -U postgres -d openbrain < ../../db/02-observability.sql
--
-- A deployment whose database is not in that compose project has nothing to
-- exec into. The split Qubes topology's procedure — a guarded network psql
-- connection — is in deploy/qubes/app-qube/README.md §"Upgrading an existing
-- deployment"; any other external-Postgres layout applies this same file over
-- its own connection.
--
-- Funnel request metadata deliberately lives in the separate log-sink schema
-- under db/log-sink/. The corpus assertion rejects those tables and their edge
-- roles if a deployment ever drifts back to the former shared-database shape.
-- See deploy/compose-tailnet/README.md §"Observability (Pattern B)".

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
-- verified identity: anonymous failures retain for 30 days — EXCEPT
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

-- ---------- Grants ---------------------------------------------------------
-- openbrain_app writes auth decisions and runs their retention/report query.
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_auth_events TO openbrain_app;
GRANT USAGE ON SEQUENCE mcp_auth_events_id_seq TO openbrain_app;

-- openbrain_readonly can inspect and back up corpus auth events. Funnel rows
-- are intentionally absent from this cluster and from its backup role.
-- The sequence SELECT lets `pg_dump -U openbrain_readonly` read BIGSERIAL state.
-- (01-schema.sql also grants future public sequences via ALTER DEFAULT
-- PRIVILEGES, but that only fires for objects created by the role that ran it;
-- these explicit grants don't depend on the creating role.)
GRANT SELECT ON mcp_auth_events TO openbrain_readonly;
GRANT SELECT ON SEQUENCE mcp_auth_events_id_seq TO openbrain_readonly;
