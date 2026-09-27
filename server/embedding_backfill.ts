// Maintenance-only operator tool. Default is read-only planning. --apply
// requires an offline corpus and a PostgreSQL superuser; never use app credentials
// or turn this into an automatically run migration.
import { Pool, type PoolClient } from "postgres";
import { DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER } from "./config.ts";
import {
  contractFor,
  embeddingContract,
  type EmbeddingIdentity,
  legacyContractFor,
  readEmbeddingIdentity,
  RUNTIME_VERSION_PATTERN,
} from "./embedding_runtime.ts";
import {
  buildEmbeddingIndex,
  cosine,
  type EmbedOne,
  MAX_EMBEDDING_DURATION_MS,
  sourceHash,
} from "./embedding_index.ts";
import { embed } from "./embeddings.ts";
import { putEmbeddingIndex } from "./embedding_queries.ts";

type Kind = "thought" | "session";

const KINDS = ["thought", "session"] as const;
const TABLES = {
  thought: {
    table: "public.thoughts",
    index: "public.thought_embedding_index",
    key: "thought_id",
    type: "uuid",
    projection: "t.content",
    fields: ["content"],
  },
  session: {
    table: "sessions.session",
    index: "sessions.embedding_index",
    key: "session_id",
    type: "bigint",
    projection: "t.title, t.goal, t.summary, t.resume_context",
    fields: ["title", "goal", "summary", "resume_context"],
  },
} as const;

function embeddingSource(kind: Kind, row: Record<string, unknown>): string {
  return TABLES[kind].fields.map((field) => row[field] ?? "").join(
    kind === "thought" ? "" : "\u0000",
  );
}

async function requireSuperuser(client: PoolClient, tool: string) {
  const access = await client.queryObject<{ owner: boolean }>(
    "SELECT rolsuper AS owner FROM pg_roles WHERE rolname = current_user",
  );
  if (!access.rows[0]?.owner) {
    throw new Error(
      `${tool} requires a PostgreSQL superuser (rolsuper) to include every audience; database ownership alone is insufficient`,
    );
  }
}

async function corpusReady(
  client: PoolClient,
  contract: string,
): Promise<boolean> {
  const ready = await client.queryObject<{ ready: boolean }>(
    "SELECT memory_scope.embedding_ready($1) AS ready",
    [contract],
  );
  return ready.rows[0]?.ready === true;
}

// --rebuild re-embeds every record even when its source and contract already
// match. The contract no longer names the runtime version, so this is the
// recovery path after monitoring shows that a runtime change moved vectors.
export async function backfillEmbeddingIndex(
  client: PoolClient,
  apply = false,
  deps: { contract: typeof embeddingContract; embed: EmbedOne } = {
    contract: embeddingContract,
    embed,
  },
  options: { rebuild?: boolean } = {},
): Promise<void> {
  await requireSuperuser(client, "backfill");
  const contract = await deps.contract();
  console.log(JSON.stringify({
    mode: apply ? "apply" : "plan",
    contract,
    ...(options.rebuild ? { rebuild: true } : {}),
  }));
  // Cursor-style keyset batches avoid loading the corpus or all vectors into
  // memory. One row's complete vectors are built before opening its write tx.
  for (const kind of KINDS) {
    const { table, index: indexTable, key, type, projection, fields } =
      TABLES[kind];
    let after: string | number | null = null;
    let checked = 0;
    let rebuilt = 0;
    while (true) {
      const result = await client.queryObject<Record<string, unknown>>(
        `SELECT t.id::text AS id, ${projection}, i.contract, i.source_hash FROM ${table} t
         LEFT JOIN ${indexTable} i ON i.${key} = t.id
         WHERE ($1::${type} IS NULL OR t.id > $1::${type}) ORDER BY t.id LIMIT 1`,
        [after],
      );
      const row = result.rows[0];
      if (!row) break;
      const id = row.id as string;
      after = id;
      const source = embeddingSource(kind, row);
      const hash = await sourceHash(source);
      checked++;
      if (
        !options.rebuild && row.contract === contract &&
        row.source_hash === hash
      ) continue;
      rebuilt++;
      if (!apply) continue;
      const deadline = performance.now() + MAX_EMBEDDING_DURATION_MS;
      const index = await buildEmbeddingIndex(
        source,
        [...fields],
        deps.embed,
        contract,
        deadline,
      );
      if (await deps.contract({ deadline }) !== contract) {
        throw new Error(
          "model identity changed; backfill stopped before this write",
        );
      }
      await client.queryArray("BEGIN");
      try {
        // The index trigger locks the parent and rechecks the full source
        // hash; concurrent edits cannot install a stale index.
        await putEmbeddingIndex(client, kind, id, index);
        await client.queryArray("COMMIT");
      } catch (error) {
        try {
          await client.queryArray("ROLLBACK");
        } catch { /* preserve the original index/write failure */ }
        throw error;
      }
    }
    console.log(
      JSON.stringify({
        kind,
        checked,
        [apply ? "rebuilt" : "needs_rebuild"]: rebuilt,
      }),
    );
  }
  if (apply) {
    if (await deps.contract() !== contract) {
      throw new Error("model identity changed; generation not activated");
    }
    await client.queryArray("BEGIN");
    try {
      await client.queryArray(
        "LOCK TABLE public.thoughts, sessions.session IN SHARE MODE",
      );
      await client.queryArray(
        "UPDATE memory_scope.embedding_generation SET contract = $1 WHERE singleton",
        [contract],
      );
      if (!await corpusReady(client, contract)) {
        throw new Error("incomplete corpus; generation not activated");
      }
      await client.queryArray("COMMIT");
      console.log(JSON.stringify({ activated: contract }));
    } catch (error) {
      try {
        await client.queryArray("ROLLBACK");
      } catch { /* preserve the original activation failure */ }
      throw error;
    }
  }
}

