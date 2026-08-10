// Open Brain MCP server — Homelab + Tailscale variant.
//
// HTTP transport: Streamable HTTP at /mcp, gated by `requireAuth`, which accepts
// whichever auth doors the deployment enabled — native/static x-brain-key
// (compose-local) and/or an Auth0 RS256 Bearer JWT (the OAuth door used by the
// Funnel + Qubes deployments). On a publicly reachable deployment Caddy fronts
// the server (the Anthropic IP allowlist, body cap, access logging with
// credential redaction) but does not strip credentials per branch — the server
// accepts only the door(s) the deployment enabled, so `requireAuth` is the
// load-bearing check and works equally well behind a single-port deployment.
// Storage: vanilla Postgres + pgvector (no @supabase/supabase-js, no auth.uid).
// Embeddings: local Ollama (default model nomic-embed-text, 768 dim).
//
// Architecture is split into queries.ts (pure DB), embeddings.ts (Ollama),
// metadata.ts (optional chat-LLM extraction), metadata_notifications.ts
// (durable degradation delivery), auth.ts (header / JWT checks), mcp-server.ts
// (tool registration factory), and this file (Hono app + Deno serve). A future
// REST gateway, CLI, or dashboard would import queries.ts directly.

import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";
import { authenticateAccessToken } from "./access_tokens.ts";
import { type AuthContext, authContextFromValues } from "./auth_context.ts";

import {
  DB_HOST,
  DB_PORT,
  ENABLE_BRAIN_KEY,
  ENABLE_FALLBACK_EXTRACTION,
  ENABLE_METADATA_EXTRACTION,
  ENABLE_METADATA_NOTIFICATIONS,
  ENABLE_NATIVE_TOKENS,
  ENABLE_OAUTH,
  ENABLE_PRIMARY_EXTRACTION,
  ENABLE_REST_API,
  FALLBACK_CHAT_API_BASE,
  FALLBACK_CHAT_MODEL,
  METADATA_FALLBACK_POLICY,
  METADATA_NOTIFY_CHANNELS,
  METADATA_NOTIFY_LABEL,
  METADATA_NOTIFY_POLL_INTERVAL_MS,
  METADATA_NOTIFY_ROLLUP_MS,
  METADATA_NOTIFY_TIMEOUT_MS,
  METADATA_NTFY_SERVER_URL,
  METADATA_NTFY_TOKEN,
  METADATA_NTFY_TOPIC,
  METADATA_PUSHOVER_APP_TOKEN,
  METADATA_PUSHOVER_USER_KEY,
  OAUTH_ALLOWED_SUBJECTS,
  OAUTH_SERVICE_ACCOUNT_SUBJECTS,
  PORT,
} from "./config.ts";
import { createApiRouter } from "./api.ts";
import { pool } from "./db.ts";
import {
  type AppVariables,
  createRequireAuth,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
} from "./auth.ts";
import { createMcpServer } from "./mcp-server.ts";
import {
  type MetadataNotificationAdapter,
  NtfyMetadataNotificationAdapter,
  PushoverMetadataNotificationAdapter,
  startMetadataNotificationWorker,
} from "./metadata_notifications.ts";
import { pingDb } from "./queries.ts";
import { readinessResponse } from "./readiness.ts";

// Hono Variables typed so `c.set/c.get` on door/sub/tokenLabel are checked
// at the boundaries (requireAuth sets, /mcp + / handlers get). Without
// this the handler-side `c.get("door")` would be `unknown` and the
// defensive 500-guard's type-narrow would not compile.
const app = new Hono<{ Variables: AppVariables }>();
const requireRequestAuth = createRequireAuth(
  (token) => authenticateAccessToken(pool, token),
);

// Public health endpoint (no auth) — used by docker healthcheck and quick
// curl-from-the-tailnet smoke tests. Does NOT touch the DB to keep it cheap.
// Body is intentionally minimal; the public Funnel path can reach this and
// we don't want to advertise the service identity to drive-by scanners.
app.get("/health", (c) => c.json({ ok: true }));

// Deeper health probe that confirms DB connectivity. Unauthenticated, but
// INTERNAL-ONLY: it reveals whether the DB is reachable, so it must never be
// served over the public funnel. Caddy 404s `/ready` on the funnel branch
// (see the Caddyfile), leaving it reachable only from loopback, the container
// healthcheck, and tailnet-direct/in-qube callers. It is unauthenticated
// because a readiness probe carrying a credential is impractical for uptime
// monitors and the in-container healthcheck — and, with each auth door now
// optional per deployment, there is no single static credential that could gate
// it on an Auth0-only install anyway.
app.get(
  "/ready",
  () =>
    readinessResponse(
      () => pingDb(pool),
      `${DB_HOST}:${DB_PORT}`,
    ),
);

