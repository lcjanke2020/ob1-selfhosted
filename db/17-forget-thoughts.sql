-- Open Brain forget/restore: recoverable soft delete for thoughts.
--
-- Until this migration a captured thought could be corrected
-- (update_thought) or re-scoped (move_thought) but never retired: test
-- captures and superseded notes stayed in recall. This migration lets the
-- application FORGET a thought — remove it from every application read path
-- while keeping the row, its history, and its embedding index for audit and
-- for RESTORE. Forgetting is not erasure: the text stays in the database,
-- in revision history, and in every backup taken while it exists.
--
--   1. `public.thoughts.forgotten_at` — NULL for a live thought; the time it
--      was forgotten otherwise. Only the two SECURITY DEFINER functions below
--      set or clear it: openbrain_app has no UPDATE on the column.
--
--   2. `thoughts_app_not_forgotten` — a RESTRICTIVE policy for openbrain_app,
--      ANDed with the permissive `thoughts_app_audience` (db/06-spaces.sql).
--      A forgotten row is invisible to every app-role statement — list,
--      fetch, stats, update, the RLS join behind search, the
--      embedding-index and revision-history policies (both gate on a visible
--      head), and any read path added later — and the app can neither insert
--      nor produce one. It is a separate policy, not an edit of the audience
--      policy, so re-applying db/06-spaces.sql cannot drop it.
--
--   3. `idx_thoughts_fingerprint` excludes forgotten rows. Re-capturing the
--      text of a forgotten thought creates a fresh live row instead of
--      colliding with a row the app can no longer see (INSERT ... ON CONFLICT
--      DO UPDATE raises on an existing row that fails the UPDATE policy; it
--      never skips it). Restoring a thought whose text has since been
--      captured again in the same audience is therefore a `conflict`.
--
--   4. `memory_scope.forget_thought(...)` / `memory_scope.restore_thought(...)`
--      — narrowly granted SECURITY DEFINER functions, the same construction
--      as memory_scope.move_thought (db/10-thought-mutations.sql). The caller
--      must see the row under the installed audience (forgotten or not);
--      otherwise it is indistinguishable from an unknown id. Each change
--      appends a `thought_revisions` row (change kinds `forget` / `restore`)
--      with the verified actor. History stays head-gated: while a thought is
--      forgotten its revisions are hidden too, and they reappear on restore.
--
--   5. The three existing SECURITY DEFINER functions that read
--      public.thoughts with RLS bypassed are redefined with an explicit
--      `forgotten_at IS NULL` filter: both memory_scope.search_thought_candidates
--      overloads (db/06-spaces.sql, db/15-embedding-index.sql) — otherwise
--      forgotten rows would occupy candidate slots that the outer RLS join
--      then discards, starving recall — and memory_scope.move_thought, whose
--      source lock must not act on a forgotten row and whose dedupe probes
--      must not count one as a collision. Each body is otherwise identical to
--      its source migration.
--
-- memory_scope.embedding_ready (db/15) deliberately still covers forgotten
-- rows: the offline backfill keeps them indexed, so a restore needs no
-- re-embedding.
--
-- Ordering: apply after every earlier numbered migration, then run the stable
-- 03-grants-assertion.sql source last. The documented upgrades replay older
-- migrations in numeric order, so this file always follows them. Replaying
-- db/06 or db/16 leaves this migration's fingerprint index and change-kind
-- CHECK unchanged: once history holds forget/restore revisions or a
-- forgotten thought's text was captured again, their older shapes no longer
-- fit the data. Replaying db/06, db/10, or db/15 does restore an unfiltered
-- search or move helper; re-apply this migration after them. The grants
-- assertion pins every object below, and the server's boot probe refuses a
-- catalog where any of them is missing or regressed.
--
-- Rollout: the server's capture upsert names the new index predicate, so a
-- server older than 1.31.0 cannot capture once this migration is applied —
-- stop the server, apply, then start 1.31.0 (which refuses to boot without
-- it). Requires a PostgreSQL superuser (normally `postgres`) because it
-- creates SECURITY DEFINER functions owned by the table owner. Idempotent.
-- The index rebuild and policy swap take brief ACCESS EXCLUSIVE locks on
-- public.thoughts; no thought rows are rewritten.

BEGIN;

