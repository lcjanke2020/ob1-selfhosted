// Boot-time DB reachability and required-schema probe.
//
// deno-postgres's Pool constructor starts connecting every client at
// construction time as a fire-and-forget promise (`#ready = #initialize()`).
// Nothing awaits that promise until the first `pool.connect()` call, so when
// Postgres is unreachable at boot the rejection is unhandled and Deno kills
// the process with a bare ConnectionRefused stack.
//
// This probe is the app-owned handler for that failure: `pool.connect()`
// awaits the constructor's init promise, so calling the probe synchronously
// right after `new Pool(...)` adopts the rejection before it can become
// unhandled. On failure it rejects with an operator-facing message naming
// the target and the env vars to check; the caller (db.ts) top-level-awaits
// it as a startup gate and decides the policy (fail-fast exit). Mirrors
// auth.ts `probeJwksReachability` — awaited at module load, time-bounded.
//
// The probe MUST be invoked synchronously after Pool construction — an
// intervening `await` (e.g. another module's top-level probe) would leave a
// window where the constructor's rejection fires unobserved. `await
// probeDbAtBoot(...)` at the wiring site is fine: the function body runs
// synchronously up to its first internal await, which is inside the borrow
// attempt, so the init promise is adopted in the same tick.
//
// The overall deadline exists because the driver has no client-side connect
// timeout (pool.ts's own TODO: "Initialization should probably have a
// timeout"): an endpoint that accepts TCP but never completes the handshake
// (mid-boot DB host, wedged pooler, conntrack-blackholed path) leaves the
// init promise unsettled forever. Only turning that into an exit lets the
// deploy supervisor's restart policy take over — it reacts to exits, not
// hangs. The in-flight connect cannot be cancelled (driver limitation); the
// caller's `Deno.exit(1)` makes that moot.

import type { Pool } from "postgres";

class RequiredSchemaError extends Error {}

// A refused connection rejects near-instantly, but a hung connect sits
// silent — warn once so the operator sees what boot is stuck on before the
// deadline fires.
const DEFAULT_SLOW_WARN_AFTER_MS = 10_000;

// Default for the overall deadline; production wiring passes
// DB_BOOT_PROBE_TIMEOUT_MS from config.ts (env-tunable).
const DEFAULT_DEADLINE_MS = 30_000;

export interface ProbeDbAtBootOptions {
  /** Emit a one-shot "still trying" warning after this long. */
  slowWarnAfterMs?: number;
  /** Give up and reject after this long, even if the connect is still in flight. */
  deadlineMs?: number;
  /** Configured omitted-scope workspace; must exist before the server boots. */
  defaultWorkspaceId?: string;
}

/**
 * Borrow one client from `pool`, validate it with `SELECT 1`, and verify the
 * hybrid-search indexes expected by this server version are installed.
 * Surfaces any boot-time connection or schema failure as a rejection the
 * caller owns.
 *
 * `target` is the human-readable `host:port` used in messages. Resolves on
 * success; rejects with operator guidance on driver failure OR when
 * `deadlineMs` elapses first. Never exits — policy belongs to the caller.
 */