// One-time conversion of a server 1.28 generation, whose contract also hashed
// the runtime version, to the runtime-free contract without re-embedding. The
// legacy hash proves which runtime and model built the activated generation;
// every passage of a sample of stored records must then match the current
// runtime, and each nonempty record kind must contribute a comparison.
export const RELABEL_SAMPLE_PER_KIND = 8;
export const RELABEL_MAX_SAMPLE_PASSAGES = 8;
export const RELABEL_MIN_COSINE = 0.999;

// `auto` accepts any plausible release string. The candidate is only a hash
// preimage search: a match still requires the current model identity.
export function* legacyRuntimeCandidates(current: string): Generator<string> {
  yield current;
  for (let major = 0; major <= 1; major++) {
    for (let minor = 0; minor <= 99; minor++) {
      for (let patch = 0; patch <= 99; patch++) {
        const release = `${major}.${minor}.${patch}`;
        yield release;
        for (let rc = 0; rc <= 9; rc++) yield `${release}-rc${rc}`;
      }
    }
  }
}

async function findLegacyRuntime(
  identity: EmbeddingIdentity,
  active: string,
  previousRuntime: string,
): Promise<string | undefined> {
  const candidates = previousRuntime === "auto"
    ? legacyRuntimeCandidates(identity.runtime)
    : [previousRuntime];
  let batch: string[] = [];
  const match = async () => {
    const hashes = await Promise.all(
      batch.map((runtime) => legacyContractFor(identity, runtime)),
    );
    const found = batch[hashes.indexOf(active)];
    batch = [];
    return found;
  };
  for (const candidate of candidates) {
    batch.push(candidate);
    if (batch.length === 1000) {
      const found = await match();
      if (found !== undefined) return found;
    }
  }
  return batch.length ? await match() : undefined;
}

