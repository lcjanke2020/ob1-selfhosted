import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

// Hono request-context variables set by `requireAuth` after a
// successful authentication. Downstream handlers read these to attribute
// captures to the door of origin and (for OAuth) the JWT subject. Tool
// handlers receive them as a closure argument via createMcpServer({door,sub})
// rather than via Hono context directly, because the @modelcontextprotocol/sdk
// tool callbacks are not Hono-context-aware.
//   - door:  "tailnet" when authenticated via x-brain-key;
//            "funnel"  when authenticated via Auth0 Bearer (JWT).
//   - sub:   null on x-brain-key (shared tailnet credential, no per-user id);
//            the verified JWT `sub` claim on Bearer (guaranteed present —
//            see `verifyBearer` below, which puts "sub" in jose's requiredClaims).
export type AppVariables = { door: "funnel" | "tailnet"; sub: string | null };

import {
  AUTH0_AUDIENCE,
  AUTH0_ISSUER,
  AUTH0_JWKS_URI,
  ENABLE_BRAIN_KEY,
  ENABLE_OAUTH,
  JWKS_FETCH_TIMEOUT_MS,
  MCP_ACCESS_KEY,
} from "./config.ts";
import { type AuthFailureReason, logAuthFailure } from "./auth_audit.ts";
import { parseInetCandidate } from "./inet.ts";

// Best-effort source-IP extraction for the audit emitter. Caddy
// forwards the original client IP in X-Forwarded-For; we take the first
// hop (closest to the client) and discard the rest, since the rest are
// our proxies. Returns undefined if the header is missing, blank, or
// can't be normalised to a parseable INET — the audit row's client_ip
// column will be NULL in that case, which happens legitimately in dev
// (single-port, no Caddy in front) AND when a misconfigured proxy
// emits `unknown` / a bare port / garbage. The Postgres column is
// typed `inet`, so feeding it a non-INET string would fail the cast
// and silently drop the audit row from the caller's perspective.
function clientIpFor(c: Context): string | undefined {
  const xff = c.req.header("x-forwarded-for");
  if (!xff) return undefined;
  const first = xff.split(",")[0];
  return parseInetCandidate(first);
}

