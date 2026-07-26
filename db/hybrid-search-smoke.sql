-- CI-only functional/planner smoke for db/05-hybrid-search.sql and the live
-- server/queries.ts candidate shape. This file is not mounted into
-- docker-entrypoint-initdb.d; .github/workflows/db-init.yml runs it explicitly.

\set ON_ERROR_STOP on

BEGIN;

WITH vectors AS (
  SELECT
    ('[' || '1,' || rtrim(repeat('0,', 767), ',') || ']')::vector AS near,
    ('[' || '-1,' || rtrim(repeat('0,', 767), ',') || ']')::vector AS far
)
INSERT INTO thoughts (content, embedding, metadata)
SELECT content, embedding, metadata
FROM vectors
CROSS JOIN LATERAL (
  VALUES
    (
      'A semantic-only deployment memory with no literal ticket token',
      vectors.near,
      '{"_ci_hybrid_search_fixture":true,"kind":"vector"}'::jsonb
    ),
    (
      'Exact incident identifier OPS-275 belongs to the hybrid search work',
      vectors.far,
      '{"_ci_hybrid_search_fixture":true,"kind":"fts"}'::jsonb
    ),
    (
      'The search_thoughts_v2 symbol keeps underscores and a version suffix',
      vectors.far,
      '{"_ci_hybrid_search_fixture":true,"kind":"literal"}'::jsonb
    )
) AS fixture(content, embedding, metadata);

DO $$
DECLARE
  generated_kind TEXT;
  fts_count INTEGER;
  literal_count INTEGER;
  exact_token_vector_count INTEGER;
  hybrid_count INTEGER;
BEGIN
  SELECT is_generated INTO generated_kind
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'thoughts'
    AND column_name = 'content_tsv';

  IF generated_kind IS DISTINCT FROM 'ALWAYS' THEN
    RAISE EXCEPTION 'content_tsv is not a stored generated column';
  END IF;
  IF to_regclass('public.idx_thoughts_content_tsv') IS NULL THEN
    RAISE EXCEPTION 'idx_thoughts_content_tsv is missing';
  END IF;
  IF to_regclass('public.idx_thoughts_content_trgm') IS NULL THEN
    RAISE EXCEPTION 'idx_thoughts_content_trgm is missing';
  END IF;

  SELECT count(*) INTO fts_count
  FROM thoughts
  WHERE metadata @> '{"_ci_hybrid_search_fixture":true}'::jsonb
    AND content_tsv @@ websearch_to_tsquery('simple', 'OPS-275');

  SELECT count(*) INTO literal_count
  FROM thoughts
  WHERE metadata @> '{"_ci_hybrid_search_fixture":true}'::jsonb
    AND content ILIKE '%' || 'search\_thoughts\_v2' || '%' ESCAPE '\';

  SELECT count(*) INTO exact_token_vector_count
  FROM thoughts
  WHERE metadata @> '{"_ci_hybrid_search_fixture":true,"kind":"fts"}'::jsonb
    AND 1 - (
      embedding <=> (
        '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
      )::vector
    ) >= 0.5;

  WITH query_input AS (
    SELECT websearch_to_tsquery('simple', 'OPS-275') AS ts_query
  ),
  vector_candidates AS MATERIALIZED (
    SELECT id,
           embedding <=> (
             '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
           )::vector AS distance
    FROM thoughts
    WHERE metadata @> '{"_ci_hybrid_search_fixture":true}'::jsonb
      AND 1 - (
        embedding <=> (
          '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
        )::vector
      ) >= 0.5
    ORDER BY embedding <=> (
      '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
    )::vector
    LIMIT 50
  ),
  vector_hits AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS vector_rank
    FROM vector_candidates
  ),
  lexical_candidates AS MATERIALIZED (
    SELECT id,
           CASE WHEN content_tsv @@ query_input.ts_query THEN 0 ELSE 1 END
             AS source_priority,
           ts_rank_cd(content_tsv, query_input.ts_query) AS lexical_score,
           created_at
    FROM thoughts
    CROSS JOIN query_input
    WHERE btrim('OPS-275') <> ''
      AND metadata @> '{"_ci_hybrid_search_fixture":true}'::jsonb
      AND (
        content_tsv @@ query_input.ts_query
        OR content ILIKE '%' || 'OPS-275' || '%' ESCAPE '\'
      )
    ORDER BY source_priority, lexical_score DESC, created_at DESC, id
    LIMIT 50
  ),
  lexical_hits AS (
    SELECT id,
           ROW_NUMBER() OVER (
             ORDER BY source_priority, lexical_score DESC, created_at DESC, id
           ) AS lexical_rank
    FROM lexical_candidates
  ),
  candidates AS (
    SELECT COALESCE(vector_hits.id, lexical_hits.id) AS id,
           vector_hits.vector_rank,
           lexical_hits.lexical_rank
    FROM vector_hits
    FULL OUTER JOIN lexical_hits USING (id)
  ),
  fused_rows AS (
    SELECT thoughts.id,
           1 - (
             thoughts.embedding <=> (
               '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
             )::vector
           ) AS similarity,
           candidates.vector_rank,
           candidates.lexical_rank
    FROM candidates
    JOIN thoughts USING (id)
  )
  SELECT count(*) INTO hybrid_count FROM fused_rows;

  IF fts_count <> 1 THEN
    RAISE EXCEPTION 'simple FTS returned %, expected 1 exact-token row', fts_count;
  END IF;
  IF literal_count <> 1 THEN
    RAISE EXCEPTION 'escaped literal fallback returned %, expected 1 row', literal_count;
  END IF;
  IF exact_token_vector_count <> 0 THEN
    RAISE EXCEPTION 'exact-token fixture unexpectedly passed vector threshold';
  END IF;
  IF hybrid_count <> 2 THEN
    RAISE EXCEPTION 'hybrid candidate union returned %, expected 2 rows', hybrid_count;
  END IF;
