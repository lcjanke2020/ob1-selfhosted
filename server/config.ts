// Environment-driven configuration. All knobs live here so the rest of the
// server reads typed constants instead of poking Deno.env directly.
//
// All values are validated at module load. Misconfiguration crashes fast
// with a clear error rather than producing NaN, empty strings, or other
// silent failure modes deep in request handlers.

function required(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function requiredInt(
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a complete positive decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return value;
}

function optionalTrimmed(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

export const DB_HOST = optionalTrimmed("DB_HOST") || "127.0.0.1";
export const DB_PORT = requiredInt("DB_PORT", 5432);
export const DB_NAME = optionalTrimmed("DB_NAME") || "openbrain";
export const DB_USER = optionalTrimmed("DB_USER") || "openbrain_app";
export const DB_PASSWORD = required("DB_PASSWORD");
export const DB_POOL_SIZE = requiredInt("DB_POOL_SIZE", 10);

// Omitted request scope resolves to exactly this registered workspace — never
// to every workspace. db/06-spaces.sql seeds `default`; operators may select a
// different pre-registered workspace. Keep the same bounded, trimmed ID shape
// as the shared Zod/SQL contract so a bad default fails at boot, not per call.
function validatedScopeId(
  value: string,
  name: string,
  fallback: string,
): string {
  value ||= fallback;
  if (value.length > 128) {
    throw new Error(`${name} must be at most 128 characters`);
  }
  return value;
}

export const DEFAULT_WORKSPACE_ID = validatedScopeId(
  optionalTrimmed("DEFAULT_WORKSPACE_ID"),
  "DEFAULT_WORKSPACE_ID",
  "default",
);

export const OLLAMA_URL = optionalTrimmed("OLLAMA_URL") ||
  "http://localhost:11434";
export const EMBED_MODEL = optionalTrimmed("EMBED_MODEL") || "nomic-embed-text";
export const EMBED_DIM = requiredInt("EMBED_DIM", 768);

// Optional PRIMARY chat-completion endpoint for metadata extraction (topics,
// people, type, etc.). Any OpenAI-compatible /chat/completions endpoint will do,
// including a local Ollama / LM Studio with `<base>/v1` set as CHAT_API_BASE and
// a chat model like `llama3.1:8b` set as CHAT_MODEL. The primary only fires when
// opted in via ENABLE_PRIMARY_EXTRACTION below.
export const CHAT_API_BASE = optionalTrimmed("CHAT_API_BASE");
export const CHAT_API_KEY = optionalTrimmed("CHAT_API_KEY");
export const CHAT_MODEL = optionalTrimmed("CHAT_MODEL");

// Safety gate for the PRIMARY (CHAT_*) extractor call. Default OFF: the primary
// is attempted ONLY when ENABLE_PRIMARY_EXTRACTION is set to "true" AND the
// primary endpoint is configured. The opt-in exists so a primary that is
// misconfigured or fronted by a dangerous transport can't fire on the hot
// capture path — e.g. a qrexec forwarder whose call would auto-start a downed
// GPU qube. Set to "true" only once the primary endpoint is known-good.
const PRIMARY_EXTRACTION_SETTING = optionalTrimmed(
  "ENABLE_PRIMARY_EXTRACTION",
).toLowerCase();
if (
  PRIMARY_EXTRACTION_SETTING &&
  !["true", "false"].includes(PRIMARY_EXTRACTION_SETTING)
) {
  throw new Error("ENABLE_PRIMARY_EXTRACTION must be true or false");
}
const PRIMARY_EXTRACTION_OPT_IN = PRIMARY_EXTRACTION_SETTING === "true";
if (PRIMARY_EXTRACTION_OPT_IN && (!CHAT_API_BASE || !CHAT_MODEL)) {
  throw new Error(
    "ENABLE_PRIMARY_EXTRACTION=true requires CHAT_API_BASE and CHAT_MODEL",
  );
}
export const ENABLE_PRIMARY_EXTRACTION = Boolean(
  PRIMARY_EXTRACTION_OPT_IN && CHAT_API_BASE && CHAT_MODEL,
);

// The fallback privacy posture is always an explicit operator choice. There is
// deliberately no default: upgrading or adding endpoint variables must never
// silently decide whether captured thought content may reach another endpoint.
export type MetadataFallbackPolicy = "off" | "alert" | "allow";

function metadataFallbackPolicy(): MetadataFallbackPolicy {
  const value = optionalTrimmed("METADATA_FALLBACK_POLICY");
  if (!value) {
    throw new Error(
      "Missing required env var: METADATA_FALLBACK_POLICY " +
        "(expected off, alert, or allow)",
    );
  }
  if (value !== "off" && value !== "alert" && value !== "allow") {
    throw new Error(
      "METADATA_FALLBACK_POLICY must be exactly off, alert, or allow " +
        "(lowercase)",
    );
  }
  return value;
}

export const METADATA_FALLBACK_POLICY = metadataFallbackPolicy();

// Optional FALLBACK chat endpoint. `off` keeps it inert even when its endpoint
// variables are populated; `alert` and `allow` permit it after the primary is
// disabled or fails. It remains valid on its own for an explicit fallback-only
// deployment. BOTH base and model are required to make the endpoint available.
export const FALLBACK_CHAT_API_BASE = optionalTrimmed("FALLBACK_CHAT_API_BASE");
export const FALLBACK_CHAT_API_KEY = optionalTrimmed("FALLBACK_CHAT_API_KEY");
export const FALLBACK_CHAT_MODEL = optionalTrimmed("FALLBACK_CHAT_MODEL");
export const ENABLE_FALLBACK_EXTRACTION = Boolean(
  METADATA_FALLBACK_POLICY !== "off" && FALLBACK_CHAT_API_BASE &&
    FALLBACK_CHAT_MODEL,
);

// Metadata extraction runs when EITHER path is active; with neither configured,
// capture skips classification and stamps the minimal {topics:[uncategorized]}
// stub.
export const ENABLE_METADATA_EXTRACTION = ENABLE_PRIMARY_EXTRACTION ||
  ENABLE_FALLBACK_EXTRACTION;

// Optional durable metadata-degradation notifications. Empty means real
// degradation rows and their pending outbox entries are retained, but no
// delivery worker runs. A comma-separated list enables one or both pluggable
// adapters. Multiple adapters are best-effort fan-out, not independent per-
// channel queues: the batch succeeds when at least one adapter accepts it,
// while failed channel names are retained in the delivery ledger for diagnosis.
export type MetadataNotificationChannel = "pushover" | "ntfy";

function metadataNotificationChannels(): MetadataNotificationChannel[] {
  const raw = optionalTrimmed("METADATA_NOTIFY_CHANNELS");
  if (!raw) return [];
  const channels = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unique = new Set<string>();
  for (const channel of channels) {
    if (channel !== "pushover" && channel !== "ntfy") {
      throw new Error(
        "Invalid METADATA_NOTIFY_CHANNELS entry " +
          "(expected pushover and/or ntfy)",
      );
    }
    if (unique.has(channel)) {
      throw new Error(`Duplicate METADATA_NOTIFY_CHANNELS entry: ${channel}`);
    }
    unique.add(channel);
  }
  return [...unique] as MetadataNotificationChannel[];
}

function noControlCharacters(name: string, value: string, max: number): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (value.length > max || hasControlCharacter) {
    throw new Error(
      `${name} must be at most ${max} characters and contain no control characters`,
    );
  }
  return value;
}

export const METADATA_NOTIFY_CHANNELS = metadataNotificationChannels();
export const ENABLE_METADATA_NOTIFICATIONS =
  METADATA_NOTIFY_CHANNELS.length > 0;
export const METADATA_NOTIFY_LABEL = noControlCharacters(
  "METADATA_NOTIFY_LABEL",
  optionalTrimmed("METADATA_NOTIFY_LABEL") || "OpenBrain",
  64,
);
export const METADATA_NOTIFY_POLL_INTERVAL_MS = requiredInt(
  "METADATA_NOTIFY_POLL_INTERVAL_MS",
  300_000,
  MAX_TIMER_DELAY_MS,
);
export const METADATA_NOTIFY_ROLLUP_MS = requiredInt(
  "METADATA_NOTIFY_ROLLUP_MS",
  1_800_000,
  MAX_TIMER_DELAY_MS,
);
export const METADATA_NOTIFY_TIMEOUT_MS = requiredInt(
  "METADATA_NOTIFY_TIMEOUT_MS",
  10_000,
  MAX_TIMER_DELAY_MS,
);

export const METADATA_PUSHOVER_APP_TOKEN = noControlCharacters(
  "METADATA_PUSHOVER_APP_TOKEN",
  optionalTrimmed("METADATA_PUSHOVER_APP_TOKEN"),
  1024,
);
export const METADATA_PUSHOVER_USER_KEY = noControlCharacters(
  "METADATA_PUSHOVER_USER_KEY",
  optionalTrimmed("METADATA_PUSHOVER_USER_KEY"),
  1024,
);
export const METADATA_NTFY_TOPIC = noControlCharacters(
  "METADATA_NTFY_TOPIC",
  optionalTrimmed("METADATA_NTFY_TOPIC"),
  256,
);
export const METADATA_NTFY_TOKEN = noControlCharacters(
  "METADATA_NTFY_TOKEN",
  optionalTrimmed("METADATA_NTFY_TOKEN"),
  2048,
);
export const METADATA_NTFY_SERVER_URL = optionalTrimmed(
  "METADATA_NTFY_SERVER_URL",
) || "https://ntfy.sh";

if (METADATA_NOTIFY_CHANNELS.includes("pushover")) {
  if (!METADATA_PUSHOVER_APP_TOKEN || !METADATA_PUSHOVER_USER_KEY) {
    throw new Error(
      "METADATA_NOTIFY_CHANNELS includes pushover, so " +
        "METADATA_PUSHOVER_APP_TOKEN and METADATA_PUSHOVER_USER_KEY are required",
    );
  }
}

if (METADATA_NOTIFY_CHANNELS.includes("ntfy")) {
  if (!METADATA_NTFY_TOPIC) {
    throw new Error(
      "METADATA_NOTIFY_CHANNELS includes ntfy, so METADATA_NTFY_TOPIC is required",
    );
  }
  let ntfyUrl: URL;
  try {
    ntfyUrl = new URL(METADATA_NTFY_SERVER_URL);
  } catch {
    throw new Error("METADATA_NTFY_SERVER_URL must be an absolute URL");
  }
  if (
    !["http:", "https:"].includes(ntfyUrl.protocol) || ntfyUrl.username ||
    ntfyUrl.password || ntfyUrl.search || ntfyUrl.hash
  ) {
    throw new Error(
      "METADATA_NTFY_SERVER_URL must use http/https and contain no credentials, query, or fragment",
    );
  }
  if (
    METADATA_NTFY_TOKEN &&
    !/^[A-Za-z0-9\-._~+/]+=*$/.test(METADATA_NTFY_TOKEN)
  ) {
    throw new Error("METADATA_NTFY_TOKEN is not a valid bearer token");
  }
}

// `alert` promises that notification plumbing is configured before fallback
// classification is permitted. Runtime delivery remains best-effort. A
// selected but incomplete adapter already fails above; an empty channel list
// must fail too rather than quietly behaving like `allow`.
if (
  METADATA_FALLBACK_POLICY === "alert" &&
  !ENABLE_METADATA_NOTIFICATIONS
) {
  throw new Error(
    "METADATA_FALLBACK_POLICY=alert requires at least one configured " +
      "METADATA_NOTIFY_CHANNELS adapter",
  );
}

// Opt-in REST gateway (/api/v1). Default OFF; when off the router is never
// mounted, so the surface does not exist (every /api/v1 path 404s before any
// handler is registered). The docker-compose installs opt in
// (compose-local sets it, and the compose-tailnet overlay inherits it); the
// Qubes deployment deliberately leaves it unset — its posture is
// minimum-attack-surface, and the MCP transport is the only surface it
// needs. Same exactly-"true" contract as ENABLE_PRIMARY_EXTRACTION above.
export const ENABLE_REST_API =
  optionalTrimmed("ENABLE_REST_API").toLowerCase() === "true";

// Native rotatable tokens share the non-OIDC x-brain-key header with the
// legacy static key, but are independently enabled so public OAuth deployments
// can pin the entire native door off. The server default is deliberately off;
// compose-local opts in and the Funnel override pins false.
const NATIVE_TOKEN_SETTING = optionalTrimmed(
  "ENABLE_NATIVE_TOKENS",
).toLowerCase();
if (NATIVE_TOKEN_SETTING && !["true", "false"].includes(NATIVE_TOKEN_SETTING)) {
  throw new Error("ENABLE_NATIVE_TOKENS must be true or false");
}
export const ENABLE_NATIVE_TOKENS = NATIVE_TOKEN_SETTING === "true";

// MCP_ACCESS_KEY enables the static x-brain-key auth door. It is OPTIONAL:
// set it to turn the legacy static matcher ON, or leave it empty to disable
// that matcher. Native tokens can independently keep the same header door on.
// The `compose-tailnet` (Funnel) and `qubes` deployments leave it empty, disable
// native tokens, and rely on OAuth alone — the single-door posture recommended
// for any publicly reachable install.
//
// When set, a minimum length is enforced. `.env.example` documents
// `openssl rand -hex 32` (64 hex chars = 256 bits) as the generator; a weak key
// would turn the (correct) `safeEqual` defense against timing enumeration into
// theatre. MIN 32 admits `openssl rand -hex 16` (32 chars, still 128 bits, well
// above any realistic brute-force horizon) while rejecting the weak literals an
// operator would type in a hurry. The constant is intentionally not exported:
// rotating it later is a one-line edit here.
const MCP_ACCESS_KEY_MIN_LENGTH = 32;

function requireMinLength(name: string, value: string, min: number): string {
  if (value.length < min) {
    throw new Error(
      `${name} must be at least ${min} characters (got ${value.length}). ` +
        `Generate with: openssl rand -hex 32`,
    );
  }
  return value;
}

// null ⇒ x-brain-key door disabled. A blank/unset env var disables it; a set
// value must clear the min-length floor. `ENABLE_BRAIN_KEY` is the toggle the
// rest of the server reads — see the "at least one auth door" guard below.
const rawBrainKey = optionalTrimmed("MCP_ACCESS_KEY");
export const MCP_ACCESS_KEY: string | null = rawBrainKey
  ? requireMinLength("MCP_ACCESS_KEY", rawBrainKey, MCP_ACCESS_KEY_MIN_LENGTH)
  : null;
export const ENABLE_BRAIN_KEY = MCP_ACCESS_KEY !== null;

// Neither the static x-brain-key nor a native token label is a principal.
// Personal memory is therefore disabled on that door unless the operator
// explicitly binds the whole deployment to one stable server-trusted subject.
// This value is never read from caller input and does not alter metadata.sub
// (which remains null for every tailnet/native-door capture).
export const MCP_ACCESS_KEY_PRINCIPAL = optionalTrimmed(
  "MCP_ACCESS_KEY_PRINCIPAL",
);
if (MCP_ACCESS_KEY_PRINCIPAL.length > 1024) {
  throw new Error("MCP_ACCESS_KEY_PRINCIPAL must be at most 1024 characters");
}
if (
  MCP_ACCESS_KEY_PRINCIPAL && !ENABLE_BRAIN_KEY && !ENABLE_NATIVE_TOKENS
) {
  throw new Error(
    "MCP_ACCESS_KEY_PRINCIPAL requires MCP_ACCESS_KEY or ENABLE_NATIVE_TOKENS=true; refusing an unused principal binding",
  );
}
export const PORT = requiredInt("PORT", 8787);

// Auth0 OAuth resource-server config. The three vars below have a tri-state
// contract: all three set → OAuth door is enabled; all three empty → OAuth door
// is off (the deployment must then have the x-brain-key door on — see the "at
// least one auth door" guard below); any partial state (1 or 2 set) throws below.
// Audience MUST match the API Identifier in Auth0 byte-for-byte — it's
// immutable, so a mismatch means recreating the API. See the Caddyfile for
// the matching reverse-proxy wiring on the Funnel socket.
export const AUTH0_ISSUER = optionalTrimmed("AUTH0_ISSUER");
export const AUTH0_JWKS_URI = optionalTrimmed("AUTH0_JWKS_URI");
export const AUTH0_AUDIENCE = optionalTrimmed("AUTH0_AUDIENCE");
export const ENABLE_OAUTH = Boolean(
  AUTH0_ISSUER && AUTH0_JWKS_URI && AUTH0_AUDIENCE,
);

// Fail fast on partial config — silently disabling OAuth when 2 of 3 vars are
// set would lead to opaque-token / aud-mismatch failures that are hard to
// diagnose from the client side.
if ((AUTH0_ISSUER || AUTH0_JWKS_URI || AUTH0_AUDIENCE) && !ENABLE_OAUTH) {
  throw new Error(
    "Partial Auth0 config: AUTH0_ISSUER, AUTH0_JWKS_URI, and AUTH0_AUDIENCE must all be set together (or all empty to leave the OAuth door off).",
  );
}

// Auth0's default access-token profile identifies client-credentials tokens
// with the signed `gty = "client-credentials"` claim. Its RFC 9068 profile and
// many other issuers provide no grant-type claim even when the JWT is otherwise
// valid. This optional exact-subject allowlist supplies that fallback.
//
// It changes attribution only, never authentication or authorization: every
// token still has to pass signature/issuer/audience/algorithm/exp/sub checks,
// and the verified `sub` remains the RLS principal. Values are not logged.
function oauthServiceAccountSubjects(): ReadonlySet<string> {
  const raw = optionalTrimmed("OAUTH_SERVICE_ACCOUNT_SUBJECTS");
  if (!raw) return new Set();

  const entries = raw.split(",").map((value) => value.trim());
  if (entries.some((value) => !value)) {
    throw new Error(
      "OAUTH_SERVICE_ACCOUNT_SUBJECTS must be a comma-separated list of non-empty exact JWT subjects",
    );
  }
  if (entries.length > 256) {
    throw new Error(
      "OAUTH_SERVICE_ACCOUNT_SUBJECTS must contain at most 256 subjects",
    );
  }

  const subjects = new Set<string>();
  for (const entry of entries) {
    const subject = noControlCharacters(
      "OAUTH_SERVICE_ACCOUNT_SUBJECTS entry",
      entry,
      1024,
    );
    if (subjects.has(subject)) {
      throw new Error(
        "OAUTH_SERVICE_ACCOUNT_SUBJECTS must not contain duplicate subjects",
      );
    }
    subjects.add(subject);
  }
  return subjects;
}

export const OAUTH_SERVICE_ACCOUNT_SUBJECTS = oauthServiceAccountSubjects();
if (OAUTH_SERVICE_ACCOUNT_SUBJECTS.size > 0 && !ENABLE_OAUTH) {
  throw new Error(
    "OAUTH_SERVICE_ACCOUNT_SUBJECTS requires the OAuth door (all three AUTH0_* variables)",
  );
}

// At least one auth door must be enabled. With MCP_ACCESS_KEY, native-token
// verification, and AUTH0_* (OAuth) all optional, a deployment with none would
// boot wide open — refuse that. compose-local enables native tokens; Funnel +
// Qubes deployments set AUTH0_*. (This replaces the old PATTERN_B guard, whose
// only job was to stop a leaked x-brain-key going public over the funnel — moot
// now that funnel deployments carry no x-brain-key. Keeping Caddy as the sole
// entry point — not publishing mcp's raw host port — is now a deployment-hygiene
// measure handled by the compose override structure + docs, not a boot check.)
if (!ENABLE_BRAIN_KEY && !ENABLE_NATIVE_TOKENS && !ENABLE_OAUTH) {
  throw new Error(
    "No auth door configured: set MCP_ACCESS_KEY and/or " +
      "ENABLE_NATIVE_TOKENS=true (non-OIDC x-brain-key door — e.g. the " +
      "compose-local single-box install), and/or all three AUTH0_* vars " +
      "(OAuth door — used by the funnel + Qubes deployments). Refusing to " +
      "start with no authentication.",
  );
}

// Validate URL shape at boot — `new URL(...)` constructors in auth.ts (for
// the metadata derivation and the JWKS fetch) throw on malformed inputs.
// Catching here gives a clear "your config is wrong" message at startup
// instead of a generic TypeError at the first request. Additionally enforce
// https: — the JWKS endpoint fetches signing keys we then trust, so it
// MUST be over a server-authenticated channel, and the issuer + audience
// are advertised in 401 WWW-Authenticate replies so they shouldn't
// downgrade clients to cleartext.
if (ENABLE_OAUTH) {
  for (
    const [name, value] of [
      ["AUTH0_ISSUER", AUTH0_ISSUER],
      ["AUTH0_JWKS_URI", AUTH0_JWKS_URI],
      ["AUTH0_AUDIENCE", AUTH0_AUDIENCE],
    ] as const
  ) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `Invalid URL in env var ${name}: "${value}". Must be an absolute URL with a scheme (https://...).`,
      );
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        `Insecure scheme in env var ${name}: "${value}". OAuth trust-root URLs must use https:.`,
      );
    }
  }
}

