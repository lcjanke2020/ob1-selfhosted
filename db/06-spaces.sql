-- Open Brain fail-closed workspace/project/visibility scoping.
--
-- Adds a server-enforced audience boundary to public.thoughts and
-- sessions.session. Request scope is installed by the application with
-- transaction-local `openbrain.*` settings; absent settings match no rows.
-- The application role therefore cannot widen a read by accidentally omitting
-- a SQL predicate. The trusted `openbrain_readonly` backup/exploration role
-- receives SELECT grants plus BYPASSRLS for pg_dump; superusers retain their
-- normal administrative bypass.
--
-- Existing rows migrate to the reserved `default` workspace with workspace
-- visibility. The reserved `sensitive` workspace defaults new application
-- captures to personal visibility and rejects broader application writes.
--
-- Apply after 04-sessions.sql and 05-hybrid-search.sql. Apply any subsequent
-- numbered migrations, then run the stable 03-grants-assertion.sql source last.
-- This migration takes table locks while
-- adding/backfilling audience columns and rebuilding the thought fingerprint
-- unique index; use a full application maintenance window on an existing DB.

BEGIN;

-- pg_dump sets row_security=off and refuses to COPY an RLS-protected table as
-- a non-bypass role. The dedicated backup/exploration role already has SELECT
-- grants and no DML; BYPASSRLS is its single RLS escape mechanism, so it needs
-- no permissive policy. Keep openbrain_app subject to FORCE RLS.
ALTER ROLE openbrain_readonly BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS memory_scope;
REVOKE ALL ON SCHEMA memory_scope FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'visibility' AND n.nspname = 'memory_scope'
  ) THEN
    CREATE TYPE memory_scope.visibility AS ENUM (
      'personal',
      'project',
      'workspace'
    );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS memory_scope.workspace (
  id                 TEXT PRIMARY KEY,
  description        TEXT,
  default_visibility memory_scope.visibility NOT NULL DEFAULT 'workspace',
  personal_only      BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_id_shape CHECK (
    id = btrim(id) AND char_length(id) BETWEEN 1 AND 128
  ),
  CONSTRAINT workspace_personal_default CHECK (
    NOT personal_only OR default_visibility = 'personal'
  )
);

CREATE TABLE IF NOT EXISTS memory_scope.project (
  workspace_id TEXT NOT NULL
    REFERENCES memory_scope.workspace(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  id           TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT project_id_shape CHECK (
    id = btrim(id) AND char_length(id) BETWEEN 1 AND 128
  )
);

INSERT INTO memory_scope.workspace (
  id, description, default_visibility, personal_only
) VALUES
  (
    'default',
    'Backward-compatible workspace for legacy and omitted-scope calls.',
    'workspace',
    false
  ),
  (
    'sensitive',
    'Personal-only workspace for particularly sensitive thoughts and sessions.',
    'personal',
    true
  )
ON CONFLICT (id) DO UPDATE SET
  description = EXCLUDED.description,
  default_visibility = EXCLUDED.default_visibility,
  personal_only = EXCLUDED.personal_only;

-- ---------- Thoughts -------------------------------------------------------

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS visibility memory_scope.visibility,
  ADD COLUMN IF NOT EXISTS owner_subject TEXT;

UPDATE public.thoughts
SET workspace_id = COALESCE(workspace_id, 'default'),
    visibility = COALESCE(visibility, 'workspace')
WHERE workspace_id IS NULL OR visibility IS NULL;

ALTER TABLE public.thoughts
  ALTER COLUMN workspace_id SET DEFAULT 'default',
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN visibility SET DEFAULT 'workspace',
  ALTER COLUMN visibility SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.thoughts'::regclass
      AND conname = 'thoughts_workspace_fkey'
  ) THEN
    ALTER TABLE public.thoughts
      ADD CONSTRAINT thoughts_workspace_fkey
      FOREIGN KEY (workspace_id) REFERENCES memory_scope.workspace(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.thoughts'::regclass
      AND conname = 'thoughts_project_fkey'
  ) THEN
    ALTER TABLE public.thoughts
      ADD CONSTRAINT thoughts_project_fkey
      FOREIGN KEY (workspace_id, project_id)
      REFERENCES memory_scope.project(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.thoughts'::regclass
      AND conname = 'thoughts_audience_shape'
  ) THEN
    ALTER TABLE public.thoughts
      ADD CONSTRAINT thoughts_audience_shape CHECK (
        (
          visibility = 'personal'
          AND project_id IS NULL
          AND owner_subject IS NOT NULL
          AND owner_subject <> ''
        ) OR (
          visibility = 'project'
          AND project_id IS NOT NULL
          AND owner_subject IS NULL
        ) OR (
          visibility = 'workspace'
          AND project_id IS NULL
          AND owner_subject IS NULL
        )
      );
  END IF;
