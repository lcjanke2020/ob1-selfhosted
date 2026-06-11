-- Open Brain — Homelab + Tailscale schema
-- Vanilla Postgres + pgvector. No Supabase auth, no RLS.
-- Trust boundary is Tailscale + the x-brain-key header on the MCP server.
--
-- Embedding dimension is 768 to match nomic-embed-text (Ollama default).
-- If you change EMBED_MODEL, change vector(768) below to match the model's
-- output dimension and re-embed any existing rows.
--
-- Roles `openbrain_app` and `openbrain_readonly` are created by 00-roles.sh
-- before this script runs.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Schema ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS thoughts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content             TEXT NOT NULL,
  embedding           VECTOR(768),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_fingerprint TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_thoughts_embedding_hnsw
  ON thoughts USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
  ON thoughts USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
  ON thoughts (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
  ON thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

-- ---------- Triggers -------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------- Functions ------------------------------------------------------

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(768),
  match_threshold FLOAT DEFAULT 0.5,
  match_count     INT   DEFAULT 10,
  filter          JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Note: there used to be an `upsert_thought()` SQL function here, but it
-- duplicated the dedupe logic that `server/queries.ts:captureThought` already
-- runs inline (and silently diverged from it — the SQL version didn't refresh
-- the embedding on conflict). The TS path is the single source of truth.
-- If a future Python/CLI recipe needs a text-only backfill upsert primitive,
-- reintroduce it here deliberately with its semantics documented and have
-- the TS path call it via RPC.

-- ---------- Grants ---------------------------------------------------------
-- Tightened from "full DML on the whole public schema" to the
-- minimum the application actually uses: SELECT/INSERT/UPDATE on
-- `public.thoughts`. An audit confirmed zero DELETE statements in queries.ts,
-- so DELETE is dropped too. Sequence USAGE and function EXECUTE on the
-- whole schema are also revoked; `thoughts.id` is UUID (no sequence) and
-- pgcrypto/pgvector built-ins are PUBLIC-executable by default, so the
-- application path keeps working without them. ALTER DEFAULT PRIVILEGES
-- is torn down so future tables in `public.` (e.g. the
-- observability set) don't auto-inherit app-role grants; the ones the
-- app role legitimately needs are granted explicitly in
-- 02-observability.sql.

-- Tear down historical broad grants. REVOKE of a privilege not currently
-- held is a no-op, so this block is safe to re-run against a freshly
-- initialized DB AND against long-running / restored DBs that still
-- have the old broad grants.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM openbrain_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM openbrain_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM openbrain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES    FROM openbrain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM openbrain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM openbrain_app;

-- Application role: only what the MCP server exercises against `thoughts`.
GRANT USAGE ON SCHEMA public TO openbrain_app;
GRANT SELECT, INSERT, UPDATE ON thoughts TO openbrain_app;

-- Read-only role: SELECT-only on the whole public schema is intentional —
-- ad-hoc DBeaver/psql exploration ("what does funnel_access_summary look
-- like today") is exactly the point. Default privileges preserved so
-- future tables remain inspectable.
GRANT USAGE ON SCHEMA public TO openbrain_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openbrain_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO openbrain_readonly;

-- The grants-invariant assertion lives in 03-grants-assertion.sql so it
-- runs after both 01-schema.sql AND 02-observability.sql, AND can be
-- invoked standalone against a deployed DB to check for drift without
-- the REVOKE+GRANT block above wiping that drift first. See that file's
-- doc-comment for the rationale.