// Constant-time comparison so timing attacks can't enumerate the key one byte
// at a time. The loop always runs `expected.length` iterations regardless of
// the provided value's length, and any length mismatch is folded into the
// diff accumulator instead of short-circuiting. `charCodeAt` returns NaN past
// the end of a string; `| 0` coerces that to 0, so length-mismatched inputs
// still XOR cleanly without an early return that would leak length.
function safeEqual(provided: string, expected: string): boolean {
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (provided.charCodeAt(i) | 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// JWKS set is created once at module load when OAuth is enabled. `jose`
// caches keys internally (default 10min max age, 30s cooldown between
// refreshes) so we don't hit Auth0 on every request.
//
// Explicit `timeoutDuration` on the JWKS set bounds every
// per-request JWKS refresh; jose defaults to 5 s but the explicit value
// keeps `JWKS_FETCH_TIMEOUT_MS` as the single source of truth (the same
// constant gates the boot-time probe immediately below). Without an
// explicit bound, a hung Auth0 endpoint would tie up every in-flight
// Bearer verification past the implicit cooldown window.
const jwks = ENABLE_OAUTH
  ? createRemoteJWKSet(new URL(AUTH0_JWKS_URI), {
    timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
  })
  : null;

// Boot-time JWKS reachability probe.
//
// `createRemoteJWKSet` is lazy: it does not fetch until the first Bearer
// verification arrives. Two failure modes that lets through silently:
//
//   1. **Typo'd `AUTH0_JWKS_URI`**. A wrong tenant subdomain
//      (`my-tenant.us.auth0.com` vs `my-tenant.eu.auth0.com`) passes
//      the boot-time URL-shape check (config.ts validates parse + https:
//      but not reachability). Operator sees green logs, then the first
//      legitimate Bearer request fails with an opaque verify error.
//
//   2. **JWKS endpoint serves non-JWKS content.** Reverse-proxy or CDN
//      misconfiguration that returns HTML/HTTP 404/etc. would fool a
//      lazy check the same way.
//
// Fix: at module load (only when OAuth is enabled), do a single
// best-effort fetch of the JWKS URI bounded by `JWKS_FETCH_TIMEOUT_MS`.
// Verify HTTP 200 and a JSON body with a `keys` array. On failure,
// throw — the operator wants the misconfiguration surfaced now, not
// at the first attacker probe (or the first real Bearer request).
//
// Why throw rather than warn: this code path only runs when the
// operator has explicitly opted into OAuth (all three AUTH0_* set).
// A misconfigured JWKS_URI is then a misconfigured Funnel door —
// fail-fast is correct. Transient Auth0 outages will get retried by
// the deploy supervisor (compose `restart: unless-stopped`).
// Exported for direct unit tests (auth_jwks_boot_probe_test.ts). Production
// callers should rely on the module-load `if (ENABLE_OAUTH)` block below.
export async function probeJwksReachability(
  url: string,
  timeoutMs: number,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `JWKS boot probe failed to reach ${url} within ${timeoutMs}ms: ${reason}. ` +
        `Check AUTH0_JWKS_URI for typos (tenant region, subdomain) and ` +
        `confirm outbound HTTPS to Auth0 is permitted.`,
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `JWKS boot probe got HTTP ${res.status} from ${url}. ` +
        `Expected 200 with a {keys: [...]} JSON body. ` +
        `Check AUTH0_JWKS_URI — a typo or stale tenant URL will land here.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `JWKS boot probe got non-JSON response from ${url}: ${reason}. ` +
        `Expected a {keys: [...]} JSON body. A 200 OK with HTML usually ` +
        `means a reverse-proxy or CDN is intercepting the request.`,
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { keys?: unknown }).keys)
  ) {
    throw new Error(
      `JWKS boot probe got malformed body from ${url}: missing 'keys' array. ` +
        `Confirm AUTH0_JWKS_URI points at the standard /.well-known/jwks.json ` +
        `endpoint.`,
    );
  }
  // Empty `keys` is unusual but can occur briefly during a rotation;
  // we don't fail fast on it — jose's lazy verify will retry the
  // fetch and the supervisor will restart on a sustained outage.
}

if (ENABLE_OAUTH) {
  await probeJwksReachability(AUTH0_JWKS_URI, JWKS_FETCH_TIMEOUT_MS);
}

// Per RFC 9728 §3.1, the well-known URI is formed by inserting
// "/.well-known/oauth-protected-resource" between the host component and the
// path component of the resource identifier. So `https://host:8443/mcp`
// publishes metadata at
// `https://host:8443/.well-known/oauth-protected-resource/mcp`, NOT at the
// origin root. AUTH0_AUDIENCE is the resource URL; deriving from it keeps
// the public host + path as single-source-of-truth.
export function deriveProtectedResourceMetadata(
  resource: string,
): { url: string; path: string } {
  const u = new URL(resource);
  // Root-only path → empty suffix; `/mcp` and `/mcp/` both → `/mcp`.
  const resourcePath = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  u.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  u.search = "";
  u.hash = "";
  return { url: u.toString(), path: u.pathname };
}

const metadata = ENABLE_OAUTH
  ? deriveProtectedResourceMetadata(AUTH0_AUDIENCE)
  : null;

export const PROTECTED_RESOURCE_METADATA_URL: string | null = metadata?.url ??
  null;

// Path component of the metadata URL, for Hono route mounting in index.ts.
export const PROTECTED_RESOURCE_METADATA_PATH: string | null = metadata?.path ??
  null;

// Returns false when the x-brain-key door is disabled (MCP_ACCESS_KEY unset) so
// a presented header is simply ignored on Auth0-only deployments rather than
// ever matching. Callers also gate on ENABLE_BRAIN_KEY, but the null guard here
// keeps the type honest and the function safe in isolation.
function checkBrainKey(provided: string | undefined): boolean {
  if (!provided || MCP_ACCESS_KEY === null) return false;
  return safeEqual(provided, MCP_ACCESS_KEY);
}

async function verifyBearer(token: string): Promise<JWTPayload> {
  if (!jwks) throw new Error("OAuth not enabled");
  // `requiredClaims: ["exp"]` forces the token to carry an
  // expiration claim. jose's default behavior validates `exp` only when
  // it is present; a token minted without `exp` therefore passes
  // unconditionally despite the Funnel trust boundary advertising
  // exp + iss + aud + sig as the four invariants. RFC 7519 §4.1.4
  // makes `exp` optional at the protocol layer, so the burden is on
  // the resource server to demand it.
  //
  // "sub" added to requiredClaims for the same reason: Auth0
  // issues `sub` on every token it mints (user JWTs and M2M alike), so
  // its absence indicates either a misconfigured AS or a forged/replayed
  // token. The source-marker work persists `sub` into thoughts.metadata
  // for per-user attribution on the Funnel/mobile capture path; pushing
  // the check into jose here is cleaner than a runtime null-check
  // downstream and fails closed via the existing 401-on-throw flow.
  const { payload } = await jwtVerify(token, jwks, {
    issuer: AUTH0_ISSUER,
    audience: AUTH0_AUDIENCE,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub"],
  });
  return payload;
}

// JSON-RPC error code for unauthorized requests. Per JSON-RPC
// 2.0 §5.1, the range -32099..-32000 is reserved for implementation-
// defined server errors; -32001 is the conventional "unauthorized" code
// MCP clients recognize.
//
// Why HTTP 200 + JSON-RPC envelope, not bare HTTP 401 (with the missing-credentials
// carve-out for missing_credentials below): strict MCP hosts (Codex CLI,
// Claude Code, claude.ai / Claude Mobile) treat 4xx on an established
// MCP transport as a transport-level fault and tear the connection down
// rather than surfacing the error to the application layer. Wrapping
// auth rejection in a JSON-RPC error keeps a long-lived session alive
// so the client can recover (prompt for a new key, refetch a stale
// cache, ...). The missing_credentials path is carved out because
// it's the OAuth-discovery pre-probe — no session is established yet —
// where claude.ai's connector validator requires the RFC 6750 401
// signal to proceed with the OAuth dance.
// Adapted from upstream NateBJones-Projects/OB1@a42695f.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

// Hard cap on the body we'll buffer just to extract a JSON-RPC `id` from
// an unauthorized request. Caddy is the primary body-size enforcer in
// the production topology  but on dev / single-port runs we
// have no edge — this cap is defense in depth so an attacker can't make
// us buffer an arbitrarily large body on the auth-failure path. 64 KiB
// is well above any legitimate JSON-RPC request and well below any DoS
// threshold. This is a hardening over the upstream port (which has no
// cap); see PR body for rationale.
const MAX_BODY_FOR_ID_EXTRACTION_BYTES = 64 * 1024;

// Wall-clock cap on how long we'll wait for the request body to
// complete before giving up on id extraction. Bounds *time* the way
// MAX_BODY_FOR_ID_EXTRACTION_BYTES bounds *memory* — together they
// stop a slow-trickle attacker from holding an auth-failed request
// slot open under the size cap (chunked encoding, dribbled bytes, ...).
// Default 2 s is generous for a well-formed JSON-RPC request whose
// headers already arrived and tight enough that a deliberately-slow
// client can't pin resources. `AUTH_BODY_READ_TIMEOUT_MS` env var is
// the tuning knob — left unset in production; tests override it down
// to ~150 ms so the slow-stream regression test runs quickly.
function parseAuthBodyReadTimeoutMs(raw: string | undefined): number {
  if (!raw) return 2000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 2000;
  return n;
}
const BODY_READ_TIMEOUT_MS = parseAuthBodyReadTimeoutMs(
  Deno.env.get("AUTH_BODY_READ_TIMEOUT_MS"),
);

// Methods we choose not to read a body for. HTTP technically permits a
// request body on GET/DELETE/OPTIONS (semantics are undefined / largely
// ignored by intermediaries), but JSON-RPC over MCP only uses POST, so
// reading on the others would only ever waste cycles and risk holding
// the connection open on auth-fail. HEAD per spec must have no body.
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS"]);

// Read up to MAX_BODY_FOR_ID_EXTRACTION_BYTES of the request body as
// text, bounded by BODY_READ_TIMEOUT_MS. Returns null when the body is
// missing, exceeds the cap (Content-Length or discovered mid-stream
// under chunked encoding), times out, or read fails. Caller falls back
// to id: null. Always cancels the upstream stream on early exit so
// the client doesn't continue uploading into a slot we've abandoned.
async function readBodyForJsonRpcId(req: Request): Promise<string | null> {
  if (BODYLESS_METHODS.has(req.method)) return null;
  const body = req.body;
  if (!body) return null;
  const cl = req.headers.get("content-length");
  if (cl) {
    const n = Number.parseInt(cl, 10);
    if (Number.isFinite(n) && n > MAX_BODY_FOR_ID_EXTRACTION_BYTES) {
      // Stop the client from continuing to upload. Cancel propagates
      // a HTTP/2 RST_STREAM (or HTTP/1.1 connection close) upstream.
      try {
        await body.cancel();
      } catch {
        // ignore — best-effort
      }
      return null;
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  // Time-bound the stream read. On timeout we cancel the reader, which
  // causes the in-flight `reader.read()` to settle (typically as a
  // rejection with the cancellation reason). The catch below handles
  // both that path and any other stream-level error uniformly.
  const timer = setTimeout(() => {
    reader.cancel("body-read timed out").catch(() => {
      // already cancelled / released — ignore
    });
  }, BODY_READ_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_BODY_FOR_ID_EXTRACTION_BYTES) {
        try {
          await reader.cancel("body exceeded cap");
        } catch {
          // already cancelled / released — ignore
        }
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort extraction of the JSON-RPC `id` from a raw request body.
// Per JSON-RPC 2.0 §4, id may be a string, number, or null; preserve
// any of those, fall back to null on parse failure or unsupported types.
function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // malformed body — fall through to id: null
  }
  return null;
}

// Auth-failure response for `require_auth` (mounted on /mcp + /), which speaks
// MCP. The shape depends on whether any credential was actually offered:
//
//   - A request that DID try a credential (`invalid_credentials`,
//     `invalid_brain_key`, `token_validation_failed`) gets HTTP 200 with a
//     JSON-RPC 2.0 error envelope (code -32001). The application-layer error
//     keeps the long-lived MCP transport up so strict clients (claude.ai,
//     Claude Mobile, Codex CLI, Claude Code) can surface the failure and
//     recover (prompt for a new key, refetch a stale cache) without tearing
//     down the connection.
//
//   - A request with NO credential at all (`missing_credentials`) gets HTTP 401
//     with the same JSON-RPC envelope body. This is the RFC 6750 / MCP-
//     Authorization-spec "auth required" signal claude.ai's connector-validation
//     client expects on a pre-OAuth probe; HTTP 200 there made it report the
//     connector as broken even after a successful OAuth dance. The keep-alive
//     rationale only applies once a session is established and creds were tried —
//     a pre-auth probe has no session to preserve, so RFC compliance wins.
//     WWW-Authenticate still carries the resource_metadata URL on this path.
//
// All paths emit WWW-Authenticate when OAuth is enabled (OAuth-aware clients use
// it for AS discovery per RFC 9728), set `Cache-Control: no-store`, and fire the
// audit row. The envelope's JSON-RPC `error.message` is a neutral
// "Unauthorized: missing or invalid authentication." — opaque w.r.t. which
// credential failed (the side-channel we deliberately close). The distinguishing
// AuthFailureReason is preserved internally via logAuthFailure() for audit.
//
// (`/ready` no longer goes through this path: it is unauthenticated and kept off
// the public funnel branch by Caddy — see index.ts and the Caddyfile.)
async function unauthorized(
  c: Context,
  code: AuthFailureReason,
) {
  if (PROTECTED_RESOURCE_METADATA_URL) {
    c.header(
      "WWW-Authenticate",
      `Bearer realm="open-brain", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
    );
  }
  // The envelope path returns HTTP 200, which a naive cache could
  // store and serve to a later (potentially authorized) request from
  // the same URL — leaking the cached "unauthorized" body in place of
  // the real response. `Cache-Control: no-store` (RFC 9111 §5.2.2.5)
  // prevents any storage. The bare-401 path gets the same header for
  // consistency; per RFC 9111 a 401 isn't cacheable by default anyway
  // but explicit beats implicit.
  c.header("Cache-Control", "no-store");
  logAuthFailure({
    reason: code,
    middleware: "require_auth",
    clientIp: clientIpFor(c),
    path: c.req.path,
  });

  // MCP path → JSON-RPC envelope. Extract the inbound id so strict-MCP
  // clients can correlate. Safe to consume the body here because
  // auth-fail short-circuits — no downstream handler runs.
  const bodyText = await readBodyForJsonRpcId(c.req.raw);
  const id = extractJsonRpcId(bodyText);
  // Missing credentials get HTTP 401 (RFC 6750 auth-required
  // signal) so claude.ai's MCP connector-validation client proceeds with
  // OAuth discovery. Tried-but-failed credentials keep HTTP 200 so
  // long-lived MCP transports stay up. Body shape is identical across
  // both statuses — only the transport-layer signal differs.
  const status = code === "missing_credentials" ? 401 : 200;
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: JSON_RPC_UNAUTHORIZED_CODE,
        message: UNAUTHORIZED_MESSAGE,
      },
      id,
    },
    status,
  );
}

// Accepts the x-brain-key door (when enabled, MCP_ACCESS_KEY set) OR
// Authorization: Bearer with a valid Auth0 RS256 JWT (OAuth door, when enabled).
// Which doors are live is per-deployment: compose-local enables x-brain-key only;
// the funnel + Qubes deployments enable OAuth only. The reverse proxy in front of
// a publicly-reachable deployment additionally strips the inapplicable header per
// socket, but this middleware is the load-bearing check — it works equally well
// behind a single-port deployment with no proxy.
//
// Short-circuit policy: when the x-brain-key door is OFF the header is ignored
// entirely (falls straight through to Bearer). When it's ON, an invalid
// x-brain-key still falls through to Bearer rather than 401'ing immediately, so a
// request carrying BOTH headers authenticates if EITHER is valid — an attacker
// who could attach a stale x-brain-key can't suppress a valid Bearer in the same
// request.
export const requireAuth: MiddlewareHandler<{ Variables: AppVariables }> =
  async (c, next) => {
    // x-brain-key fast path — cheaper than JWT crypto, but only short-circuit
    // on success, and only when the door is enabled. Failure / disabled falls
    // through to the Bearer attempt below.
    const brainKey = c.req.header("x-brain-key");
    if (ENABLE_BRAIN_KEY && brainKey && checkBrainKey(brainKey)) {
      // tag the tailnet door. The shared x-brain-key is not a
      // per-user identity (every tailnet agent uses the same secret), so
      // sub is null here. Downstream capture path stamps these into
      // thoughts.metadata for the source-attribution "mobile-originated
      // writes" dashboard tile (which discriminates funnel vs tailnet).
      c.set("door", "tailnet");
      c.set("sub", null);
      await next();
      return;
    }

    let bearerTried = false;
    if (ENABLE_OAUTH) {
      const authz = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(authz);
      if (m) {
        bearerTried = true;
        try {
          // capture the verified payload's `sub` claim and tag
          // the funnel door. `verifyBearer` now requires `sub` via jose's
          // requiredClaims (see above), so payload.sub is guaranteed
          // non-undefined here; the non-null assertion is a type narrow,
          // not a runtime gamble. the single-vs-dual-door decision (deliberately open)
          // remains separate scope — the source-marker work doesn't
          // depend on either outcome of that deliberation.
          const payload = await verifyBearer(m[1].trim());
          c.set("door", "funnel");
          c.set("sub", payload.sub!);
          await next();
          return;
        } catch (_err) {
          // Fall through to 401 with a token-validation reason below.
        }
      }
    }

    // Operator-facing message is collapsed (no credential-status side-channel), but the distinguishing
    // reason code is preserved for the audit row so we keep granular visibility
    // into which auth path failed.
    // Only count the x-brain-key as "tried" when the door is enabled — on an
    // Auth0-only deployment a presented x-brain-key is ignored, so a request
    // with only that header reads as missing_credentials (the honest signal:
    // no credential this server accepts was offered).
    const brainKeyTried = ENABLE_BRAIN_KEY && brainKey !== undefined &&
      brainKey !== "";
    let code: AuthFailureReason;
    if (brainKeyTried && bearerTried) code = "invalid_credentials";
    else if (brainKeyTried) code = "invalid_brain_key";
    else if (bearerTried) code = "token_validation_failed";
    else code = "missing_credentials";

    return unauthorized(c, code);
  };

// Public metadata endpoint per RFC 9728. Wired in index.ts only when
// ENABLE_OAUTH is true — no point advertising an authorization server when
// we don't accept its tokens.
export function protectedResourceMetadata(c: Context) {
  return c.json({
    resource: AUTH0_AUDIENCE,
    authorization_servers: [AUTH0_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });
}
