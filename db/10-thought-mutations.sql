-- Open Brain thought mutations: in-place content updates and audience moves.
--
-- Until this migration, thoughts were write-once through the application. A
-- factually wrong thought or one captured into the wrong audience could only
-- be worked around by capturing a second thought beside it. This migration
-- adds the two pieces the application needs to correct and re-scope existing
-- rows without widening any boundary:
--
--   1. `public.thought_revisions` — an append-only, per-thought history of the
--      state that existed BEFORE each change (content, metadata, audience) plus
--      the verified identity that made the change. The head row in
--      `public.thoughts` keeps its id, so citations, `fetch`, and the
--      metadata-degradation foreign key stay valid; recall keeps reading heads
--      only and needs no superseded filter. Revision rows are readable exactly
--      when their head is readable under the caller's audience: once a
--      misfiled thought has been moved to a narrower audience, its earlier
--      text is no longer visible to the audience it was moved out of.
--
--   2. `memory_scope.move_thought(...)` — a narrowly granted SECURITY DEFINER
--      function that changes a thought's workspace/project/visibility in place,
--      and — by grant — the ONLY application path that can. The single
--      `thoughts_app_audience` policy evaluates USING (old row) and WITH CHECK
--      (new row) against the same transaction-local settings, so an ordinary
--      app-role UPDATE can never cross a workspace, and cannot change
--      visibility under a single-visibility scope; under the union read scope
--      the server installs it could, however, re-scope a row inside one
--      workspace. This migration therefore narrows the application role's
--      UPDATE on public.thoughts to the content columns (content, embedding,
--      content_fingerprint, metadata, updated_at): the four audience columns
--      are not updatable by openbrain_app at all, RLS or not, and every
--      audience change goes through this function and writes history. The
--      function reproduces the policy's guarantees explicitly: the caller must
--      already see the row under the installed audience (otherwise it is
--      indistinguishable from an unknown id), the target must be a registered,
--      shape-valid audience, a personal-only workspace only accepts personal
--      rows, and a personal target is owned by the transaction-local principal
--      — never by a caller-supplied subject. Content-fingerprint deduplication
--      is preserved by refusing to move a thought onto identical content that
--      already exists in the target audience — a collision found by the
--      pre-check AND one that lands between the pre-check and the write are
--      both reported as the `conflict` outcome, never as an index error.
--
-- Content updates need no privileged path: the application role updates the
-- content columns inside its own audience under forced RLS (server/queries.ts).
--
-- Legacy rows with a NULL content_fingerprint (captured before fingerprints,
-- or restored from such a dump) are not backfilled here: a blanket backfill
-- would rewrite the table and could itself collide on pre-existing duplicates.
-- Instead the fingerprint is healed lazily with the capture expression the
-- first time such a row is moved (this function derives it, dedupes on it, and
-- persists it) or has its content corrected (server/queries.ts recomputes it).
--
-- Apply after 06-spaces.sql, 07-metadata-degradation.sql, and
-- 08-access-tokens.sql; then run the stable 03-grants-assertion.sql source
-- last. Requires a PostgreSQL superuser (normally `postgres`) because it
-- creates a SECURITY DEFINER function owned by the table owner. Idempotent.
-- Adding the history table and re-scoping the grant take only brief locks; no
-- thought rows are rewritten.

BEGIN;

-- ---------- Application UPDATE is column-scoped -----------------------------
--
-- Converge an existing deployment (01-schema.sql historically granted
-- table-wide UPDATE) to the same column-scoped grant a fresh init now applies:
-- the app can rewrite a thought's content, embedding, fingerprint, metadata,
-- and updated_at, but never its workspace_id/project_id/visibility/
-- owner_subject. SELECT ... FOR UPDATE needs UPDATE on at least one column,
-- which this preserves. Idempotent; the grants assertion pins it.
REVOKE UPDATE ON public.thoughts FROM openbrain_app;
GRANT UPDATE (content, embedding, content_fingerprint, metadata, updated_at)
  ON public.thoughts TO openbrain_app;

