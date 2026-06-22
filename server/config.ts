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

// MCP_ACCESS_KEY is the only credential between any tailnet member
// (and, once Funnel is on, the public internet) and full read/write to every
// captured thought. `.env.example` documents `openssl rand -hex 32` (64 hex
// chars = 256 bits of entropy) as the recommended generator, but `required()`
// alone accepts any non-empty value — so a typo'd `password` / `dev` / `test`
// passes validation, and a weak key turns the (correct) `safeEqual` defense
// against timing enumeration into theatre. Enforce a minimum length at boot.
//
// MIN length 32 admits both the recommended `openssl rand -hex 32` output
// (64 chars) and `-hex 16` (32 chars — still 128 bits, well above any
// realistic brute-force horizon) while rejecting the weak literals an
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

export const MCP_ACCESS_KEY = requireMinLength(
  "MCP_ACCESS_KEY",
  required("MCP_ACCESS_KEY"),
  MCP_ACCESS_KEY_MIN_LENGTH,
);
export const PORT = requiredInt("PORT", 8787);

// Auth0 OAuth resource-server config. The three vars below have a tri-state
// contract: all three empty → server runs in x-brain-key-only mode; all three
// set → OAuth path is enabled; any partial state (1 or 2 set) throws below.
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
    "Partial Auth0 config: AUTH0_ISSUER, AUTH0_JWKS_URI, and AUTH0_AUDIENCE must all be set together (or all empty for x-brain-key-only deployments).",
  );
}

// Pattern B is the compose-mode that REMOVES mcp's host port
// mapping so caddy is the only entry point and the Caddyfile header-strip
// boundary is enforced. The override (docker-compose.pattern-b.yml) sets
// PATTERN_B=true in the mcp container's env, so this server can verify
// the operator actually loaded the override file — not just the
// `--profile pattern-b` flag.
//
// Without this check, an operator who sets AUTH0_* in .env but only runs
// `docker compose --profile pattern-b up -d` (without
// `-f docker-compose.pattern-b.yml`) lands in a half-configured state:
// caddy starts, BUT mcp's host port stays published. A stray
// `tailscale funnel http://127.0.0.1:8787` would then bypass the
// Caddyfile header-strip boundary entirely, turning a leaked
// x-brain-key into a public route.
//
// Constraint: ENABLE_OAUTH implies PATTERN_B. The other direction
// (PATTERN_B without OAuth) is allowed — it's just an extra env var
// with no behavioral effect, useful for parity in dev rigs that mirror
// the compose override without enabling Auth0.
const PATTERN_B = Deno.env.get("PATTERN_B")?.trim().toLowerCase() === "true";

if (ENABLE_OAUTH && !PATTERN_B) {
  throw new Error(
    "OAuth is enabled (AUTH0_* set) but PATTERN_B is not. " +
      "Pattern B requires BOTH the compose override " +
      "(-f docker-compose.pattern-b.yml) AND the --profile pattern-b " +
      "flag — the override sets PATTERN_B=true on the mcp container. " +
      "If you used --profile pattern-b without the override file, mcp's " +
      "host port (127.0.0.1:8787) is still published and a misconfigured " +
      "`tailscale funnel` would bypass the Caddyfile header-strip " +
      "boundary. Fix: either run `docker compose -f docker-compose.yml " +
      "-f docker-compose.pattern-b.yml --profile pattern-b up -d`, or " +
      "set COMPOSE_FILE and COMPOSE_PROFILES in .env per .env.example so " +
      "a bare `docker compose up -d` does the right thing.",
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