-- ---------- Forgotten marker -----------------------------------------------
--
-- No column grant: openbrain_app keeps exactly the content-column UPDATE
-- grant of db/10-thought-mutations.sql. Its table-wide INSERT does cover the
-- new column, so the restrictive policy's WITH CHECK is what refuses an
-- app-role INSERT of a forgotten row. openbrain_readonly's table-wide SELECT
-- covers it, so backups carry forgotten rows and their marker.

ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS forgotten_at TIMESTAMPTZ;

COMMENT ON COLUMN public.thoughts.forgotten_at IS
  'NULL for a live thought; when it was forgotten otherwise. Set and cleared only by memory_scope.forget_thought/restore_thought; forgotten rows are invisible to openbrain_app.';

-- ---------- Deduplication covers live rows only ----------------------------

DROP INDEX IF EXISTS public.idx_thoughts_fingerprint;
CREATE UNIQUE INDEX idx_thoughts_fingerprint
  ON public.thoughts (
    workspace_id,
    project_id,
    visibility,
    owner_subject,
    content_fingerprint
  ) NULLS NOT DISTINCT
  WHERE content_fingerprint IS NOT NULL AND forgotten_at IS NULL;

-- ---------- Forgotten rows are invisible to the application -----------------

DROP POLICY IF EXISTS thoughts_app_not_forgotten ON public.thoughts;
CREATE POLICY thoughts_app_not_forgotten ON public.thoughts
  AS RESTRICTIVE
  FOR ALL TO openbrain_app
  USING (forgotten_at IS NULL)
  WITH CHECK (forgotten_at IS NULL);

-- ---------- History records forget and restore -----------------------------

ALTER TABLE public.thought_revisions
  DROP CONSTRAINT IF EXISTS thought_revisions_change_kind,
  ADD CONSTRAINT thought_revisions_change_kind CHECK (
    change_kind IN ('content', 'scope', 'metadata', 'forget', 'restore')
  );

COMMENT ON TABLE public.thought_revisions IS
  'Append-only prior-state history for thought content updates, audience moves, forget/restore, and maintenance metadata reclassification (changed_by_door = maintenance); readable only when the head thought is readable.';

-- ---------- Forget ----------------------------------------------------------

