// Maintenance-only operator tool. Re-runs the configured PRIMARY metadata
// classifier over thoughts whose metadata predates the classifier stamp
// (server 1.16.0) or is the uncategorized stub, and records every rewrite in
// public.thought_revisions as change_kind 'metadata'. Default is read-only
// planning; --apply classifies and writes. Requires a PostgreSQL superuser
// (never app credentials), ENABLE_PRIMARY_EXTRACTION, and migration 16.
// Content goes to the primary endpoint only, never the fallback.
//
// Online-safe: MCP may keep serving. Each row is classified outside any
// transaction, then written in its own transaction under the head's row lock
// only if its content and metadata are still exactly what was classified.
// Output is one JSON line per row plus a summary line; it never includes
// content, people, action items, or dates.
import { Pool, type PoolClient } from "postgres";
import {
  CHAT_API_BASE,
  CHAT_MODEL,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DB_USER,
  ENABLE_PRIMARY_EXTRACTION,
} from "./config.ts";
import { requireSuperuser } from "./maintenance.ts";
import {
  classifyWithPrimary,
  type PrimaryClassification,
  sanitizeMetadataEndpointBase,
  withoutReservedMetadataKeys,
} from "./metadata.ts";
import { PRESERVED_METADATA_KEYS_ON_UPDATE } from "./queries.ts";

// Thoughts whose metadata predates the classifier stamp, or whose stamp is the
// uncategorized stub. Primary- and fallback-stamped rows are never selected,
// so a rerun picks up only what is still unclassified.
const CANDIDATE_SQL = `(
  NOT (t.metadata ? 'metadata_extraction')
  OR t.metadata->'metadata_extraction'->>'endpoint' = 'stub'
)`;

// Revision rows written by operator tools carry this door label and no
// subject or token label: no authenticated request made the change.
export const MAINTENANCE_DOOR = "maintenance";

export type ReclassifyOutcome =
  | "would_reclassify"
  | "reclassified"
  | "primary_failed"
  | "changed_concurrently"
  | "not_candidate";

export type ReclassifyOptions = {
  apply?: boolean;
  // Restrict to these thought ids; requested ids that are not candidates are
  // reported as not_candidate. Undefined means every candidate.
  ids?: string[];
  limit?: number;
};

// Where an apply run sends content: the credential-stripped base URL (as
// stamped on degradation events) and the model of the primary endpoint.
export type PrimaryDestination = { base_url: string; model: string };

export type ReclassifyDeps = {
  primaryEnabled: boolean;
  primary: PrimaryDestination;
  classify: (text: string) => Promise<PrimaryClassification>;
  emit: (record: Record<string, unknown>) => void;
};

export const defaultReclassifyDeps: ReclassifyDeps = {
  primaryEnabled: ENABLE_PRIMARY_EXTRACTION,
  primary: {
    base_url: sanitizeMetadataEndpointBase(CHAT_API_BASE),
    model: CHAT_MODEL,
  },
  classify: classifyWithPrimary,
  emit: (record) => console.log(JSON.stringify(record)),
};

export type ReclassifySummary = {
  mode: "plan" | "apply";
  // Printed by plan too, so the operator confirms the destination before
  // approving an apply run.
  primary: PrimaryDestination;
  // Every candidate matching the id restriction, before --limit.
  candidates: number;
  selected: number;
} & Record<ReclassifyOutcome, number>;

type Classification = { type: string | null; topics: string[] | null };

// The only metadata fields the tool ever prints.
function classification(type: unknown, topics: unknown): Classification {
  return {
    type: typeof type === "string" ? type : null,
    topics: Array.isArray(topics) &&
        topics.every((topic) => typeof topic === "string")
      ? topics
      : null,
  };
}

// Migration 16's CHECK exactly as PostgreSQL prints it; the grants assertion
// pins the same text.
const CHANGE_KIND_CHECK =
  "CHECK ((change_kind = ANY (ARRAY['content'::text, 'scope'::text, 'metadata'::text])))";

