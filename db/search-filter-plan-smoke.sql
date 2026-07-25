-- CI-only semantics and planner smoke for thought-provenance filtering.
-- This file is NOT mounted into docker-entrypoint-initdb.d. The DB-init
-- workflow runs it explicitly after the operational init/grant checks, then
-- asserts that the positive predicate names idx_thoughts_metadata and the
-- exclude-only iterative path names idx_thoughts_embedding_hnsw.
--
-- Bulk insertion can leave fresh GIN entries in the pending list, where the
-- planner correctly prices the index as temporarily expensive. VACUUM ANALYZE
-- flushes that list and gathers the selectivity statistics a maintained
-- deployment will have before the plan assertion runs.

\set ON_ERROR_STOP on

WITH constant_vector AS (
  SELECT (
    '[' || rtrim(repeat('0.1,', 768), ',') || ']'
  )::vector AS embedding
), cases(content, metadata) AS (
  VALUES
    (
      'search-filter-semantics-1',
      '{"_ci_search_filter_fixture":true,"provenance":{"schema_version":1,"caller_asserted":{"author":"alice","agent":"codex","repo":"target/repo"}}}'::jsonb
    ),
    (
      'search-filter-semantics-2',
      '{"_ci_search_filter_fixture":true,"provenance":{"schema_version":1,"caller_asserted":{"author":"bob","agent":"claude","repo":"target/repo"}}}'::jsonb
    ),
    (
      'search-filter-semantics-3',
      '{"_ci_search_filter_fixture":true,"provenance":{"schema_version":1,"caller_asserted":{"author":"alice","agent":"claude","repo":"other/repo"}}}'::jsonb
    ),
    (
      'search-filter-semantics-legacy',
      '{"_ci_search_filter_fixture":true}'::jsonb
    )
)
INSERT INTO thoughts (content, embedding, metadata)
SELECT cases.content, constant_vector.embedding, cases.metadata
FROM cases
CROSS JOIN constant_vector;

DO $$
DECLARE
  include_count INTEGER;
  exclude_count INTEGER;
  composed_count INTEGER;
BEGIN
  SELECT count(*) INTO include_count
  FROM thoughts
  WHERE metadata @> '{"_ci_search_filter_fixture":true}'::jsonb
    AND metadata @> '{"provenance":{"caller_asserted":{"repo":"target/repo"}}}'::jsonb;

  SELECT count(*) INTO exclude_count
  FROM thoughts
  WHERE metadata @> '{"_ci_search_filter_fixture":true}'::jsonb
    AND NOT (metadata @> '{"provenance":{"caller_asserted":{"author":"alice"}}}'::jsonb)
    AND NOT (metadata @> '{"provenance":{"caller_asserted":{"agent":"codex"}}}'::jsonb);

  SELECT count(*) INTO composed_count
  FROM thoughts
  WHERE metadata @> '{"_ci_search_filter_fixture":true}'::jsonb
    AND metadata @> '{"provenance":{"caller_asserted":{"repo":"target/repo"}}}'::jsonb
    AND NOT (metadata @> '{"provenance":{"caller_asserted":{"author":"alice"}}}'::jsonb);

  IF include_count <> 2 THEN
    RAISE EXCEPTION 'include-AND semantics returned %, expected 2', include_count;
  END IF;
  IF exclude_count <> 2 THEN
    RAISE EXCEPTION 'exclude-any/missing-claim semantics returned %, expected 2', exclude_count;
  END IF;
  IF composed_count <> 1 THEN
    RAISE EXCEPTION 'composed include/exclude semantics returned %, expected 1', composed_count;
  END IF;
END;
$$;

WITH constant_vector AS (
  SELECT (
    '[' || rtrim(repeat('0.1,', 768), ',') || ']'
  )::vector AS embedding
)
INSERT INTO thoughts (content, embedding, metadata)
SELECT
  'search-filter-plan-fixture-' || g,
  constant_vector.embedding,
  jsonb_build_object(
    '_ci_search_filter_fixture',
    true,
    'provenance',
    jsonb_build_object(
      'schema_version', 1,
      'caller_asserted',
      jsonb_build_object(
        'repo', CASE WHEN g <= 10 THEN 'target/repo' ELSE 'other/repo' END,
        'author', CASE WHEN g % 2 = 0 THEN 'author-a' ELSE 'author-b' END
      )
    )
  )