-- Marks one thought forgotten. Runs with the table owner's rights because the
-- restrictive policy hides the row from the app the moment the marker is set,
-- and openbrain_app may not write the column at all.
--
-- Returns no row when the thought is not visible under the caller's
-- transaction-local audience (indistinguishable from an unknown id);
-- otherwise one row whose `outcome` is 'forgotten', or 'unchanged' when it was
-- already forgotten (no revision written; `forgotten_at` is the original
-- time). Content, embedding, audience, and created_at are untouched; the
-- thoughts_updated_at trigger advances updated_at. `revision` is the number of
-- history rows on record after the call.
--
-- Argument order and types are part of the grants assertion and boot probe:
-- memory_scope.forget_thought(uuid,text,text).
CREATE OR REPLACE FUNCTION memory_scope.forget_thought(
  target_thought_id UUID,
  actor_door TEXT,
  actor_token_label TEXT
)
RETURNS TABLE (
  outcome TEXT,
  revision INTEGER,
  forgotten_at TIMESTAMPTZ,
  workspace_id TEXT,
  project_id TEXT,
  visibility memory_scope.visibility
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  head public.thoughts%ROWTYPE;
  principal TEXT := NULLIF(
    pg_catalog.current_setting('openbrain.principal', true), ''
  );
  next_revision INTEGER;
  stamped TIMESTAMPTZ;
BEGIN
  IF target_thought_id IS NULL OR actor_door IS NULL THEN
    RAISE EXCEPTION 'forget_thought: thought id and door are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Lock only a row the caller can read by audience; an invisible row is
  -- neither locked nor acknowledged. A forgotten row is found here so that a
  -- repeated forget is an idempotent no-op rather than "not found".
  SELECT t.* INTO head
  FROM public.thoughts AS t
  WHERE t.id = target_thought_id
    AND memory_scope.audience_matches(
      t.workspace_id, t.project_id, t.visibility, t.owner_subject
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF head.forgotten_at IS NOT NULL THEN
    RETURN QUERY
      SELECT 'unchanged'::text,
             (
               SELECT count(*)::integer
               FROM public.thought_revisions AS r
               WHERE r.thought_id = head.id
             ),
             head.forgotten_at,
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END IF;

  SELECT COALESCE(max(r.revision), 0) + 1 INTO next_revision
  FROM public.thought_revisions AS r
  WHERE r.thought_id = head.id;

  INSERT INTO public.thought_revisions (
    thought_id, revision, change_kind,
    prior_content, prior_metadata,
    prior_workspace_id, prior_project_id, prior_visibility,
    prior_owner_subject,
    changed_by_subject, changed_by_door, changed_by_token_label
  ) VALUES (
    head.id, next_revision, 'forget',
    head.content, head.metadata,
    head.workspace_id, head.project_id, head.visibility, head.owner_subject,
    principal, actor_door, actor_token_label
  );

  -- Leaving the fingerprint index cannot violate it, so no conflict handling
  -- is needed on this side.
  UPDATE public.thoughts AS t
  SET forgotten_at = pg_catalog.now()
  WHERE t.id = head.id
  RETURNING t.forgotten_at INTO stamped;

  RETURN QUERY
    SELECT 'forgotten'::text,
           next_revision,
           stamped,
           head.workspace_id,
           head.project_id,
           head.visibility;
END;
$$;

-- Revoking from openbrain_app too drops any grant option it picked up (and,
-- by CASCADE, anything it re-delegated) before the plain re-grant.
REVOKE ALL ON FUNCTION memory_scope.forget_thought(UUID, TEXT, TEXT)
  FROM PUBLIC, openbrain_app CASCADE;
GRANT EXECUTE ON FUNCTION memory_scope.forget_thought(UUID, TEXT, TEXT)
  TO openbrain_app;

-- ---------- Restore ---------------------------------------------------------

-- Returns one forgotten thought to recall, in the audience it was forgotten
-- from. Same visibility rule as forget: the caller must see the row by
-- audience, otherwise no row is returned. The outcome is 'restored',
-- 'unchanged' (it was not forgotten; no revision written), or 'conflict' when
-- a live thought with the same content now exists in that audience
-- (`conflict_thought_id` names it; by construction the caller can read it).
-- A legacy NULL fingerprint is compared by the value derived from the content
-- — on both sides, exactly like move_thought — and healed by the restore. A
-- collision that commits between the pre-check and the write surfaces as a
-- unique violation on idx_thoughts_fingerprint and is reported as the same
-- `conflict` outcome. `revision` is the number of history rows on record
-- after the call (NULL on conflict).
--
-- Argument order and types are part of the grants assertion and boot probe:
-- memory_scope.restore_thought(uuid,text,text).
CREATE OR REPLACE FUNCTION memory_scope.restore_thought(
  target_thought_id UUID,
  actor_door TEXT,
  actor_token_label TEXT
)
RETURNS TABLE (
  outcome TEXT,
  conflict_thought_id UUID,
  revision INTEGER,
  workspace_id TEXT,
  project_id TEXT,
  visibility memory_scope.visibility
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  head public.thoughts%ROWTYPE;
  principal TEXT := NULLIF(
    pg_catalog.current_setting('openbrain.principal', true), ''
  );
  next_revision INTEGER;
  existing_id UUID;
  effective_fingerprint TEXT;
BEGIN
  IF target_thought_id IS NULL OR actor_door IS NULL THEN
    RAISE EXCEPTION 'restore_thought: thought id and door are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT t.* INTO head
  FROM public.thoughts AS t
  WHERE t.id = target_thought_id
    AND memory_scope.audience_matches(
      t.workspace_id, t.project_id, t.visibility, t.owner_subject
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF head.forgotten_at IS NULL THEN
    RETURN QUERY
      SELECT 'unchanged'::text,
             NULL::uuid,
             (
               SELECT count(*)::integer
               FROM public.thought_revisions AS r
               WHERE r.thought_id = head.id
             ),
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END IF;

  effective_fingerprint := COALESCE(
    head.content_fingerprint,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.lower(pg_catalog.btrim(
            pg_catalog.regexp_replace(head.content, '\s+', ' ', 'g')
          )),
          'UTF8'
        )
      ),
      'hex'
    )
  );

  SELECT t.id INTO existing_id
  FROM public.thoughts AS t
  WHERE t.workspace_id = head.workspace_id
    AND t.project_id IS NOT DISTINCT FROM head.project_id
    AND t.visibility = head.visibility
    AND t.owner_subject IS NOT DISTINCT FROM head.owner_subject
    AND t.id <> head.id
    AND t.forgotten_at IS NULL
    AND (
      t.content_fingerprint = effective_fingerprint
      OR (
        t.content_fingerprint IS NULL
        AND pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              pg_catalog.lower(pg_catalog.btrim(
                pg_catalog.regexp_replace(t.content, '\s+', ' ', 'g')
              )),
              'UTF8'
            )
          ),
          'hex'
        ) = effective_fingerprint
      )
    )
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY
      SELECT 'conflict'::text,
             existing_id,
             NULL::integer,
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END IF;

  SELECT COALESCE(max(r.revision), 0) + 1 INTO next_revision
  FROM public.thought_revisions AS r
  WHERE r.thought_id = head.id;

  -- History first, then the head, inside one subtransaction, as in
  -- move_thought: re-entering the fingerprint index can collide with a
  -- capture that committed after the pre-check.
  BEGIN
    INSERT INTO public.thought_revisions (
      thought_id, revision, change_kind,
      prior_content, prior_metadata,
      prior_workspace_id, prior_project_id, prior_visibility,
      prior_owner_subject,
      changed_by_subject, changed_by_door, changed_by_token_label
    ) VALUES (
      head.id, next_revision, 'restore',
      head.content, head.metadata,
      head.workspace_id, head.project_id, head.visibility, head.owner_subject,
      principal, actor_door, actor_token_label
    );

    UPDATE public.thoughts AS t
    SET forgotten_at = NULL,
        content_fingerprint = effective_fingerprint
    WHERE t.id = head.id;
  EXCEPTION WHEN unique_violation THEN
    SELECT t.id INTO existing_id
    FROM public.thoughts AS t
    WHERE t.workspace_id = head.workspace_id
      AND t.project_id IS NOT DISTINCT FROM head.project_id
      AND t.visibility = head.visibility
      AND t.owner_subject IS NOT DISTINCT FROM head.owner_subject
      AND t.id <> head.id
      AND t.forgotten_at IS NULL
      AND (
        t.content_fingerprint = effective_fingerprint
        OR (
          t.content_fingerprint IS NULL
          AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.lower(pg_catalog.btrim(
                  pg_catalog.regexp_replace(t.content, '\s+', ' ', 'g')
                )),
                'UTF8'
              )
            ),
            'hex'
          ) = effective_fingerprint
        )
      )
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    RETURN QUERY
      SELECT 'conflict'::text,
             existing_id,
             NULL::integer,
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END;

  RETURN QUERY
    SELECT 'restored'::text,
           NULL::uuid,
           next_revision,
           head.workspace_id,
           head.project_id,
           head.visibility;