export async function probeDbAtBoot(
  pool: Pool,
  target: string,
  {
    slowWarnAfterMs = DEFAULT_SLOW_WARN_AFTER_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    defaultWorkspaceId = "default",
  }: ProbeDbAtBootOptions = {},
): Promise<void> {
  // Started synchronously so `pool.connect()` adopts the constructor's init
  // promise in the same tick (see header).
  const attempt = (async () => {
    const client = await pool.connect();
    try {
      await client.queryArray("SELECT 1");
      const schema = await client.queryArray<[
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
      ]>(
        `SELECT
           to_regclass('public.idx_thoughts_content_tsv') IS NOT NULL,
           to_regclass('public.idx_thoughts_content_trgm') IS NOT NULL,
           to_regclass('memory_scope.workspace') IS NOT NULL
             AND to_regclass('memory_scope.project') IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM memory_scope.workspace
               WHERE id = 'default'
                 AND default_visibility = 'workspace'
                 AND NOT personal_only
             )
             AND EXISTS (
               SELECT 1 FROM memory_scope.workspace
               WHERE id = 'sensitive'
                 AND default_visibility = 'personal'
                 AND personal_only
             ),
           (
             SELECT count(*) = 4 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'thoughts'
               AND column_name = ANY (ARRAY[
                 'workspace_id', 'project_id', 'visibility', 'owner_subject'
               ])
           ),
           (
             SELECT count(*) = 4 FROM information_schema.columns
             WHERE table_schema = 'sessions' AND table_name = 'session'
               AND column_name = ANY (ARRAY[
                 'workspace_id', 'project_id', 'visibility', 'owner_subject'
               ])
           ),
           to_regclass('public.idx_thoughts_scope_audience') IS NOT NULL
             AND to_regclass('sessions.idx_session_scope_audience') IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM pg_indexes
               WHERE schemaname = 'public'
                 AND indexname = 'idx_thoughts_fingerprint'
                 AND indexdef LIKE '%workspace_id%'
                 AND indexdef LIKE '%NULLS NOT DISTINCT%'
             ),
           to_regprocedure(
             'memory_scope.search_thought_candidates(vector,double precision,text,text,boolean,jsonb,jsonb,integer)'
           ) IS NOT NULL,
           EXISTS (
             SELECT 1
             FROM pg_class thoughts
             JOIN pg_namespace thoughts_ns ON thoughts_ns.oid = thoughts.relnamespace
             JOIN pg_class session_rel ON true
             JOIN pg_namespace session_ns ON session_ns.oid = session_rel.relnamespace
             JOIN pg_class artifact_rel ON true
             JOIN pg_namespace artifact_ns ON artifact_ns.oid = artifact_rel.relnamespace
             WHERE thoughts_ns.nspname = 'public'
               AND thoughts.relname = 'thoughts'
               AND thoughts.relrowsecurity AND thoughts.relforcerowsecurity
               AND session_ns.nspname = 'sessions'
               AND session_rel.relname = 'session'
               AND session_rel.relrowsecurity AND session_rel.relforcerowsecurity
               AND artifact_ns.nspname = 'sessions'
               AND artifact_rel.relname = 'artifact'
               AND artifact_rel.relrowsecurity AND artifact_rel.relforcerowsecurity
               AND EXISTS (
                 SELECT 1 FROM pg_policy
                 WHERE polrelid = thoughts.oid
                   AND polname = 'thoughts_app_audience'
               )
               AND EXISTS (
                 SELECT 1 FROM pg_policy
                 WHERE polrelid = session_rel.oid
                   AND polname = 'session_app_audience'
               )
               AND EXISTS (
                 SELECT 1 FROM pg_policy
                 WHERE polrelid = artifact_rel.oid
                   AND polname = 'artifact_app_audience'
               )
           )`,
      );
      const [
        hasFtsIndex,
        hasTrigramIndex,
        hasWorkspaceRegistry,
        hasThoughtScope,
        hasSessionScope,
        hasAudienceIndexes,
        hasScopedSearch,
        hasRlsEnforcement,
      ] = schema.rows[0] ?? [
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ];
      if (!hasFtsIndex || !hasTrigramIndex) {
        const missing = [
          ...(!hasFtsIndex ? ["idx_thoughts_content_tsv"] : []),
          ...(!hasTrigramIndex ? ["idx_thoughts_content_trgm"] : []),
        ].join(", ");
        throw new RequiredSchemaError(
          `[db] Postgres at ${target} is missing hybrid-search schema ` +
            `(${missing}). Apply db/05-hybrid-search.sql as the database ` +
            `owner before starting this server version.`,
        );
      }
      if (
        !hasWorkspaceRegistry || !hasThoughtScope || !hasSessionScope ||
        !hasAudienceIndexes || !hasScopedSearch || !hasRlsEnforcement
      ) {
        const missing = [
          ...(!hasWorkspaceRegistry
            ? ["workspace/project registry and reserved rows"]
            : []),
          ...(!hasThoughtScope ? ["thought audience columns"] : []),
          ...(!hasSessionScope ? ["session audience columns"] : []),
          ...(!hasAudienceIndexes ? ["audience-aware indexes"] : []),
          ...(!hasScopedSearch
            ? ["memory_scope.search_thought_candidates"]
            : []),
          ...(!hasRlsEnforcement ? ["forced audience RLS policies"] : []),
        ].join(", ");
        throw new RequiredSchemaError(
          `[db] Postgres at ${target} is missing fail-closed spaces schema ` +
            `(${missing}). Apply db/06-spaces.sql as a PostgreSQL superuser ` +
            `(for example, postgres) before starting this server version.`,
        );
      }
      const configuredWorkspace = await client.queryArray<[boolean]>(
        `SELECT EXISTS (
           SELECT 1 FROM memory_scope.workspace WHERE id = $1
         )`,
        [defaultWorkspaceId],
      );
      if (configuredWorkspace.rows[0]?.[0] !== true) {
        throw new RequiredSchemaError(
          `[db] Postgres at ${target} has no configured default workspace ` +
            `${JSON.stringify(defaultWorkspaceId)}. Register it in ` +
            `memory_scope.workspace or fix DEFAULT_WORKSPACE_ID before starting ` +
            `this server version.`,
        );
      }
    } finally {
      client.release();
    }
  })();
  // The deadline can win the race below while the connect is still in
  // flight; keep the eventual rejection observed so it can never become a
  // NEW unhandled rejection (the failure mode this module exists to remove).
  attempt.catch(() => {});

  const slowWarn = setTimeout(() => {
    console.warn(
      `[db] still trying to reach Postgres at ${target} after ` +
        `${Math.round(slowWarnAfterMs / 1000)}s — check DB_HOST/DB_PORT and ` +
        `the network path (tailnet up? firewall open? DB host booted?)`,
    );
  }, slowWarnAfterMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    let outcome: "ok" | "deadline";
    try {
      outcome = await Promise.race([
        attempt.then(() => "ok" as const),
        new Promise<"deadline">((resolve) => {
          deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof RequiredSchemaError) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(
        `[db] Postgres at ${target} is unreachable or rejected the ` +
          `connection: ${reason}. Check DB_HOST/DB_PORT (server up? reachable ` +
          `from this container/qube?) and DB_USER/DB_PASSWORD/DB_NAME.`,
      );
    }
    if (outcome === "deadline") {
      throw new Error(
        `[db] gave up on Postgres at ${target} after ` +
          `${Math.round(deadlineMs / 1000)}s: the connection attempt appears ` +
          `hung (TCP accepted but no handshake?) and the driver has no ` +
          `client-side connect timeout. Check DB_HOST/DB_PORT and the network ` +
          `path (tailnet up? firewall open? DB host booted?). Raise ` +
          `DB_BOOT_PROBE_TIMEOUT_MS if the database is just slow to accept ` +
          `connections.`,
      );
    }
  } finally {
    clearTimeout(slowWarn);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
