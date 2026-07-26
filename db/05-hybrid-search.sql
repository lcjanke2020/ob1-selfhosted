-- Open Brain hybrid-search migration.
--
-- The semantic leg remains pgvector. This migration adds the lexical leg:
-- a stored `simple` tsvector for token-preserving full-text search and a
-- trigram index for the escaped literal-substring fallback. `simple` is
-- deliberate: stemming belongs to the semantic leg, while this leg must keep
-- identifiers such as OPS-275 and search_thoughts recognizable.
--
-- Idempotent for both fresh init and an existing database. Adding the stored
-- generated column takes an ACCESS EXCLUSIVE lock that is held through both
-- regular GIN index builds until this transaction commits, blocking reads and
-- writes for the migration's duration. Apply during a full application
-- maintenance window on a large corpus and budget disk for the stored tsvector
-- plus both indexes.
-- The lexical shape follows upstream Open Brain's enhanced-thoughts and
-- text-search-trgm schema contributions (FSL-1.1-MIT); RRF itself lives in
-- server/queries.ts.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS content_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_tsv
  ON thoughts USING gin (content_tsv);

CREATE INDEX IF NOT EXISTS idx_thoughts_content_trgm
  ON thoughts USING gin (content gin_trgm_ops);

COMMENT ON COLUMN thoughts.content_tsv IS
  'Token-preserving simple-config tsvector used by hybrid thought search.';

COMMENT ON INDEX idx_thoughts_content_tsv IS
  'GIN index for the full-text candidate leg of hybrid thought search.';

COMMENT ON INDEX idx_thoughts_content_trgm IS
  'GIN trigram index for escaped ILIKE literal fallback in hybrid thought search.';

COMMIT;

-- Refresh planner statistics after a live backfill/index build. ANALYZE is
-- harmless on a fresh empty database and intentionally runs after COMMIT.
ANALYZE thoughts;