async function sampleStoredVectors(
  client: PoolClient,
  embedOne: EmbedOne,
  previous: string,
  contract: string,
) {
  const sampled: Record<Kind, number> = { thought: 0, session: 0 };
  const uncovered: Kind[] = [];
  let passages = 0;
  let chunkMismatches = 0;
  let below = 0;
  let minCosine: number | null = null;
  for (const kind of KINDS) {
    const { table, index, key, projection, fields } = TABLES[kind];
    const present = await client.queryObject<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${index} WHERE contract = $1) AS present`,
      [previous],
    );
    // Rebuilding a record reproduces its exact passage texts, so every stored
    // passage is compared in order. The passage cap bounds work per record;
    // stale rows are skipped here and rejected by the readiness gate.
    const result = await client.queryObject<Record<string, unknown>>(
      `SELECT ${projection}, i.source_hash,
         (SELECT jsonb_agg(v::text ORDER BY n)
          FROM unnest(i.vectors) WITH ORDINALITY AS u(v, n)) AS vectors
       FROM ${index} i JOIN ${table} t ON t.id = i.${key}
       WHERE i.contract = $1 AND cardinality(i.vectors) <= $3
       ORDER BY random() LIMIT $2`,
      [previous, RELABEL_SAMPLE_PER_KIND, RELABEL_MAX_SAMPLE_PASSAGES],
    );
    for (const row of result.rows) {
      const source = embeddingSource(kind, row);
      if (await sourceHash(source) !== row.source_hash) continue;
      const stored = (row.vectors as string[]).map((vector) =>
        JSON.parse(vector) as number[]
      );
      const fresh = await buildEmbeddingIndex(
        source,
        [...fields],
        embedOne,
        contract,
        performance.now() + MAX_EMBEDDING_DURATION_MS,
      );
      sampled[kind]++;
      if (fresh.vectors.length !== stored.length) {
        chunkMismatches++;
        continue;
      }
      for (let i = 0; i < stored.length; i++) {
        const similarity = cosine(fresh.vectors[i], stored[i]);
        passages++;
        if (!(similarity >= RELABEL_MIN_COSINE)) below++;
        if (!Number.isNaN(similarity)) {
          minCosine = Math.min(minCosine ?? 1, similarity);
        }
      }
    }
    if (present.rows[0]?.present && sampled[kind] === 0) uncovered.push(kind);
  }
  return { sampled, uncovered, passages, chunkMismatches, below, minCosine };
}

export async function relabelEmbeddingGeneration(
  client: PoolClient,
  previousRuntime: string,
  apply = false,
  deps: {
    contract: typeof embeddingContract;
    identity: typeof readEmbeddingIdentity;
    embed: EmbedOne;
  } = { contract: embeddingContract, identity: readEmbeddingIdentity, embed },
): Promise<void> {
  await requireSuperuser(client, "relabel");
  const mode = apply ? "apply" : "plan";
  const readIdentity = () =>
    deps.identity({ deadline: performance.now() + MAX_EMBEDDING_DURATION_MS });
  // The sample measures one runtime. Every phase re-reads the serving runtime
  // and refuses if it moved, rather than labeling the corpus compatible with a
  // runtime that was never compared. (A swap after the last check is an
  // ordinary post-relabel upgrade, which 1.29 accepts by design.)
  const identity = await readIdentity();
  const requireSameRuntime = async () => {
    const now = await readIdentity();
    const moved = [
      now.runtime !== identity.runtime &&
      `version ${identity.runtime} -> ${now.runtime}`,
      now.digest !== identity.digest &&
      `model digest ${identity.digest.slice(0, 12)} -> ${
        now.digest.slice(0, 12)
      }`,
    ].filter(Boolean);
    if (moved.length) {
      throw new Error(
        `relabel: embedding identity changed during relabel (${
          moved.join(", ")
        }); nothing relabeled; rerun`,
      );
    }
  };
  // The contract call runs the serving runtime's canaries, which must have
  // validated the runtime identified above.
  const contract = await deps.contract();
  await requireSameRuntime();
  if (await contractFor(identity) !== contract) {
    throw new Error("model identity changed during relabel; nothing relabeled");
  }
  const generation = await client.queryObject<{ contract: string | null }>(
    "SELECT contract FROM memory_scope.embedding_generation WHERE singleton",
  );
  const active = generation.rows[0]?.contract ?? null;
  if (active === contract) {
    console.log(JSON.stringify({ mode, relabel: "already_current", contract }));
    return;
  }
  if (!active) {
    throw new Error(
      "relabel: no activated generation; run the backfill (--apply) instead",
    );
  }
  const runtime = await findLegacyRuntime(identity, active, previousRuntime);
  if (runtime === undefined) {
    throw new Error(
      previousRuntime === "auto"
        ? "relabel: no enumerated runtime version with the current model identity produced the activated generation; run the backfill (--apply) instead"
        : `relabel: runtime ${previousRuntime} with the current model identity did not produce the activated generation; try --relabel auto or run the backfill (--apply)`,
    );
  }
  if (!await corpusReady(client, active)) {
    throw new Error(
      "relabel: the corpus is not fully indexed under the activated generation; run the backfill (--apply) instead",
    );
  }
  const sample = await sampleStoredVectors(
    client,
    deps.embed,
    active,
    contract,
  );
  await requireSameRuntime();
  console.log(JSON.stringify({
    mode,
    previous_runtime: runtime,
    current_runtime: identity.runtime,
    from: active,
    to: contract,
    sampled: sample.sampled,
    passages_compared: sample.passages,
    min_cosine: sample.minCosine,
    below_threshold: sample.below,
    chunk_mismatches: sample.chunkMismatches,
    uncovered: sample.uncovered,
  }));
  // An empty corpus has nothing to compare. A nonempty kind must contribute at
  // least one successful comparison, so the guard can never pass vacuously.
  if (sample.uncovered.length) {
    throw new Error(
      `relabel: no stored ${
        sample.uncovered.join(" or ")
      } vectors of at most ${RELABEL_MAX_SAMPLE_PASSAGES} passages could be compared with the current runtime; run the backfill (--apply) instead`,
    );
  }
  if (sample.below || sample.chunkMismatches) {
    throw new Error(
      "relabel: sampled stored vectors differ from the current runtime; run the backfill (--apply) instead",
    );
  }
  if (!apply) return;
  if (await deps.contract() !== contract) {
    throw new Error("model identity changed; nothing relabeled");
  }
  await requireSameRuntime();
  await client.queryArray("BEGIN");
  try {
    // SHARE blocks every other writer to the parents and their indexes; this
    // transaction's own label updates are unaffected by its locks.
    await client.queryArray(
      "LOCK TABLE public.thoughts, sessions.session, public.thought_embedding_index, sessions.embedding_index IN SHARE MODE",
    );
    const locked = await client.queryObject<{ contract: string | null }>(
      "SELECT contract FROM memory_scope.embedding_generation WHERE singleton FOR UPDATE",
    );
    if (locked.rows[0]?.contract !== active) {
      throw new Error("relabel: generation changed; nothing relabeled");
    }
    if (!await corpusReady(client, active)) {
      throw new Error("relabel: corpus changed; nothing relabeled");
    }
    for (const kind of KINDS) {
      await client.queryArray(
        `UPDATE ${TABLES[kind].index} SET contract = $1 WHERE contract = $2`,
        [contract, active],
      );
    }
    await client.queryArray(
      "UPDATE memory_scope.embedding_generation SET contract = $1 WHERE singleton",
      [contract],
    );
    if (!await corpusReady(client, contract)) {
      throw new Error("relabel: incomplete after relabel; nothing relabeled");
    }
    await client.queryArray("COMMIT");
    console.log(JSON.stringify({ relabeled: contract }));
  } catch (error) {
    try {
      await client.queryArray("ROLLBACK");
    } catch { /* preserve the original relabel failure */ }
    throw error;
  }
}

export function parseBackfillArgs(args: string[]) {
  const usage =
    "usage: embedding_backfill.ts [--rebuild] [--apply] | embedding_backfill.ts --relabel <previous-runtime|auto> [--apply]";
  let apply = false;
  let rebuild = false;
  let relabel: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply" && !apply) apply = true;
    else if (args[i] === "--rebuild" && !rebuild) rebuild = true;
    else if (
      args[i] === "--relabel" && relabel === undefined && i + 1 < args.length
    ) relabel = args[++i];
    else throw new Error(usage);
  }
  if (
    (rebuild && relabel !== undefined) ||
    (relabel !== undefined &&
      (relabel.startsWith("-") ||
        (relabel !== "auto" && !RUNTIME_VERSION_PATTERN.test(relabel))))
  ) throw new Error(usage);
  return { apply, rebuild, relabel };
}

if (import.meta.main) {
  const { apply, rebuild, relabel } = parseBackfillArgs(Deno.args);
  const pool = new Pool({
    hostname: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
  }, 1);
  const client = await pool.connect();
  try {
    if (relabel !== undefined) {
      await relabelEmbeddingGeneration(client, relabel, apply);
    } else {
      await backfillEmbeddingIndex(client, apply, undefined, { rebuild });
    }
  } finally {
    client.release();
    await pool.end();
  }
}