// RFC 9728 Protected Resource Metadata. Wired only when OAuth is enabled —
// no point advertising an authorization server when we don't accept its
// tokens. Path is derived from AUTH0_AUDIENCE by inserting the well-known
// component between host and resource path (see auth.ts), so a resource of
// `https://host/mcp` is served at `/.well-known/oauth-protected-resource/mcp`.
if (PROTECTED_RESOURCE_METADATA_PATH) {
  app.get(PROTECTED_RESOURCE_METADATA_PATH, protectedResourceMetadata);
}

// REST gateway (/api/v1) — same auth doors, same pool, structured JSON
// (see api.ts). Opt-in per deployment: the docker-compose installs set
// ENABLE_REST_API; the Qubes deployment leaves it unset, so on that posture
// the router is never mounted and the surface does not exist. requireAuth is
// mounted inside the router, so the gate travels with it.
if (ENABLE_REST_API) {
  app.route("/api/v1", createApiRouter(pool, undefined, requireRequestAuth));
}

// MCP transport. requireAuth accepts x-brain-key (native/static `tailnet`)
// or Authorization: Bearer with a valid RS256 JWT (OAuth user `funnel` or
// OAuth machine `service`). A new
// McpServer is constructed per request — the SDK's connect() mutates an
// instance-scoped transport reference and is not safe to share under
// concurrent load.
//
// `requireAuth` populates door + sub + tokenLabel on the request-scoped
// Hono context; we read them here and pass to the per-request McpServer
// factory so capture_thought can stamp them into thoughts.metadata.
// The 500-guard is defense in depth: a future refactor that drops the
// `c.set` calls in `requireAuth` would otherwise stuff `door: undefined`
// into the JSONB and silently break the Phase 7 telemetry tile.
function authContextOr500(c: Context<{ Variables: AppVariables }>):
  | AuthContext
  | Response {
  const auth = authContextFromValues(
    c.get("door"),
    c.get("sub"),
    c.get("tokenLabel"),
  );
  if (!auth) {
    return c.json({ error: "auth_context_missing" }, 500);
  }
  return auth;
}