END;
$$;

-- The old global fingerprint index would merge identical content across
-- audiences. NULLS NOT DISTINCT makes the canonical NULL fields participate in
-- uniqueness, so the same content dedupes only inside one exact audience.
DROP INDEX IF EXISTS public.idx_thoughts_fingerprint;
CREATE UNIQUE INDEX idx_thoughts_fingerprint
  ON public.thoughts (
    workspace_id,
    project_id,
    visibility,
    owner_subject,
    content_fingerprint
  ) NULLS NOT DISTINCT
  WHERE content_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thoughts_scope_audience
  ON public.thoughts (
    workspace_id,
    visibility,
    project_id,
    owner_subject,
    created_at DESC
  );

-- ---------- Sessions -------------------------------------------------------

ALTER TABLE sessions.session
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS visibility memory_scope.visibility,
  ADD COLUMN IF NOT EXISTS owner_subject TEXT;

UPDATE sessions.session
SET workspace_id = COALESCE(workspace_id, 'default'),
    visibility = COALESCE(visibility, 'workspace')
WHERE workspace_id IS NULL OR visibility IS NULL;

ALTER TABLE sessions.session
  ALTER COLUMN workspace_id SET DEFAULT 'default',
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN visibility SET DEFAULT 'workspace',
  ALTER COLUMN visibility SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sessions.session'::regclass
      AND conname = 'session_workspace_fkey'
  ) THEN
    ALTER TABLE sessions.session
      ADD CONSTRAINT session_workspace_fkey
      FOREIGN KEY (workspace_id) REFERENCES memory_scope.workspace(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sessions.session'::regclass
      AND conname = 'session_project_fkey'
  ) THEN
    ALTER TABLE sessions.session
      ADD CONSTRAINT session_project_fkey
      FOREIGN KEY (workspace_id, project_id)
      REFERENCES memory_scope.project(workspace_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sessions.session'::regclass
      AND conname = 'session_audience_shape'
  ) THEN
    ALTER TABLE sessions.session
      ADD CONSTRAINT session_audience_shape CHECK (
        (
          visibility = 'personal'
          AND project_id IS NULL
          AND owner_subject IS NOT NULL
          AND owner_subject <> ''
        ) OR (
          visibility = 'project'
          AND project_id IS NOT NULL
          AND owner_subject IS NULL
        ) OR (
          visibility = 'workspace'
          AND project_id IS NULL
          AND owner_subject IS NULL
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_session_scope_audience
  ON sessions.session (
    workspace_id,
    visibility,
    project_id,
    owner_subject,
    last_update DESC
  );

-- Centralize the policy comparison in one deliberately LEAKPROOF function. It
-- reads only transaction-local request context and the four non-content
-- audience columns, returns a boolean, and cannot throw based on protected row
-- content. PostgreSQL can move genuinely leakproof point/vector predicates
-- across the RLS barrier; non-leakproof FTS, trigram, and JSONB predicates use
-- the narrowly scoped candidate function below instead.
-- SECURITY DEFINER prevents SQL inlining from exposing the non-leakproof
-- implementation functions to the planner; the locked search_path avoids
-- object-shadowing in this privileged helper.
CREATE OR REPLACE FUNCTION memory_scope.audience_matches(
  row_workspace_id TEXT,
  row_project_id TEXT,
  row_visibility memory_scope.visibility,
  row_owner_subject TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
LEAKPROOF
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    row_workspace_id = NULLIF(
      pg_catalog.current_setting('openbrain.workspace_id', true),
      ''
    )
    AND row_visibility::text = ANY (
      pg_catalog.string_to_array(
        NULLIF(
          pg_catalog.current_setting('openbrain.visibilities', true),
          ''
        ),
        ','
      )
    )
    AND (
      (
        row_visibility = 'personal'
        AND NULLIF(
          pg_catalog.current_setting('openbrain.principal', true),
          ''
        ) IS NOT NULL
        AND row_owner_subject = NULLIF(
          pg_catalog.current_setting('openbrain.principal', true),
          ''
        )
      ) OR (
        row_visibility = 'project'
        AND NULLIF(
          pg_catalog.current_setting('openbrain.project_id', true),
          ''
        ) IS NOT NULL
        AND row_project_id = NULLIF(
          pg_catalog.current_setting('openbrain.project_id', true),
          ''
        )
      ) OR row_visibility = 'workspace'
    )
$$;

REVOKE ALL ON FUNCTION memory_scope.audience_matches(
  TEXT, TEXT, memory_scope.visibility, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_scope.audience_matches(
  TEXT, TEXT, memory_scope.visibility, TEXT
) TO openbrain_app;

-- FTS, trigram ILIKE, and JSONB containment are intentionally not marked
-- leakproof by PostgreSQL. A normal app-role SELECT must therefore evaluate
-- them after the RLS barrier and cannot use their GIN indexes. Keep direct
-- table access protected by RLS, but provide one narrow SECURITY DEFINER
-- candidate function whose fixed SQL applies the same audience predicate
-- explicitly. It returns IDs/ranks only; server/queries.ts joins those IDs
-- back through the RLS-protected table, so both layers must agree.
CREATE OR REPLACE FUNCTION memory_scope.search_thought_candidates(
  query_embedding public.vector,
  vector_threshold DOUBLE PRECISION,
  query_text TEXT,
  escaped_literal TEXT,
  use_literal_fallback BOOLEAN,
  include_filter JSONB,
  exclude_filters JSONB,
  candidate_limit INTEGER
)
RETURNS TABLE (
  candidate_id UUID,
  vector_rank BIGINT,
  lexical_rank BIGINT,
  lexical_source_priority INTEGER
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  filter_sql TEXT := '';
  search_sql TEXT;
  safe_limit INTEGER := LEAST(GREATEST(COALESCE(candidate_limit, 50), 1), 100);
  safe_threshold DOUBLE PRECISION := LEAST(
    GREATEST(COALESCE(vector_threshold, 0.5), 0.0),
    1.0
  );
BEGIN
  IF query_embedding IS NULL OR public.vector_dims(query_embedding) <> 768 THEN
    RAISE EXCEPTION 'query_embedding must have 768 dimensions';
  END IF;
  IF exclude_filters IS NULL THEN
    exclude_filters := '[]'::jsonb;
  ELSIF pg_catalog.jsonb_typeof(exclude_filters) <> 'array' THEN
    RAISE EXCEPTION 'exclude_filters must be a JSON array';
  END IF;

  -- These fragments are constants selected by null/empty state; all caller
  -- values remain bound parameters in EXECUTE USING.
  IF include_filter IS NOT NULL THEN
    filter_sql := filter_sql || ' AND t.metadata @> $6';
  END IF;
  IF exclude_filters <> '[]'::jsonb THEN
    filter_sql := filter_sql || $fragment$
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements($7) AS denied(filter)
        WHERE t.metadata @> denied.filter
      )$fragment$;
  END IF;

  search_sql := pg_catalog.format($query$
    WITH parsed_query AS (
      SELECT pg_catalog.websearch_to_tsquery('simple', $3) AS ts_query
    ),
    query_input AS (
      SELECT ts_query,
             pg_catalog.querytree(ts_query) NOT IN ('', 'T')
               AS has_indexable_query,
             $5::boolean
               AND ts_query::text !~ '(^|[ (])!' AS use_literal_fallback
      FROM parsed_query
    ),
    vector_candidates AS MATERIALIZED (
      SELECT t.id,
             t.embedding OPERATOR(public.<=>) $1 AS distance
      FROM public.thoughts AS t
      WHERE memory_scope.audience_matches(
              t.workspace_id, t.project_id, t.visibility, t.owner_subject
            )
        AND 1 - (t.embedding OPERATOR(public.<=>) $1) >= $2
        %1$s
      ORDER BY t.embedding OPERATOR(public.<=>) $1
      LIMIT $8
    ),
    vector_hits AS (
      SELECT id,
             pg_catalog.row_number() OVER (ORDER BY distance, id)
               AS vector_rank
      FROM vector_candidates
    ),
    lexical_candidates AS MATERIALIZED (
      SELECT t.id,
             CASE
               WHEN t.content_tsv OPERATOR(pg_catalog.@@) query_input.ts_query
                 THEN 0
               ELSE 1
             END AS source_priority,
             pg_catalog.ts_rank_cd(t.content_tsv, query_input.ts_query)
               AS lexical_score,
             t.created_at
      FROM public.thoughts AS t
      CROSS JOIN query_input
      WHERE memory_scope.audience_matches(
              t.workspace_id, t.project_id, t.visibility, t.owner_subject
            )
        AND query_input.has_indexable_query
        %1$s
        AND (
          t.content_tsv OPERATOR(pg_catalog.@@) query_input.ts_query
          OR (
            query_input.use_literal_fallback
            AND t.content ILIKE '%%' || $4 || '%%' ESCAPE '\'
          )
        )
      ORDER BY source_priority, lexical_score DESC, t.created_at DESC, t.id
      LIMIT $8
    ),
    lexical_hits AS (
      SELECT id,
             source_priority AS lexical_source_priority,
             pg_catalog.row_number() OVER (
               ORDER BY source_priority, lexical_score DESC, created_at DESC, id
             ) AS lexical_rank
      FROM lexical_candidates
    )
    SELECT COALESCE(vector_hits.id, lexical_hits.id) AS candidate_id,
           vector_hits.vector_rank,
           lexical_hits.lexical_rank,
           lexical_hits.lexical_source_priority
    FROM vector_hits
    FULL OUTER JOIN lexical_hits USING (id)
  $query$, filter_sql);

  RETURN QUERY EXECUTE search_sql USING
    query_embedding,
    safe_threshold,
    query_text,
    escaped_literal,
    use_literal_fallback,
    include_filter,
    exclude_filters,
    safe_limit;
END;
$$;

REVOKE ALL ON FUNCTION memory_scope.search_thought_candidates(
  public.vector, DOUBLE PRECISION, TEXT, TEXT, BOOLEAN, JSONB, JSONB, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_scope.search_thought_candidates(
  public.vector, DOUBLE PRECISION, TEXT, TEXT, BOOLEAN, JSONB, JSONB, INTEGER
) TO openbrain_app;

-- ---------- Row-level enforcement -----------------------------------------
--
-- Missing transaction-local settings yield NULL and match nothing. `visibility`
-- is a comma-separated allowlist installed only from validated enum values.
-- Project/personal/workspace clauses implement the server-computed union;
-- WITH CHECK additionally makes a personal-only workspace reject broader rows.

ALTER TABLE public.thoughts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thoughts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thoughts_app_audience ON public.thoughts;
CREATE POLICY thoughts_app_audience ON public.thoughts
  FOR ALL TO openbrain_app
  USING (
    memory_scope.audience_matches(
      workspace_id, project_id, visibility, owner_subject
    )
  )
  WITH CHECK (
    memory_scope.audience_matches(
      workspace_id, project_id, visibility, owner_subject
    )
    AND EXISTS (
      SELECT 1
      FROM memory_scope.workspace AS w
      WHERE w.id = workspace_id
        AND (NOT w.personal_only OR visibility = 'personal')
    )
  );

DROP POLICY IF EXISTS thoughts_readonly_all ON public.thoughts;

ALTER TABLE sessions.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions.session FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_app_audience ON sessions.session;
CREATE POLICY session_app_audience ON sessions.session
  FOR ALL TO openbrain_app
  USING (
    memory_scope.audience_matches(
      workspace_id, project_id, visibility, owner_subject
    )
  )
  WITH CHECK (
    memory_scope.audience_matches(
      workspace_id, project_id, visibility, owner_subject
    )
    AND EXISTS (
      SELECT 1
      FROM memory_scope.workspace AS w
      WHERE w.id = workspace_id
        AND (NOT w.personal_only OR visibility = 'personal')
    )
  );

DROP POLICY IF EXISTS session_readonly_all ON sessions.session;

ALTER TABLE sessions.artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions.artifact FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS artifact_app_audience ON sessions.artifact;
CREATE POLICY artifact_app_audience ON sessions.artifact
  FOR ALL TO openbrain_app
  USING (
    EXISTS (
      SELECT 1 FROM sessions.session AS s WHERE s.id = session_pk
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions.session AS s WHERE s.id = session_pk
    )
  );

DROP POLICY IF EXISTS artifact_readonly_all ON sessions.artifact;

-- ---------- Grants ---------------------------------------------------------

GRANT USAGE ON SCHEMA memory_scope TO openbrain_app;
GRANT SELECT ON memory_scope.workspace, memory_scope.project TO openbrain_app;

GRANT USAGE ON SCHEMA memory_scope TO openbrain_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA memory_scope TO openbrain_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA memory_scope
  GRANT SELECT ON TABLES TO openbrain_readonly;

COMMIT;

ANALYZE memory_scope.workspace;
ANALYZE memory_scope.project;
ANALYZE public.thoughts;
ANALYZE sessions.session;