// CITATION_BASE_URL is used to mint per-thought URLs in the ChatGPT-compat
// search/fetch tools. Set it to your tailnet hostname (e.g.
// https://homebox.tailnet-name.ts.net/thoughts). The placeholder default
// won't resolve to anything useful — operators should override it.
export const CITATION_BASE_URL = optionalTrimmed("CITATION_BASE_URL") ||
  "https://openbrain.local/thoughts";

// Outbound fetch timeout for Ollama embeddings. 15 seconds is long enough
// for a slow first-load embed model warm-up and short enough that a hung
// backend can't tie up an MCP request indefinitely. (The chat-LLM metadata
// call has its own knob — CHAT_TIMEOUT_MS below.)
export const FETCH_TIMEOUT_MS = requiredInt(
  "FETCH_TIMEOUT_MS",
  15_000,
  MAX_TIMER_DELAY_MS,
);

// Separate, longer cap for the optional chat-LLM metadata extraction call.
// A chat completion over a large captured thought can legitimately take far
// longer than an embedding — gating both on FETCH_TIMEOUT_MS silently
// truncated extraction on slow local models.
export const CHAT_TIMEOUT_MS = requiredInt(
  "CHAT_TIMEOUT_MS",
  60_000,
  MAX_TIMER_DELAY_MS,
);

