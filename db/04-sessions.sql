-- Open Brain — session tracking schema.
--
-- Adds a session-tracking layer ALONGSIDE thoughts. The canonical artifact is
-- a TOML front-matter file (Syncthing-replicated, survives a DB wipe); this
-- schema is a DERIVED INDEX over those files — structured columns for
-- exact/filter queries plus one embedding for semantic recall. Because it is
-- derived, the shape is reshape-able: rebuild by re-ingesting the TOML files.
--
-- Lives in its own `sessions` schema. `public.thoughts` is untouched, so
-- upstream `thoughts` merges stay clean and the grants invariant
-- (03-grants-assertion.sql, scoped to public.thoughts) is unaffected.
--
-- Embedding dimension is 768 to match nomic-embed-text (EMBED_DIM). It is NOT
-- pinned independently of OB — if EMBED_MODEL/EMBED_DIM change ),
-- change vector(768) here AND in db/01-schema.sql together and re-embed.
--
-- IDEMPOTENT and re-runnable: init scripts only auto-run on a fresh data dir,
-- so apply to an existing deployment manually (safe to re-run):
--   docker compose exec -T postgres psql -U postgres -d openbrain < db/04-sessions.sql
--
-- Roles openbrain_app / openbrain_readonly are created by 00-roles.sh.

CREATE SCHEMA IF NOT EXISTS sessions;

-- ---------- Lifecycle enum -------------------------------------------------
-- CREATE TYPE has no IF NOT EXISTS, so guard it on the catalog so a manual
-- re-apply against a live DB doesn't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'session_status' AND n.nspname = 'sessions'
  ) THEN
    CREATE TYPE sessions.session_status AS ENUM (
      'active',
      'awaiting_review',
      'blocked',
      'done',
      'abandoned'
    );
  END IF;
END;
$$;

-- ---------- Tables ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions.session (
  -- session_id is supplied by the TOML (file-of-record); the default lets a
  -- partial/hand-written TOML still insert. pgcrypto is loaded by 01-schema.
  session_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  session_date      DATE,
  goal              TEXT,

  -- [identity]
  agent             TEXT,
  agent_version     TEXT,
  harness           TEXT,

  -- [where]
  machine           TEXT,
  working_dir       TEXT,
  repo_url          TEXT,
  branch            TEXT,
  head              TEXT,
  worktree          TEXT,

  -- [when]
  started_at        TIMESTAMPTZ,
  last_update       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  status            sessions.session_status NOT NULL DEFAULT 'active',

  -- [what] + lists. Arrays, not join tables: this is a derived index, not 3NF.
  tags              TEXT[] NOT NULL DEFAULT '{}',
  linked_issues     TEXT[] NOT NULL DEFAULT '{}',
  related_sessions  TEXT[] NOT NULL DEFAULT '{}',
  next_actions      TEXT[] NOT NULL DEFAULT '{}',
  blockers          TEXT[] NOT NULL DEFAULT '{}',

  -- resume + prose
  resume_context    TEXT,
  summary           TEXT,

  -- provenance: stamped server-side from the transport, NEVER trusted from the
  -- caller. source is 'tailnet' | 'funnel' (the door, matching
  -- thoughts.metadata.door — NOT 'mobile': the Funnel carries every Anthropic
  -- surface and the server can't tell them apart). source_node is the JWT sub
  -- on the funnel path, null on tailnet. needs_file_sync is true when a DB-only
  -- mutation (session_update_status, callable from either door) outran the
  -- canonical file; the next file-side session_capture reconciles it.
  source            TEXT,
  source_node       TEXT,
  ingested_path     TEXT,
  needs_file_sync   BOOLEAN NOT NULL DEFAULT false,

  -- canonical doc + change detection
  raw_toml          TEXT,
  content_hash      TEXT,

  -- semantic search. Dim MUST match OB's Ollama embed model (768).
  embedding         VECTOR(768),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions.artifact (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions.session(session_id) ON DELETE CASCADE,
  position    INT  NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,   -- pr | code | doc | note | ...
  title       TEXT NOT NULL,
  detail      TEXT
);

-- Strict-parse contract: the canonical `[[artifacts]]` TOML fields are kind/title/detail. The
-- original schema shipped ref/note; rename in place on existing deployments so
-- this file stays re-runnable (CREATE IF NOT EXISTS no-ops on a live table, so
-- it alone would never reshape the columns). Guarded on the catalog so a fresh
-- DB (already title/detail) and a re-apply are both no-ops. Renames preserve the
-- NOT NULL on the renamed-from `ref`, so `title` lands NOT NULL as declared.
-- Each rename also requires the TARGET column to be absent, so re-applying
-- against a hand-edited DB that already has both columns is a no-op instead of
-- erroring 42701.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'sessions' AND table_name = 'artifact'
      AND column_name = 'ref'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'sessions' AND table_name = 'artifact'
      AND column_name = 'title'
  ) THEN
    ALTER TABLE sessions.artifact RENAME COLUMN ref TO title;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'sessions' AND table_name = 'artifact'
      AND column_name = 'note'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'sessions' AND table_name = 'artifact'
      AND column_name = 'detail'
  ) THEN
    ALTER TABLE sessions.artifact RENAME COLUMN note TO detail;
  END IF;