END;
$$;

-- Small fixtures make sequential scans rational. Disable them locally only to
-- prove PostgreSQL can select both indexes for the production predicates.
SET LOCAL enable_seqscan = off;

EXPLAIN
WITH vector_candidates AS MATERIALIZED (
  SELECT id,
         embedding <=> (
           '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
         )::vector AS distance
  FROM thoughts
  WHERE 1 - (
    embedding <=> (
      '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
    )::vector
  ) >= 0.5
  ORDER BY embedding <=> (
    '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
  )::vector
  LIMIT 50
)
SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS vector_rank
FROM vector_candidates;

EXPLAIN
SELECT id
FROM thoughts
WHERE content_tsv @@ websearch_to_tsquery('simple', 'OPS-275');

EXPLAIN
SELECT id
FROM thoughts
WHERE content ILIKE '%' || 'search\_thoughts\_v2' || '%' ESCAPE '\';

-- Exact lexical-candidate shape from queries.ts: PostgreSQL may combine the
-- two GIN indexes with a BitmapOr before sorting the bounded candidate set.
EXPLAIN
WITH query_input AS (
  SELECT websearch_to_tsquery('simple', 'OPS-275') AS ts_query
)
SELECT id,
       CASE WHEN content_tsv @@ query_input.ts_query THEN 0 ELSE 1 END
         AS source_priority,
       ts_rank_cd(content_tsv, query_input.ts_query) AS lexical_score,
       created_at
FROM thoughts
CROSS JOIN query_input
WHERE btrim('OPS-275') <> ''
  AND (
    content_tsv @@ query_input.ts_query
    OR content ILIKE '%' || 'OPS-275' || '%' ESCAPE '\'
  )
ORDER BY source_priority, lexical_score DESC, created_at DESC, id
LIMIT 50;

ROLLBACK;