// Wall-clock cap on JWKS fetches. Two surfaces:
//   1. Passed to jose's `createRemoteJWKSet` as `timeoutDuration`, bounding
//      every per-request JWKS refresh (jose's default is 5_000 ms; we set
//      it explicitly so the value is auditable from a single source).
//   2. Bounds the boot-time JWKS reachability probe (also in auth.ts).
// 10 seconds is generous for Auth0's globally-distributed JWKS endpoint
// over a typical home connection while staying short enough that a hung
// upstream can't pin a request slot. Operators with degraded upstream
// connectivity can raise via the env var; production deploys can leave
// the default.
export const JWKS_FETCH_TIMEOUT_MS = requiredInt(
  "JWKS_FETCH_TIMEOUT_MS",
  10_000,
  MAX_TIMER_DELAY_MS,
);

// Overall deadline for the boot-time Postgres reachability probe (wired in
// db.ts, implemented in db_boot_probe.ts). Needed because deno-postgres has
// no client-side connect timeout: against an endpoint that accepts TCP but
// never completes the handshake, the pool's init promise never settles, and
// without this cap the top-level-awaited probe would hang boot forever — a
// state the compose restart policy cannot see (it reacts to exits, not
// hangs). On deadline the server exits 1 with the same operator guidance as
// a refused connection. Keep this above the probe's 10s slow-connect warning
// so the warning retains a window to fire. Raise it for databases that are
// legitimately slow to accept connections at boot.
export const DB_BOOT_PROBE_TIMEOUT_MS = requiredInt(
  "DB_BOOT_PROBE_TIMEOUT_MS",
  30_000,
  MAX_TIMER_DELAY_MS,
);