END;
$$;

-- Provenance label correction: the funnel/OAuth door was originally stored as
-- 'mobile', but the Funnel carries all Anthropic surfaces (web/desktop/mobile)
-- and the server can't distinguish them (requests arrive from Anthropic egress,
-- not the device). Store the door faithfully as 'funnel', matching
-- thoughts.metadata.door. Idempotent: the WHERE matches nothing after the first
-- apply. Qualified UPDATE (never a blanket write).
UPDATE sessions.session SET source = 'funnel' WHERE source = 'mobile';

-- ---------- Indexes --------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_session_status
  ON sessions.session (status);
CREATE INDEX IF NOT EXISTS idx_session_repo_url
  ON sessions.session (repo_url);
CREATE INDEX IF NOT EXISTS idx_session_branch
  ON sessions.session (branch);
CREATE INDEX IF NOT EXISTS idx_session_last_update
  ON sessions.session (last_update DESC);
CREATE INDEX IF NOT EXISTS idx_session_tags_gin
  ON sessions.session USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_session_issues_gin
  ON sessions.session USING gin (linked_issues);
CREATE INDEX IF NOT EXISTS idx_session_embedding_hnsw
  ON sessions.session USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_artifact_session
  ON sessions.artifact (session_id);

-- ---------- Triggers -------------------------------------------------------
-- Reuse update_updated_at() from 01-schema.sql (keeps updated_at server-managed
-- and independent of the caller-supplied last_update field).

DROP TRIGGER IF EXISTS session_updated_at ON sessions.session;
CREATE TRIGGER session_updated_at
  BEFORE UPDATE ON sessions.session
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------- Grants ---------------------------------------------------------
-- Re-runnable: REVOKE of an unheld privilege is a no-op, GRANT is idempotent.
--
-- DELETE is granted on the sessions tables (unlike public.thoughts, where the
-- grants invariant forbids it) because session_capture reconciles artifact
-- children with a qualified delete-and-reinsert. The grants assertion in
-- 03-grants-assertion.sql is scoped to public.thoughts only, so this grant
-- does not affect it. Precedent: 02-observability.sql grants DML on its own
-- app-owned tables.

-- No sequence USAGE grant is needed here: sessions.artifact.id is
-- GENERATED ALWAYS AS IDENTITY, whose sequence is internally owned by the
-- column and advanced under the table's INSERT privilege — unlike
-- 02-observability.sql's BIGSERIAL columns, where the column default calls
-- nextval() under the inserter's own rights and therefore requires explicit
-- USAGE. (Verified: `SET ROLE openbrain_app` + INSERT omitting id succeeds.)
GRANT USAGE ON SCHEMA sessions TO openbrain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions.session  TO openbrain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions.artifact TO openbrain_app;

-- Read-only role: SELECT for ad-hoc DBeaver/psql exploration, mirroring the
-- public-schema stance in 01-schema.sql. Default privileges preserved so
-- future sessions.* tables stay inspectable.
GRANT USAGE ON SCHEMA sessions TO openbrain_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA sessions TO openbrain_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA sessions
  GRANT SELECT ON TABLES TO openbrain_readonly;
