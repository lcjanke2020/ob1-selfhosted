-- CI-only semantics and planner smoke for thought-provenance filtering.
-- This file is NOT mounted into docker-entrypoint-initdb.d. The DB-init
-- workflow runs it explicitly after the operational init/grant checks, then
-- asserts that the positive predicate names idx_thoughts_metadata and the
-- filtered iterative path names idx_thoughts_embedding_hnsw.
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

-- Mirrors queries.ts's filtered-search transaction. Approximate-index recall
-- is deliberately not asserted: HNSW graph construction and traversal are not
-- deterministic guarantees. This smoke instead verifies the guarantees the
-- application owns: transaction-local configuration, filter correctness, and
-- the HNSW plan shape. The exact boolean semantics are asserted above.
SELECT current_setting('hnsw.iterative_scan') AS hnsw_before \gset

BEGIN;
SET LOCAL hnsw.iterative_scan = strict_order;

DO $$
DECLARE
  returned_metadata JSONB;
BEGIN
  IF current_setting('hnsw.iterative_scan') <> 'strict_order' THEN
    RAISE EXCEPTION 'filtered search did not enable strict HNSW iteration';
  END IF;

  FOR returned_metadata IN
    SELECT metadata
    FROM thoughts
    WHERE 1 - (
            embedding <=> (
              '[' || rtrim(repeat('0.1,', 768), ',') || ']'
            )::vector
          ) >= 0.5
      AND NOT (
        metadata @> '{"provenance":{"caller_asserted":{"author":"author-a"}}}'::jsonb
      )
    ORDER BY embedding <=> (
      '[' || rtrim(repeat('0.1,', 768), ',') || ']'
    )::vector
    LIMIT 10
  LOOP
    IF returned_metadata @>
      '{"provenance":{"caller_asserted":{"author":"author-a"}}}'::jsonb
    THEN
      RAISE EXCEPTION 'filtered HNSW search returned an excluded row';
    END IF;
  END LOOP;
END;
$$;

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
  AND NOT (
    metadata @> '{"provenance":{"caller_asserted":{"author":"author-a"}}}'::jsonb
  )
ORDER BY embedding <=> (
  '[' || rtrim(repeat('0.1,', 768), ',') || ']'
)::vector
LIMIT 10;

COMMIT;

SELECT current_setting('hnsw.iterative_scan') = :'hnsw_before'
  AS hnsw_restored \gset
\if :hnsw_restored
\else
  \echo 'hnsw.iterative_scan did not restore after COMMIT'
  \quit 1
\endif

DELETE FROM thoughts
WHERE metadata @> '{"_ci_search_filter_fixture":true}'::jsonb;
