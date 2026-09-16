-- Index-only passage vectors. Run as the database owner, then use the
-- reviewed backfill/cutover procedure in docs/embedding-limits.md. This
-- migration never embeds text and never activates an incomplete generation.
BEGIN;

CREATE TABLE IF NOT EXISTS memory_scope.embedding_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  contract text CHECK (contract ~ '^[a-f0-9]{64}$')
);
INSERT INTO memory_scope.embedding_generation(singleton)
VALUES (true) ON CONFLICT DO NOTHING;

-- Arrays deliberately keep one index row per canonical parent. Exact passage
-- scoring avoids ANN duplicate-candidate starvation; statement_timeout bounds
-- latency. This is not an assertion that LIMIT bounds the scan's work.
CREATE TABLE IF NOT EXISTS public.thought_embedding_index (
  thought_id uuid PRIMARY KEY REFERENCES public.thoughts(id) ON DELETE CASCADE,
  contract text NOT NULL CHECK (contract ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  vectors public.vector(768)[] NOT NULL
    CHECK (cardinality(vectors) BETWEEN 1 AND 128 AND array_ndims(vectors) = 1)
);
CREATE TABLE IF NOT EXISTS sessions.embedding_index (
  session_id bigint PRIMARY KEY REFERENCES sessions.session(id) ON DELETE CASCADE,
  contract text NOT NULL CHECK (contract ~ '^[a-f0-9]{64}$'),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  vectors public.vector(768)[] NOT NULL
    CHECK (cardinality(vectors) BETWEEN 1 AND 128 AND array_ndims(vectors) = 1)
);

CREATE OR REPLACE FUNCTION memory_scope.session_embedding_hash(
  title text, goal text, summary text, resume_context text
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(
    convert_to(coalesce(title, ''), 'UTF8') || '\x00'::bytea ||
    convert_to(coalesce(goal, ''), 'UTF8') || '\x00'::bytea ||
    convert_to(coalesce(summary, ''), 'UTF8') || '\x00'::bytea ||
    convert_to(coalesce(resume_context, ''), 'UTF8')
  ), 'hex')
$$;

ALTER TABLE public.thought_embedding_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_embedding_index FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions.embedding_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions.embedding_index FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thought_embedding_audience ON public.thought_embedding_index;
CREATE POLICY thought_embedding_audience ON public.thought_embedding_index
  TO openbrain_app USING (EXISTS (
    SELECT 1 FROM public.thoughts t WHERE t.id = public.thought_embedding_index.thought_id
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM public.thoughts t WHERE t.id = public.thought_embedding_index.thought_id
  ));
DROP POLICY IF EXISTS session_embedding_audience ON sessions.embedding_index;
CREATE POLICY session_embedding_audience ON sessions.embedding_index
  TO openbrain_app USING (EXISTS (
    SELECT 1 FROM sessions.session s WHERE s.id = sessions.embedding_index.session_id
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM sessions.session s WHERE s.id = sessions.embedding_index.session_id
  ));

-- Defense against old writers and hand-written SQL: source-changing parent
-- updates invalidate the dependent index in the same transaction. Normal app
-- writes replace it before commit. Scope moves require no copied ACL update.
CREATE OR REPLACE FUNCTION memory_scope.invalidate_embedding_index()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_SCHEMA = 'public' THEN
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      DELETE FROM public.thought_embedding_index WHERE thought_id = NEW.id;
    END IF;
  ELSIF ROW(coalesce(NEW.title,''), coalesce(NEW.goal,''), coalesce(NEW.summary,''), coalesce(NEW.resume_context,''))
    IS DISTINCT FROM ROW(coalesce(OLD.title,''), coalesce(OLD.goal,''), coalesce(OLD.summary,''), coalesce(OLD.resume_context,'')) THEN
    DELETE FROM sessions.embedding_index WHERE session_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS thoughts_invalidate_embedding ON public.thoughts;
CREATE TRIGGER thoughts_invalidate_embedding AFTER UPDATE ON public.thoughts
  FOR EACH ROW EXECUTE FUNCTION memory_scope.invalidate_embedding_index();
DROP TRIGGER IF EXISTS session_invalidate_embedding ON sessions.session;
CREATE TRIGGER session_invalidate_embedding AFTER UPDATE ON sessions.session
  FOR EACH ROW EXECUTE FUNCTION memory_scope.invalidate_embedding_index();

CREATE OR REPLACE FUNCTION memory_scope.check_embedding_index()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE expected_hash text; value public.vector;
BEGIN
  IF TG_TABLE_SCHEMA = 'public' THEN
    SELECT encode(sha256(convert_to(content, 'UTF8')), 'hex') INTO expected_hash
      FROM public.thoughts WHERE id = NEW.thought_id FOR UPDATE;
  ELSE
    SELECT memory_scope.session_embedding_hash(title, goal, summary, resume_context)
      INTO expected_hash FROM sessions.session WHERE id = NEW.session_id FOR UPDATE;
  END IF;
  IF expected_hash IS NULL OR expected_hash <> NEW.source_hash THEN
    RAISE EXCEPTION 'embedding source changed; index not committed';
  END IF;
  FOREACH value IN ARRAY NEW.vectors LOOP
    IF value IS NULL OR public.vector_dims(value) <> 768 OR public.vector_norm(value) = 0 THEN
      RAISE EXCEPTION 'embedding vector is null, zero, or has wrong dimensions';
    END IF;
  END LOOP;
  IF current_user = 'openbrain_app' AND NOT EXISTS (
    SELECT 1 FROM memory_scope.embedding_generation WHERE contract = NEW.contract
  ) THEN
    RAISE EXCEPTION 'embedding contract not activated; write rolled back';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS thought_embedding_check ON public.thought_embedding_index;
CREATE TRIGGER thought_embedding_check BEFORE INSERT OR UPDATE ON public.thought_embedding_index
  FOR EACH ROW EXECUTE FUNCTION memory_scope.check_embedding_index();
DROP TRIGGER IF EXISTS session_embedding_check ON sessions.embedding_index;
CREATE TRIGGER session_embedding_check BEFORE INSERT OR UPDATE ON sessions.embedding_index
  FOR EACH ROW EXECUTE FUNCTION memory_scope.check_embedding_index();

-- Only a boolean health gate leaves this definer. No IDs, counts, text, or
-- vectors from another audience are exposed. It deliberately checks the whole
-- corpus so cutover cannot silently hide records that have not been rebuilt.
CREATE OR REPLACE FUNCTION memory_scope.embedding_ready(expected_contract text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM memory_scope.embedding_generation WHERE contract = expected_contract
  ) AND NOT EXISTS (
    SELECT 1 FROM public.thoughts t LEFT JOIN public.thought_embedding_index i ON i.thought_id = t.id
    WHERE i.contract IS DISTINCT FROM expected_contract
      OR i.source_hash IS DISTINCT FROM encode(sha256(convert_to(t.content, 'UTF8')), 'hex')
  ) AND NOT EXISTS (
    SELECT 1 FROM sessions.session s LEFT JOIN sessions.embedding_index i ON i.session_id = s.id
    WHERE i.contract IS DISTINCT FROM expected_contract
      OR i.source_hash IS DISTINCT FROM memory_scope.session_embedding_hash(s.title,s.goal,s.summary,s.resume_context)
  )
$$;

REVOKE ALL ON memory_scope.embedding_generation, public.thought_embedding_index, sessions.embedding_index FROM PUBLIC, openbrain_app;
GRANT SELECT ON memory_scope.embedding_generation TO openbrain_app, openbrain_readonly;
GRANT SELECT, INSERT, UPDATE ON public.thought_embedding_index, sessions.embedding_index TO openbrain_app;
GRANT SELECT ON public.thought_embedding_index, sessions.embedding_index TO openbrain_readonly;
REVOKE ALL ON FUNCTION memory_scope.session_embedding_hash(text,text,text,text),
  memory_scope.invalidate_embedding_index(), memory_scope.check_embedding_index(),
  memory_scope.embedding_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_scope.session_embedding_hash(text,text,text,text),
  memory_scope.embedding_ready(text) TO openbrain_app;
CREATE OR REPLACE FUNCTION memory_scope.search_thought_candidates(
  query_embedding public.vector,
  vector_threshold DOUBLE PRECISION,
  query_text TEXT,
  escaped_literal TEXT,
  use_literal_fallback BOOLEAN,
  include_filter JSONB,
  exclude_filters JSONB,
  candidate_limit INTEGER,
  index_contract TEXT
)
RETURNS TABLE (
  candidate_id UUID,
  vector_rank BIGINT,
  lexical_rank BIGINT,
  lexical_source_priority INTEGER,
  similarity DOUBLE PRECISION
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
  IF NOT memory_scope.embedding_ready(index_contract) THEN
    RAISE EXCEPTION 'embedding index not ready for runtime/model contract';
  END IF;
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
    eligible_distances AS MATERIALIZED (
      SELECT t.id, min(chunk.vector OPERATOR(public.<=>) $1) AS distance
      FROM public.thoughts AS t
      JOIN public.thought_embedding_index AS i ON i.thought_id = t.id
      CROSS JOIN LATERAL unnest(i.vectors) AS chunk(vector)
      WHERE i.contract = $9 AND memory_scope.audience_matches(
        t.workspace_id, t.project_id, t.visibility, t.owner_subject
      ) %1$s
      GROUP BY t.id
    ),
    vector_candidates AS MATERIALIZED (
      SELECT id, distance FROM eligible_distances
      WHERE 1 - distance >= $2
      ORDER BY distance, id LIMIT $8
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
           lexical_hits.lexical_source_priority,
           1 - eligible_distances.distance AS similarity
    FROM vector_hits
    FULL OUTER JOIN lexical_hits USING (id)
    LEFT JOIN eligible_distances ON eligible_distances.id = COALESCE(vector_hits.id, lexical_hits.id)
  $query$, filter_sql);

  RETURN QUERY EXECUTE search_sql USING
    query_embedding,
    safe_threshold,
    query_text,
    escaped_literal,
    use_literal_fallback,
    include_filter,
    exclude_filters,
    safe_limit,
    index_contract;
END;
$$;

REVOKE ALL ON FUNCTION memory_scope.search_thought_candidates(
  public.vector, DOUBLE PRECISION, TEXT, TEXT, BOOLEAN, JSONB, JSONB, INTEGER, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_scope.search_thought_candidates(
  public.vector, DOUBLE PRECISION, TEXT, TEXT, BOOLEAN, JSONB, JSONB, INTEGER, TEXT
) TO openbrain_app;


COMMIT;