// Proves before any thought is read that a 'metadata' revision will pass every
// CHECK on change_kind: the named CHECK has migration 16's exact, validated
// definition, and no other CHECK reads change_kind. PostgreSQL ANDs every
// CHECK, and one added NOT VALID still binds new rows. Mirrors the grants
// assertion.
async function requireMetadataRevisionKind(client: PoolClient) {
  const kind = await client.queryObject<
    { ready: boolean; narrowing: string[] }
  >(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_constraint AS c
         WHERE c.conrelid = to_regclass('public.thought_revisions')
           AND c.conname = 'thought_revisions_change_kind'
           AND c.contype = 'c'
           AND c.convalidated
           AND pg_get_constraintdef(c.oid) = $1
       ) AS ready,
       ARRAY(
         SELECT c.conname::text
         FROM pg_constraint AS c
         JOIN pg_attribute AS a
           ON a.attrelid = c.conrelid AND a.attname = 'change_kind'
         WHERE c.conrelid = to_regclass('public.thought_revisions')
           AND c.contype = 'c'
           AND c.conname <> 'thought_revisions_change_kind'
           AND a.attnum = ANY (c.conkey)
         ORDER BY 1
       ) AS narrowing`,
    [CHANGE_KIND_CHECK],
  );
  const row = kind.rows[0];
  if (row?.ready !== true) {
    throw new Error(
      "public.thought_revisions does not accept change_kind 'metadata'; apply db/16-thought-metadata-revisions.sql as a PostgreSQL superuser, then db/03-grants-assertion.sql",
    );
  }
  if (row.narrowing.length > 0) {
    throw new Error(
      `public.thought_revisions change_kind must be constrained only by thought_revisions_change_kind; drop ${
        row.narrowing.join(", ")
      } as a PostgreSQL superuser, then run db/03-grants-assertion.sql`,
    );
  }
}

// One locked write. Returns null, writing nothing, when the head vanished or
// its content/metadata no longer match what was classified. The revision
// snapshots the locked head and is numbered under its lock; the metadata
// merge keeps the original capture stamps exactly like updateThoughtContent.
// The thoughts_updated_at trigger advances updated_at; the embedding index is
// untouched because content does not change.
async function writeReclassified(
  client: PoolClient,
  id: string,
  classified: { content: string; metadata: string },
  freshMetadata: Record<string, unknown>,
): Promise<Classification | null> {
  const locked = await client.queryObject<{ unchanged: boolean }>(
    `SELECT (t.content = $2 AND t.metadata = $3::jsonb) AS unchanged
     FROM public.thoughts AS t WHERE t.id = $1
     FOR UPDATE`,
    [id, classified.content, classified.metadata],
  );
  if (locked.rows[0]?.unchanged !== true) return null;
  await client.queryArray(
    `INSERT INTO public.thought_revisions (
       thought_id, revision, change_kind,
       prior_content, prior_metadata,
       prior_workspace_id, prior_project_id, prior_visibility,
       prior_owner_subject,
       changed_by_subject, changed_by_door, changed_by_token_label
     )
     SELECT t.id,
            (SELECT COALESCE(max(r.revision), 0) + 1
             FROM public.thought_revisions AS r WHERE r.thought_id = t.id),
            'metadata',
            t.content, t.metadata,
            t.workspace_id, t.project_id, t.visibility, t.owner_subject,
            NULL, $2, NULL
     FROM public.thoughts AS t WHERE t.id = $1`,
    [id, MAINTENANCE_DOOR],
  );
  const updated = await client.queryObject<
    { type: unknown; topics: unknown }
  >(
    `UPDATE public.thoughts AS t
     SET metadata = $2::jsonb || COALESCE(
       (
         SELECT jsonb_object_agg(preserved.key, preserved.value)
         FROM jsonb_each(t.metadata) AS preserved
         WHERE preserved.key = ANY ($3::text[])
       ),
       '{}'::jsonb
     )
     WHERE t.id = $1
     RETURNING t.metadata->>'type' AS type, t.metadata->'topics' AS topics`,
    [id, JSON.stringify(freshMetadata), [...PRESERVED_METADATA_KEYS_ON_UPDATE]],
  );
  const row = updated.rows[0];
  if (!row) throw new Error("thought vanished under its own row lock");
  return classification(row.type, row.topics);
}

export async function reclassifyMetadata(
  client: PoolClient,
  options: ReclassifyOptions = {},
  deps: ReclassifyDeps = defaultReclassifyDeps,
): Promise<ReclassifySummary> {
  // Every refusal happens before any content is read or classified.
  await requireSuperuser(client, "metadata reclassification");
  if (!deps.primaryEnabled) {
    throw new Error(
      "metadata reclassification uses only the primary classifier; set ENABLE_PRIMARY_EXTRACTION=true with CHAT_API_BASE and CHAT_MODEL",
    );
  }
  await requireMetadataRevisionKind(client);

  const apply = options.apply === true;
  const summary: ReclassifySummary = {
    mode: apply ? "apply" : "plan",
    primary: deps.primary,
    candidates: 0,
    selected: 0,
    would_reclassify: 0,
    reclassified: 0,
    primary_failed: 0,
    changed_concurrently: 0,
    not_candidate: 0,
  };
  const report = (
    id: string,
    outcome: ReclassifyOutcome,
    fields: Record<string, unknown> = {},
  ) => {
    summary[outcome]++;
    deps.emit({ id, outcome, ...fields });
  };

  // Ids only (plus the printable classification): content is read one row at
  // a time, immediately before that row is classified. PostgreSQL prints
  // uuids in lowercase; compare requested ids the same way.
  const ids = options.ids?.map((id) => id.toLowerCase());
  const listed = await client.queryObject<
    { id: string; type: unknown; topics: unknown }
  >(
    `SELECT t.id::text AS id,
            t.metadata->>'type' AS type,
            t.metadata->'topics' AS topics
     FROM public.thoughts AS t
     WHERE ${CANDIDATE_SQL}
       AND ($1::uuid[] IS NULL OR t.id = ANY ($1::uuid[]))
     ORDER BY t.created_at, t.id`,
    [ids ?? null],
  );
  const candidates = listed.rows;
  summary.candidates = candidates.length;
  if (ids) {
    const found = new Set(candidates.map((row) => row.id));
    for (const id of ids) {
      if (!found.has(id)) report(id, "not_candidate");
    }
  }
  const selected = candidates.slice(0, options.limit ?? candidates.length);
  summary.selected = selected.length;

  for (const candidate of selected) {
    if (!apply) {
      report(candidate.id, "would_reclassify", {
        before: classification(candidate.type, candidate.topics),
      });
      continue;
    }
    // Re-read just before classifying: a row reclassified or edited since
    // the listing is no longer what this run selected.
    const current = await client.queryObject<
      { content: string; metadata: string }
    >(
      `SELECT t.content, t.metadata::text AS metadata
       FROM public.thoughts AS t
       WHERE t.id = $1 AND ${CANDIDATE_SQL}`,
      [candidate.id],
    );
    const row = current.rows[0];
    if (!row) {
      report(candidate.id, "changed_concurrently");
      continue;
    }
    const prior = JSON.parse(row.metadata) as Record<string, unknown>;
    const before = classification(prior.type, prior.topics);
    // No transaction is open while the classifier runs.
    const result = await deps.classify(row.content);
    if (!result.ok) {
      // The capture-path degradation ledger is not written: this is an
      // operator run, reported here and retried by rerunning.
      report(candidate.id, "primary_failed", {
        reason: result.reason,
        ...(result.reason === "non_2xx" ? { http_status: result.status } : {}),
        before,
      });
      continue;
    }
    const freshMetadata = {
      ...withoutReservedMetadataKeys(result.metadata),
      metadata_extraction: {
        schema_version: 1,
        endpoint: "primary",
        model: result.classifier.model,
      },
    };
    await client.queryArray("BEGIN");
    let after: Classification | null;
    try {
      after = await writeReclassified(client, candidate.id, row, freshMetadata);
      await client.queryArray(after ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      try {
        await client.queryArray("ROLLBACK");
      } catch { /* preserve the original write failure */ }
      throw error;
    }
    if (after) report(candidate.id, "reclassified", { before, after });
    else report(candidate.id, "changed_concurrently", { before });
  }

  deps.emit({ summary });
  return summary;
}

// 0: completed and every selected row was planned or reclassified
//    (not_candidate ids are informational). 2: completed, but at least one
//    row failed at the primary or changed concurrently and was left untouched;
//    rerun to retry it. Refusals and aborts exit 1 (see the entry point).
export function reclassifyExitCode(summary: ReclassifySummary): 0 | 2 {
  return summary.primary_failed + summary.changed_concurrently > 0 ? 2 : 0;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReclassifyArgs(args: string[]) {
  const usage =
    "usage: metadata_reclassify.ts [--apply] [--id <uuid>]... [--limit <n>]";
  let apply = false;
  let ids: string[] | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--apply" && !apply) apply = true;
    else if (args[i] === "--id" && value !== undefined) {
      const id = value.toLowerCase();
      if (!UUID_PATTERN.test(value) || ids?.includes(id)) {
        throw new Error(usage);
      }
      (ids ??= []).push(id);
      i++;
    } else if (
      args[i] === "--limit" && limit === undefined && value !== undefined &&
      /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
    ) {
      limit = Number(value);
      i++;
    } else throw new Error(usage);
  }
  return { apply, ids, limit };
}

// Exit 1 on any refusal or abort: a usage error, a non-superuser connection,
// disabled primary extraction, missing migration 16, or a database error.
// Rows committed before an abort keep their revisions; a rerun resumes.
if (import.meta.main) {
  let code = 1;
  try {
    const options = parseReclassifyArgs(Deno.args);
    const pool = new Pool({
      hostname: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
    }, 1);
    try {
      const client = await pool.connect();
      try {
        code = reclassifyExitCode(await reclassifyMetadata(client, options));
      } finally {
        client.release();
      }
    } finally {
      try {
        await pool.end();
      } catch { /* preserve the run's own outcome */ }
    }
  } catch (error) {
    code = 1;
    console.error(
      `metadata_reclassify: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  Deno.exit(code);
}