app.all("/mcp", requireRequestAuth, async (c) => {
  const auth = authContextOr500(c);
  if (auth instanceof Response) return auth;
  const transport = new StreamableHTTPTransport();
  const server = createMcpServer(pool, auth);
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Backward-compat: also serve the MCP transport at the root for clients
// that don't add /mcp to the URL.
app.all("/", requireRequestAuth, async (c) => {
  const auth = authContextOr500(c);
  if (auth instanceof Response) return auth;
  const transport = new StreamableHTTPTransport();
  const server = createMcpServer(pool, auth);
  await server.connect(transport);
  return transport.handleRequest(c);
});

console.log(`open-brain-homelab listening on :${PORT}`);

// Auth-door posture at boot. Both doors on is intended only for the loopback /
// LAN single-box install (which may opt into OAuth on top of the static key).
// On a publicly-reachable funnel / Qubes deployment the static x-brain-key door
// should be OFF — warn so an accidental MCP_ACCESS_KEY on a public box is visible
// in the boot log rather than silently widening the attack surface.
if ((ENABLE_BRAIN_KEY || ENABLE_NATIVE_TOKENS) && ENABLE_OAUTH) {
  console.warn(
    "[auth] both x-brain-key AND OAuth doors enabled. Intended for the single-box " +
      "/ LAN install only — on a public funnel/Qubes deployment, unset " +
      "MCP_ACCESS_KEY and disable native tokens so OAuth is the sole path.",
  );
} else if (ENABLE_BRAIN_KEY || ENABLE_NATIVE_TOKENS) {
  console.log(
    `[auth] x-brain-key door only (OAuth off; static key ${
      ENABLE_BRAIN_KEY ? "on" : "off"
    }; rotatable tokens ${ENABLE_NATIVE_TOKENS ? "on" : "off"}). Keep this ` +
      "install on loopback/LAN or a private tailnet.",
  );
} else {
  console.log("[auth] OAuth door only (x-brain-key disabled).");
}

// OAuth authorization posture. The allowlist fails CLOSED (config.ts): an
// enabled OAuth door with an empty OAUTH_ALLOWED_SUBJECTS rejects every
// Bearer at runtime, which on an OAuth-only deployment is a full lockout.
// That is the intended misconfiguration posture — but it must be loud in the
// boot log, not discovered from a mystery wall of 401s. Counts only, never
// subject values: boot logs must not become an identity inventory.
if (ENABLE_OAUTH) {
  if (OAUTH_ALLOWED_SUBJECTS.size === 0) {
    console.warn(
      "[auth] OAuth door enabled but OAUTH_ALLOWED_SUBJECTS is unset/empty — " +
        "EVERY Bearer token will be rejected (fail-closed). Set it to the " +
        "exact `sub` claim(s) you intend to admit.",
    );
  } else {
    const unadmitted = [...OAUTH_SERVICE_ACCOUNT_SUBJECTS].filter(
      (sub) => !OAUTH_ALLOWED_SUBJECTS.has(sub),
    ).length;
    console.log(
      `[auth] OAuth subject allowlist active (${OAUTH_ALLOWED_SUBJECTS.size} ` +
        "subject(s) admitted).",
    );
    if (unadmitted > 0) {
      // OAUTH_SERVICE_ACCOUNT_SUBJECTS is attribution-only and never grants
      // access — a machine subject listed there but absent from the
      // allowlist will be denied. Almost always an upgrade oversight.
      console.warn(
        `[auth] ${unadmitted} OAUTH_SERVICE_ACCOUNT_SUBJECTS entr(y/ies) are ` +
          "NOT in OAUTH_ALLOWED_SUBJECTS and will be denied — that list is " +
          "attribution-only. Add the machine subject(s) to " +
          "OAUTH_ALLOWED_SUBJECTS if those clients should authenticate.",
      );
    }
  }
}

// REST posture, next to the auth posture: an unexpectedly-on gateway should
// be as visible in the boot log as an unexpectedly-open auth door.
if (ENABLE_REST_API) {
  console.log(
    "[rest] REST gateway enabled at /api/v1 (same auth doors as /mcp)",
  );
}

// Announce the metadata-extraction mode at boot so an intentionally disabled
// extractor and a fallback-only deployment (which may be off-box) are obvious
// from the startup log, not just per-capture lines.
// No secrets. "May be off-box" because whether the fallback endpoint is remote
// vs on-LAN depends on the operator's FALLBACK_CHAT_API_BASE.
console.log(`[metadata] fallback policy: ${METADATA_FALLBACK_POLICY}`);
if (!ENABLE_METADATA_EXTRACTION) {
  const fallbackEndpointConfigured = Boolean(
    FALLBACK_CHAT_API_BASE && FALLBACK_CHAT_MODEL,
  );
  if (METADATA_FALLBACK_POLICY === "off" && fallbackEndpointConfigured) {
    console.warn(
      "[metadata] extraction disabled: METADATA_FALLBACK_POLICY=off blocks the configured fallback and no primary is enabled — captures stamp the uncategorized stub",
    );
  } else {
    console.warn(
      "[metadata] extraction disabled (no primary or policy-permitted fallback configured) — captures stamp the uncategorized stub",
    );
  }
} else if (ENABLE_PRIMARY_EXTRACTION && ENABLE_FALLBACK_EXTRACTION) {
  console.log(
    "[metadata] extraction on: primary endpoint, fallback on failure (fallback may be off-box)",
  );
} else if (ENABLE_PRIMARY_EXTRACTION) {
  console.log("[metadata] extraction on: primary endpoint only, no fallback");
} else {
  console.warn(
    "[metadata] extraction on: FALLBACK endpoint only — every capture classifies via the fallback (may be off-box)",
  );
}

const httpServer = Deno.serve({ port: PORT }, app.fetch);

const metadataNotificationAdapters: MetadataNotificationAdapter[] = [];
for (const channel of METADATA_NOTIFY_CHANNELS) {
  if (channel === "pushover") {
    metadataNotificationAdapters.push(
      new PushoverMetadataNotificationAdapter(
        METADATA_PUSHOVER_APP_TOKEN,
        METADATA_PUSHOVER_USER_KEY,
        METADATA_NOTIFY_TIMEOUT_MS,
      ),
    );
  } else {
    metadataNotificationAdapters.push(
      new NtfyMetadataNotificationAdapter(
        METADATA_NTFY_SERVER_URL,
        METADATA_NTFY_TOPIC,
        METADATA_NTFY_TOKEN,
        METADATA_NOTIFY_TIMEOUT_MS,
      ),
    );
  }
}

const metadataNotificationWorker = ENABLE_METADATA_NOTIFICATIONS
  ? startMetadataNotificationWorker(pool, metadataNotificationAdapters, {
    label: METADATA_NOTIFY_LABEL,
    pollIntervalMs: METADATA_NOTIFY_POLL_INTERVAL_MS,
    rollupMs: METADATA_NOTIFY_ROLLUP_MS,
  })
  : null;

if (metadataNotificationWorker) {
  console.log(
    `[metadata_notify] durable notifications enabled via ${
      METADATA_NOTIFY_CHANNELS.join(",")
    }`,
  );
}

// Graceful shutdown — stop accepting new connections, drain in-flight
// requests, then release the DB pool. `docker stop` sends SIGTERM; without
// this, in-flight requests are cut and postgres keeps the abandoned
// connections until its own timeout. Mirrors log_ingester.ts.
const shutdown = async () => {
  console.log(
    "[mcp] shutdown signal received; draining server + worker + pool",
  );
  const cleanupSteps: Array<[string, () => Promise<void>]> = [
    ["http server", () => httpServer.shutdown()],
    ["metadata notification worker", async () => {
      await metadataNotificationWorker?.stop();
    }],
    ["database pool", () => pool.end()],
  ];
  for (const [label, cleanup] of cleanupSteps) {
    try {
      await cleanup();
    } catch (e) {
      console.warn(
        `[mcp] ${label} shutdown failed: ${(e as Error).message}`,
      );
    }
  }
  Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", shutdown);
Deno.addSignalListener("SIGINT", shutdown);
