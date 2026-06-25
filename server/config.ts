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

function requiredInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid integer env var ${name}: "${raw}"`);
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
// is attempted ONLY when ENABLE_PRIMARY_EXTRACTION is set EXACTLY to "true" AND
// the primary endpoint is configured. The opt-in exists so a primary that is
// misconfigured or fronted by a dangerous transport can't fire on the hot
// capture path — e.g. a qrexec forwarder whose call would auto-start a downed
// GPU qube. Set to "true" only once the primary endpoint is known-good.
const PRIMARY_EXTRACTION_OPT_IN =
  optionalTrimmed("ENABLE_PRIMARY_EXTRACTION").toLowerCase() === "true";
export const ENABLE_PRIMARY_EXTRACTION = Boolean(
  PRIMARY_EXTRACTION_OPT_IN && CHAT_API_BASE && CHAT_MODEL,
);

// Optional FALLBACK chat endpoint, tried when the primary is disabled or fails
// (unreachable, non-2xx, timeout, or unparseable output) before giving up to
// the minimal stub. This lets a local-first primary (e.g. a GPU box that keeps
// thought content on your network) degrade to a hosted OpenAI-compatible model
// instead of losing metadata when that box is down. It is also valid on its
// own: a fallback-only deployment (CHAT_* blank, primary off) classifies via
// this endpoint. Disabled unless BOTH base and model are set. NOT gated by
// ENABLE_PRIMARY_EXTRACTION — that is what makes a fallback-only deployment work.
export const FALLBACK_CHAT_API_BASE = optionalTrimmed("FALLBACK_CHAT_API_BASE");
export const FALLBACK_CHAT_API_KEY = optionalTrimmed("FALLBACK_CHAT_API_KEY");
export const FALLBACK_CHAT_MODEL = optionalTrimmed("FALLBACK_CHAT_MODEL");
export const ENABLE_FALLBACK_EXTRACTION = Boolean(
  FALLBACK_CHAT_API_BASE && FALLBACK_CHAT_MODEL,
);

// Metadata extraction runs when EITHER path is active; with neither configured,
// capture skips classification and stamps the minimal {topics:[uncategorized]}
// stub.
export const ENABLE_METADATA_EXTRACTION = ENABLE_PRIMARY_EXTRACTION ||
  ENABLE_FALLBACK_EXTRACTION;

// MCP_ACCESS_KEY enables the static x-brain-key auth door. It is OPTIONAL:
// set it to turn the x-brain-key path ON (the `compose-local` single-box
// install uses it as its sole auth, for environments where a tailnet / Auth0
// tenant isn't practical), or leave it empty to turn the path OFF entirely so
// the server accepts no x-brain-key at all. The `compose-tailnet` (funnel) and
// `qubes` deployments leave it empty and rely on Auth0 (OAuth) alone — the
// single-door posture recommended for any publicly-reachable install.
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

// At least one auth door must be enabled. With both MCP_ACCESS_KEY (x-brain-key)
// and AUTH0_* (OAuth) now optional, a deployment that configures neither would
// boot wide open — refuse that. compose-local sets MCP_ACCESS_KEY; the funnel +
// Qubes deployments set AUTH0_*. (This replaces the old PATTERN_B guard, whose
// only job was to stop a leaked x-brain-key going public over the funnel — moot
// now that funnel deployments carry no x-brain-key. Keeping Caddy as the sole
// entry point — not publishing mcp's raw host port — is now a deployment-hygiene
// measure handled by the compose override structure + docs, not a boot check.)
if (!ENABLE_BRAIN_KEY && !ENABLE_OAUTH) {
  throw new Error(
    "No auth door configured: set MCP_ACCESS_KEY (x-brain-key door — e.g. the " +
      "compose-local single-box install) and/or all three AUTH0_* vars (OAuth " +
      "door — used by the funnel + Qubes deployments). Refusing to start with " +
      "no authentication.",
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
export const FETCH_TIMEOUT_MS = requiredInt("FETCH_TIMEOUT_MS", 15_000);

// Separate, longer cap for the optional chat-LLM metadata extraction call.
// A chat completion over a large captured thought can legitimately take far
// longer than an embedding — gating both on FETCH_TIMEOUT_MS silently
// truncated extraction on slow local models.
export const CHAT_TIMEOUT_MS = requiredInt("CHAT_TIMEOUT_MS", 60_000);

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
);
