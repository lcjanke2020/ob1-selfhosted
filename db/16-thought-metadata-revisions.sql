-- Open Brain thought revisions: a third change kind for metadata-only
-- reclassification.
--
-- `public.thought_revisions` (10-thought-mutations.sql) records the state that
-- existed before each content update or audience move. The maintenance-only
-- operator tool server/metadata_reclassify.ts re-runs the configured primary
-- classifier over thoughts whose metadata predates the classifier stamp (or is
-- the uncategorized stub) and rewrites only their classifier metadata. Each
-- such rewrite snapshots the prior state exactly like the other two mutations,
-- under the new change kind 'metadata'. This migration only widens the
-- change_kind CHECK to admit it; the table's columns, RLS policy, and grants
-- are unchanged, and no rows are rewritten.
--
-- Operator tools have no request identity. Their revision rows record
-- changed_by_door = 'maintenance' with NULL subject and token label: the
-- change was made by a database superuser running a maintenance tool, not by
-- an authenticated MCP/REST caller.
--
-- The server itself never writes 'metadata' revisions and does not require
-- this migration to start; metadata_reclassify.ts refuses to run without it.
-- Apply after 10-thought-mutations.sql (and the rest of the numbered
-- migrations), then run the stable 03-grants-assertion.sql source last; the
-- assertion pins the exact set of change kinds and rejects any other CHECK on
-- change_kind, which this migration leaves for the operator to drop. Requires
-- the table owner or a PostgreSQL superuser (normally `postgres`). Idempotent.
-- Re-adding the CHECK validates the existing history under a brief ACCESS
-- EXCLUSIVE lock on thought_revisions; thoughts themselves are not locked.

BEGIN;

ALTER TABLE public.thought_revisions
  DROP CONSTRAINT IF EXISTS thought_revisions_change_kind,
  ADD CONSTRAINT thought_revisions_change_kind CHECK (
    change_kind IN ('content', 'scope', 'metadata')
  );

COMMENT ON TABLE public.thought_revisions IS
  'Append-only prior-state history for thought content updates, audience moves, and maintenance metadata reclassification (changed_by_door = maintenance); readable only when the head thought is readable.';

COMMIT;
