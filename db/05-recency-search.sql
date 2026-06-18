-- ============================================================================
-- match_thoughts_recency — recency-boosted variant of match_thoughts.
--
-- Ported from upstream OB1's recency-boosted-match-thoughts schema (PR #231),
-- adapted to this deployment: vector(768) (nomic-embed-text), 0.5 default
-- threshold (matching match_thoughts above in 01-schema.sql), and no
-- Supabase `extensions` search_path.
--
-- Pure cosine ranking lets very old thoughts that happen to be vector-nearest
-- outrank newer, equally relevant ones. This function blends similarity with
-- an exponential recency decay:
--
--   recency_factor = exp(-age_days / half_life_days)
--   final_score    = similarity * (1 - recency_weight)
--                  + recency_factor * recency_weight
--
-- Defaults are backward-compatible: recency_weight = 0 reproduces
-- match_thoughts' ranking exactly. The threshold always gates on RAW cosine
-- similarity so a high recency weight can't surface irrelevant-but-new rows.
--
-- The ORIGINAL match_thoughts (01-schema.sql) is deliberately untouched —
-- it is the upstream-compatible surface, and CREATE OR REPLACE with extra
-- defaulted parameters would create a second overload rather than replace it.
--
-- NOTE the server does NOT call this function: server/queries.ts runs the
-- same formula inline (searchThoughts, recencyWeight > 0). This file is the
-- canonical formula reference and the SQL-side surface for psql / dashboard
-- consumers. queries_recency_test.ts asserts the two stay in sync — change
-- the formula in BOTH places or that test fails.
--
-- Idempotent (CREATE OR REPLACE); safe to run on a live database. Existing
-- deployments: apply with scripts/upgrade-search-schema.sh (init scripts
-- only run on a fresh data directory).
-- ============================================================================

CREATE OR REPLACE FUNCTION match_thoughts_recency(
  query_embedding VECTOR(768),
  match_threshold FLOAT DEFAULT 0.5,
  match_count     INT   DEFAULT 10,
  filter          JSONB DEFAULT '{}'::jsonb,
  recency_weight  FLOAT DEFAULT 0.0,  -- 0 = disabled (same as match_thoughts)
  half_life_days  FLOAT DEFAULT 90.0  -- only consulted when recency_weight > 0
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
BEGIN
  -- Clamp inputs to sensible ranges (mirrors clampRecency in
  -- server/queries.ts): an over-eager caller passing recency_weight = 5.0
  -- should not blow up the ranking.
  IF recency_weight < 0.0 THEN recency_weight := 0.0; END IF;
  IF recency_weight > 1.0 THEN recency_weight := 1.0; END IF;
  IF half_life_days <= 0.0 THEN half_life_days := 90.0; END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    ((1 - (t.embedding <=> query_embedding)) * (1.0 - recency_weight) + exp(-GREATEST(extract(epoch FROM (now() - t.created_at)) / 86400.0, 0.0) / half_life_days) * recency_weight)::float AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  -- plpgsql can't reference the output alias here (it collides with the
  -- RETURNS TABLE column), so the blended expression is repeated verbatim.
  ORDER BY ((1 - (t.embedding <=> query_embedding)) * (1.0 - recency_weight) + exp(-GREATEST(extract(epoch FROM (now() - t.created_at)) / 86400.0, 0.0) / half_life_days) * recency_weight)::float DESC
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_thoughts_recency(VECTOR(768), FLOAT, INT, JSONB, FLOAT, FLOAT) IS
  'Recency-boosted nearest-neighbor search. Blended score = similarity * (1 - recency_weight) + exp(-age_days/half_life_days) * recency_weight. recency_weight defaults to 0 (pure similarity, identical to match_thoughts). half_life_days defaults to 90. Threshold applies to raw cosine similarity before the blend. Same columns as match_thoughts.';
