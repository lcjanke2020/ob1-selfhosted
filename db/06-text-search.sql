-- ============================================================================
-- pg_trgm trigram index — lexical fallback for list_thoughts(content_contains).
--
-- Ported from upstream OB1's text-search-trgm schema (PR #206); header
-- adapted because the consumer differs: here it is the `content_contains`
-- filter on the list_thoughts tool (server/queries.ts listThoughts), which
-- compiles to `content ILIKE '%...%'`. Semantic search misses exact rare
-- tokens (IDs, names, code fragments); ILIKE finds them, but a
-- leading-wildcard ILIKE can't use a btree index and would seq-scan the
-- whole thoughts table. pg_trgm gives GIN a trigram operator class that
-- ILIKE patterns can use — upstream measured rare-word queries dropping from
-- ~8s to ~100-150ms on an 89K-row brain. The planner picks the index up
-- automatically; no query changes needed.
--
-- Trade-offs (upstream's notes apply unchanged):
--   - Storage: ~20-40MB per 90K thoughts; scales with content size.
--   - Build lock: a regular (non-CONCURRENT) CREATE INDEX briefly locks
--     thoughts against writes during the build (~1-2 min at 90K rows).
--     If you run live capture and can't pause, build it manually with
--     CREATE INDEX CONCURRENTLY first — the IF NOT EXISTS below then skips it.
--   - Write-amp: small INSERT/UPDATE overhead on content changes;
--     imperceptible at personal-brain write rates.
--
-- pg_trgm ships with postgres contrib and is present in the
-- pgvector/pgvector:pg16 image. Idempotent; safe to re-run. Existing
-- deployments: apply with scripts/upgrade-search-schema.sh (init scripts
-- only run on a fresh data directory).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_trgm
  ON thoughts
  USING gin (content gin_trgm_ops);

COMMENT ON INDEX idx_thoughts_content_trgm IS
  'Trigram GIN index on content for ILIKE ''%foo%'' patterns — accelerates the list_thoughts content_contains lexical fallback.';

COMMIT;