-- ---------- Revision history -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.thought_revisions (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Purging a thought (an administrative operation; the application role has
  -- no DELETE) purges its history with it. Soft-delete/forget is a separate
  -- future capability and does not touch this table.
  thought_id             UUID NOT NULL
    REFERENCES public.thoughts(id) ON DELETE CASCADE,
  -- 1-based, dense per thought. Revision N records the state that existed
  -- immediately before change N. Assigned under the head row's lock.
  revision               INTEGER NOT NULL,
  change_kind            TEXT NOT NULL,
  prior_content          TEXT NOT NULL,
  prior_metadata         JSONB NOT NULL,
  prior_workspace_id     TEXT NOT NULL,
  prior_project_id       TEXT,
  prior_visibility       memory_scope.visibility NOT NULL,
  prior_owner_subject    TEXT,
  -- Server-verified identity of the change, mirroring the transport labels
  -- stamped on captures: the trusted principal (OAuth `sub`, or the configured
  -- shared-key principal), the auth door, and a native token's non-secret
  -- label. NULLs mean the door had no such identity, never "unknown caller".
  changed_by_subject     TEXT,
  changed_by_door        TEXT NOT NULL,
  changed_by_token_label TEXT,
  changed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT thought_revisions_change_kind CHECK (
    change_kind IN ('content', 'scope')
  ),
  CONSTRAINT thought_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT thought_revisions_thought_revision_key UNIQUE (thought_id, revision)
);

COMMENT ON TABLE public.thought_revisions IS
  'Append-only prior-state history for thought content updates and audience moves; readable only when the head thought is readable.';

-- History is exactly as protected as its head: a revision row is visible or
-- insertable only when public.thoughts (itself under forced RLS) exposes the
-- head to the current audience. This is the same construction as
-- session_artifact → session in 06-spaces.sql.
ALTER TABLE public.thought_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thought_revisions_app_head ON public.thought_revisions;
CREATE POLICY thought_revisions_app_head ON public.thought_revisions
  FOR ALL TO openbrain_app
  USING (
    EXISTS (SELECT 1 FROM public.thoughts AS t WHERE t.id = thought_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.thoughts AS t WHERE t.id = thought_id)
  );

-- Append-only for the application: it records history but can never rewrite
-- or erase it. The identity column advances under INSERT privilege (no
-- sequence USAGE grant needed — see 04-sessions.sql). The read-only role
-- dumps history and, like every other sequence, needs SELECT on the identity
-- sequence for `pg_dump -U openbrain_readonly`.
REVOKE ALL ON public.thought_revisions FROM PUBLIC;
REVOKE ALL ON public.thought_revisions FROM openbrain_app;
GRANT SELECT, INSERT ON public.thought_revisions TO openbrain_app;
GRANT SELECT ON public.thought_revisions TO openbrain_readonly;
GRANT SELECT ON SEQUENCE public.thought_revisions_id_seq TO openbrain_readonly;

-- ---------- Audience move --------------------------------------------------

-- Moves one thought to a new audience in place. Runs with the table owner's
-- rights so the single-audience RLS policy can be bridged, and therefore
-- re-implements every guarantee that policy would otherwise provide:
--
--   * source visibility: the head must satisfy memory_scope.audience_matches
--     under the caller's transaction-local settings, exactly like a SELECT;
--   * target validity: registered workspace (and project when project
--     visibility), thoughts_audience_shape, and the personal-only rule that
--     the policy's WITH CHECK enforces for ordinary writes;
--   * ownership: a personal target is stamped with openbrain.principal — the
--     verified principal the server installed — never with an argument;
--   * deduplication: identical content already present in the target audience
--     is reported as a conflict instead of violating the fingerprint index.
--
-- Returns no row when the thought is not visible (indistinguishable from an
-- unknown id), otherwise exactly one row whose `outcome` is 'moved',
-- 'unchanged' (already in that audience; no revision written), or 'conflict'
-- (`conflict_thought_id` names the colliding row, which by construction lives
-- in an audience the caller may read). `revision` is the number of history
-- rows on record after the call. Invalid targets raise: the server validates
-- them before calling, so a raise here indicates a bug or a registry race and
-- is surfaced as an internal error rather than translated.
--
-- Argument order and types are part of the grants assertion and boot probe:
-- memory_scope.move_thought(uuid,text,text,memory_scope.visibility,text,text).
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

  -- Lock only a row the caller can already read; an invisible row is neither
  -- locked nor acknowledged.
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
  -- other because it lives in the audience the caller is moving into.
  SELECT t.id INTO existing_id
  FROM public.thoughts AS t
  WHERE t.workspace_id = new_workspace_id
    AND t.project_id IS NOT DISTINCT FROM new_project_id
    AND t.visibility = new_visibility
    AND t.owner_subject IS NOT DISTINCT FROM new_owner_subject
    AND t.content_fingerprint = effective_fingerprint
    AND t.id <> head.id
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
    SELECT t.id INTO existing_id
    FROM public.thoughts AS t
    WHERE t.workspace_id = new_workspace_id
      AND t.project_id IS NOT DISTINCT FROM new_project_id
      AND t.visibility = new_visibility
      AND t.owner_subject IS NOT DISTINCT FROM new_owner_subject
      AND t.content_fingerprint = effective_fingerprint
      AND t.id <> head.id
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

ANALYZE public.thought_revisions;