FROM generate_series(1, 20000) AS g
CROSS JOIN constant_vector;

-- Reproduce the HNSW post-filter underfill that iterative scans prevent.
-- The first 400 neighbors exactly match the query vector but are excluded;
-- the next 1,600 have cosine similarity ~0.707 and remain eligible. With the
-- default ef_search of 40, the initial candidate batch is therefore all
-- denied even though far more than LIMIT eligible rows exist behind it.
WITH vectors AS (
  SELECT
    (
      '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
    )::vector AS blocked_embedding,
    (
      '[' || '1,1,' || rtrim(repeat('0,', 766), ',') || ']'
    )::vector AS eligible_embedding
)
INSERT INTO thoughts (content, embedding, metadata)
SELECT
  'search-filter-hnsw-fixture-' || g,
  CASE
    WHEN g <= 400 THEN vectors.blocked_embedding
    ELSE vectors.eligible_embedding
  END,
  jsonb_build_object(
    '_ci_search_filter_fixture',
    true,
    'provenance',
    jsonb_build_object(
      'schema_version', 1,
      'caller_asserted',
      jsonb_build_object(
        'author', CASE WHEN g <= 400 THEN 'blocked' ELSE 'eligible' END
      )
    )
  )
FROM generate_series(1, 2000) AS g
CROSS JOIN vectors;

VACUUM ANALYZE thoughts;

-- Mirrors the live queries.ts shape: vector threshold + positive JSONB
-- containment + vector ordering + limit. The selective repo term should make
-- PostgreSQL choose the metadata GIN index before sorting the candidate set.
EXPLAIN
SELECT id, content, metadata, created_at,
       1 - (
         embedding <=> (
           '[' || rtrim(repeat('0.1,', 768), ',') || ']'
         )::vector
       ) AS similarity
FROM thoughts
WHERE 1 - (
        embedding <=> (
          '[' || rtrim(repeat('0.1,', 768), ',') || ']'
        )::vector
      ) >= 0.5
  AND metadata @> '{"provenance":{"caller_asserted":{"repo":"target/repo"}}}'::jsonb
ORDER BY embedding <=> (
  '[' || rtrim(repeat('0.1,', 768), ',') || ']'
)::vector
LIMIT 10;

-- Mirrors queries.ts's filtered-search transaction. SET LOCAL is deliberate:
-- a pooled connection must revert to pgvector defaults after COMMIT.
BEGIN;
SET LOCAL hnsw.ef_search = 40;
SET LOCAL hnsw.iterative_scan = strict_order;

DO $$
DECLARE
  result_count INTEGER;
BEGIN
  SELECT count(*) INTO result_count
  FROM (
    SELECT id
    FROM thoughts
    WHERE 1 - (
            embedding <=> (
              '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
            )::vector
          ) >= 0.5
      AND NOT (
        metadata @> '{"provenance":{"caller_asserted":{"author":"blocked"}}}'::jsonb
      )
    ORDER BY embedding <=> (
      '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
    )::vector
    LIMIT 10
  ) AS filtered_neighbors;

  IF result_count <> 10 THEN
    RAISE EXCEPTION
      'iterative HNSW exclude-only search returned %, expected 10',
      result_count;
  END IF;
END;
$$;

EXPLAIN
SELECT id, content, metadata, created_at,
       1 - (
         embedding <=> (
           '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
         )::vector
       ) AS similarity
FROM thoughts
WHERE 1 - (
        embedding <=> (
          '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
        )::vector
      ) >= 0.5
  AND NOT (
    metadata @> '{"provenance":{"caller_asserted":{"author":"blocked"}}}'::jsonb
  )
ORDER BY embedding <=> (
  '[' || '1,' || rtrim(repeat('0,', 767), ',') || ']'
)::vector
LIMIT 10;

COMMIT;

DELETE FROM thoughts
WHERE metadata @> '{"_ci_search_filter_fixture":true}'::jsonb;