END;
$$;

-- Revoking from openbrain_app too drops any grant option it picked up (and,
-- by CASCADE, anything it re-delegated) before the plain re-grant.
REVOKE ALL ON FUNCTION memory_scope.restore_thought(UUID, TEXT, TEXT)
  FROM PUBLIC, openbrain_app CASCADE;
GRANT EXECUTE ON FUNCTION memory_scope.restore_thought(UUID, TEXT, TEXT)
  TO openbrain_app;

-- ---------- Definer read paths skip forgotten rows --------------------------
--
-- The three bodies below are generated from their source migrations with only
-- the forgotten_at filters added; compare with db/06-spaces.sql,
-- db/15-embedding-index.sql, and db/10-thought-mutations.sql. The grants
-- assertion requires the filters in each.

-- Legacy (pre-contract) candidate search, db/06-spaces.sql.
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
      WHERE t.forgotten_at IS NULL
        AND memory_scope.audience_matches(
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
      WHERE t.forgotten_at IS NULL
        AND memory_scope.audience_matches(
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

-- Contract (passage-index) candidate search, db/15-embedding-index.sql.
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
    -- Let the application preserve its upstream diagnostic without another
    -- full-corpus scan or a match against the human-readable error text.
    RAISE EXCEPTION USING ERRCODE = 'OB001',
      MESSAGE = 'embedding index not ready for runtime/model contract';
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
      WHERE i.contract = $9 AND t.forgotten_at IS NULL
        AND memory_scope.audience_matches(
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
      WHERE t.forgotten_at IS NULL
        AND memory_scope.audience_matches(
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

-- Audience move, db/10-thought-mutations.sql: a forgotten thought cannot be
-- moved (it reads as not found), and a forgotten row never blocks a move as a
-- fingerprint collision.
CREATE OR REPLACE FUNCTION memory_scope.move_thought(
  target_thought_id UUID,
  new_workspace_id TEXT,
  new_project_id TEXT,
  new_visibility memory_scope.visibility,
  actor_door TEXT,
  actor_token_label TEXT
)
RETURNS TABLE (
  outcome TEXT,
  conflict_thought_id UUID,
  revision INTEGER,
  workspace_id TEXT,
  project_id TEXT,
  visibility memory_scope.visibility
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  head public.thoughts%ROWTYPE;
  target_workspace memory_scope.workspace%ROWTYPE;
  principal TEXT := NULLIF(
    pg_catalog.current_setting('openbrain.principal', true), ''
  );
  new_owner_subject TEXT;
  next_revision INTEGER;
  existing_id UUID;
  -- The fingerprint the dedupe decision and the moved row use. Legacy rows
  -- may carry NULL; derive it with the capture expression so such a row cannot
  -- slip past the partial unique index (WHERE content_fingerprint IS NOT NULL)
  -- and is healed by the move.
  effective_fingerprint TEXT;
BEGIN
  IF target_thought_id IS NULL OR new_workspace_id IS NULL
     OR new_visibility IS NULL OR actor_door IS NULL THEN
    RAISE EXCEPTION 'move_thought: thought id, workspace, visibility, and door are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Lock only a row the caller can already read; an invisible or forgotten
  -- row is neither locked nor acknowledged.
  SELECT t.* INTO head
  FROM public.thoughts AS t
  WHERE t.id = target_thought_id
    AND t.forgotten_at IS NULL
    AND memory_scope.audience_matches(
      t.workspace_id, t.project_id, t.visibility, t.owner_subject
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT w.* INTO target_workspace
  FROM memory_scope.workspace AS w
  WHERE w.id = new_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'move_thought: unknown workspace_id "%"', new_workspace_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF target_workspace.personal_only AND new_visibility <> 'personal' THEN
    RAISE EXCEPTION
      'move_thought: workspace_id "%" is personal-only; visibility must be personal',
      new_workspace_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF new_visibility = 'personal' THEN
    IF principal IS NULL THEN
      RAISE EXCEPTION
        'move_thought: personal visibility requires a transaction-local principal'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF new_project_id IS NOT NULL THEN
      RAISE EXCEPTION 'move_thought: personal visibility stores no project_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    new_owner_subject := principal;
  ELSIF new_visibility = 'project' THEN
    IF new_project_id IS NULL THEN
      RAISE EXCEPTION 'move_thought: project visibility requires project_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM memory_scope.project AS p
      WHERE p.workspace_id = new_workspace_id AND p.id = new_project_id
    ) THEN
      RAISE EXCEPTION
        'move_thought: unknown project_id "%" in workspace_id "%"',
        new_project_id, new_workspace_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    new_owner_subject := NULL;
  ELSE
    IF new_project_id IS NOT NULL THEN
      RAISE EXCEPTION 'move_thought: workspace visibility stores no project_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    new_owner_subject := NULL;
  END IF;

  IF head.workspace_id = new_workspace_id
     AND head.project_id IS NOT DISTINCT FROM new_project_id
     AND head.visibility = new_visibility
     AND head.owner_subject IS NOT DISTINCT FROM new_owner_subject THEN
    RETURN QUERY
      SELECT 'unchanged'::text,
             NULL::uuid,
             (
               SELECT count(*)::integer
               FROM public.thought_revisions AS r
               WHERE r.thought_id = head.id
             ),
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END IF;

  effective_fingerprint := COALESCE(
    head.content_fingerprint,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.lower(pg_catalog.btrim(
            pg_catalog.regexp_replace(head.content, '\s+', ' ', 'g')
          )),
          'UTF8'
        )
      ),
      'hex'
    )
  );

  -- The audience-aware fingerprint index would reject the move; report the
  -- collision as an outcome instead of aborting the transaction. Both rows
  -- are readable by the caller: the head by the visibility check above, the
  -- other because it lives in the audience the caller is moving into. A
  -- resident legacy row with no stored fingerprint is compared on the value
  -- derived from its content — the partial index never sees such a row, so
  -- this probe is the only thing standing between it and a duplicate.
  SELECT t.id INTO existing_id
  FROM public.thoughts AS t
  WHERE t.workspace_id = new_workspace_id
    AND t.project_id IS NOT DISTINCT FROM new_project_id
    AND t.visibility = new_visibility
    AND t.owner_subject IS NOT DISTINCT FROM new_owner_subject
    AND t.id <> head.id
    AND t.forgotten_at IS NULL
    AND (
      t.content_fingerprint = effective_fingerprint
      OR (
        t.content_fingerprint IS NULL
        AND pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              pg_catalog.lower(pg_catalog.btrim(
                pg_catalog.regexp_replace(t.content, '\s+', ' ', 'g')
              )),
              'UTF8'
            )
          ),
          'hex'
        ) = effective_fingerprint
      )
    )
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY
      SELECT 'conflict'::text,
             existing_id,
             NULL::integer,
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END IF;

  SELECT COALESCE(max(r.revision), 0) + 1 INTO next_revision
  FROM public.thought_revisions AS r
  WHERE r.thought_id = head.id;

  -- History first, then the head, inside one subtransaction: a collision that
  -- committed between the pre-check above and this write surfaces here as a
  -- unique violation on idx_thoughts_fingerprint (the write waits for the
  -- in-flight competitor, then fails). Roll both statements back and report
  -- the now-visible collision as the same `conflict` outcome the pre-check
  -- would have produced. Anything else propagates unchanged.
  BEGIN
    INSERT INTO public.thought_revisions (
      thought_id, revision, change_kind,
      prior_content, prior_metadata,
      prior_workspace_id, prior_project_id, prior_visibility,
      prior_owner_subject,
      changed_by_subject, changed_by_door, changed_by_token_label
    ) VALUES (
      head.id, next_revision, 'scope',
      head.content, head.metadata,
      head.workspace_id, head.project_id, head.visibility, head.owner_subject,
      principal, actor_door, actor_token_label
    );

    -- Content, embedding, and created_at are untouched; a legacy NULL
    -- fingerprint is healed to the canonical value the dedupe decision used;
    -- the thoughts_updated_at trigger advances updated_at.
    UPDATE public.thoughts AS t
    SET workspace_id = new_workspace_id,
        project_id = new_project_id,
        visibility = new_visibility,
        owner_subject = new_owner_subject,
        content_fingerprint = effective_fingerprint
    WHERE t.id = head.id;
  EXCEPTION WHEN unique_violation THEN
    -- Only a stored fingerprint can have raised the index; the derived
    -- comparison is kept for symmetry with the pre-check so the two probes
    -- cannot drift.
    SELECT t.id INTO existing_id
    FROM public.thoughts AS t
    WHERE t.workspace_id = new_workspace_id
      AND t.project_id IS NOT DISTINCT FROM new_project_id
      AND t.visibility = new_visibility
      AND t.owner_subject IS NOT DISTINCT FROM new_owner_subject
      AND t.id <> head.id
      AND t.forgotten_at IS NULL
      AND (
        t.content_fingerprint = effective_fingerprint
        OR (
          t.content_fingerprint IS NULL
          AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.lower(pg_catalog.btrim(
                  pg_catalog.regexp_replace(t.content, '\s+', ' ', 'g')
                )),
                'UTF8'
              )
            ),
            'hex'
          ) = effective_fingerprint
        )
      )
    LIMIT 1;
    IF NOT FOUND THEN
      -- Not the fingerprint index (or the competitor vanished again): this
      -- is not a dedupe conflict we can name, so surface the real error.
      RAISE;
    END IF;
    RETURN QUERY
      SELECT 'conflict'::text,
             existing_id,
             NULL::integer,
             head.workspace_id,
             head.project_id,
             head.visibility;
    RETURN;
  END;

  RETURN QUERY
    SELECT 'moved'::text,
           NULL::uuid,
           next_revision,
           new_workspace_id,
           new_project_id,
           new_visibility;
END;
$$;

REVOKE ALL ON FUNCTION memory_scope.move_thought(
  UUID, TEXT, TEXT, memory_scope.visibility, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_scope.move_thought(
  UUID, TEXT, TEXT, memory_scope.visibility, TEXT, TEXT
) TO openbrain_app;

COMMIT;

ANALYZE public.thoughts;
ANALYZE public.thought_revisions;
