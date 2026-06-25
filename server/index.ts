// Open Brain MCP server — Homelab + Tailscale variant.
//
// HTTP transport: Streamable HTTP at /mcp, gated by `requireAuth`, which accepts
// whichever auth doors the deployment enabled — the static x-brain-key door
// (compose-local) and/or an Auth0 RS256 Bearer JWT (the OAuth door used by the
// funnel + Qubes deployments). On a publicly-reachable deployment the reverse
// proxy also strips the inapplicable header per socket; `requireAuth` is the
// load-bearing check and works equally well behind a single-port deployment.
// Storage: vanilla Postgres + pgvector (no @supabase/supabase-js, no auth.uid).
// Embeddings: local Ollama (default model nomic-embed-text, 768 dim).
//
// Architecture is split into queries.ts (pure DB), embeddings.ts (Ollama),
// metadata.ts (optional chat-LLM extraction), auth.ts (header / JWT
// checks), mcp-server.ts (tool registration factory), and this file
// (Hono app + Deno serve). A future REST gateway, CLI, or dashboard would
// import queries.ts directly.

import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";

import {
  ENABLE_FALLBACK_EXTRACTION,
  ENABLE_METADATA_EXTRACTION,
  ENABLE_PRIMARY_EXTRACTION,
  PORT,
} from "./config.ts";
import { pool } from "./db.ts";
import {
  type AppVariables,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
  requireAuth,
} from "./auth.ts";
import { createMcpServer } from "./mcp-server.ts";
import { pingDb } from "./queries.ts";

// Hono Variables typed so `c.set/c.get` on door/sub are checked
// at the boundaries (requireAuth sets, /mcp + / handlers get). Without
// this the handler-side `c.get("door")` would be `unknown` and the
// defensive 500-guard's type-narrow would not compile.
const app = new Hono<{ Variables: AppVariables }>();

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
// monitors and the in-container healthcheck — and, with the x-brain-key door
// optional per deployment, `requireBrainKey` could no longer gate it on an
// Auth0-only install anyway.
app.get("/ready", async (c) => {
  try {
    await pingDb(pool);
    return c.json({ ok: true, db: "connected" });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 503);
  }
});

// RFC 9728 Protected Resource Metadata. Wired only when OAuth is enabled —
// no point advertising an authorization server when we don't accept its
// tokens. Path is derived from AUTH0_AUDIENCE by inserting the well-known
// component between host and resource path (see auth.ts), so a resource of
// `https://host/mcp` is served at `/.well-known/oauth-protected-resource/mcp`.
if (PROTECTED_RESOURCE_METADATA_PATH) {
  app.get(PROTECTED_RESOURCE_METADATA_PATH, protectedResourceMetadata);
}

// MCP transport. requireAuth accepts either x-brain-key (tailnet) or
// Authorization: Bearer with an Auth0 RS256 JWT (OAuth/Funnel). A new
// McpServer is constructed per request — the SDK's connect() mutates an
// instance-scoped transport reference and is not safe to share under
// concurrent load.
//
// `requireAuth` populates door + sub on the request-scoped
// Hono context; we read them here and pass to the per-request McpServer
// factory so capture_thought can stamp them into thoughts.metadata.
// The 500-guard is defense in depth: a future refactor that drops the
// `c.set` calls in `requireAuth` would otherwise stuff `door: undefined`
// into the JSONB and silently break the Phase 7 telemetry tile.
function authContextOr500(c: Context<{ Variables: AppVariables }>):
  | { door: "funnel" | "tailnet"; sub: string | null }
  | Response {
  const door = c.get("door");
  const sub = c.get("sub") ?? null;
  if (door !== "funnel" && door !== "tailnet") {
    return c.json({ error: "auth_context_missing" }, 500);
  }
  return { door, sub };
}

app.all("/mcp", requireAuth, async (c) => {
  const auth = authContextOr500(c);
  if (auth instanceof Response) return auth;
  const transport = new StreamableHTTPTransport();
  const server = createMcpServer(auth);
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Backward-compat: also serve the MCP transport at the root for clients
// that don't add /mcp to the URL.
app.all("/", requireAuth, async (c) => {
  const auth = authContextOr500(c);
  if (auth instanceof Response) return auth;
  const transport = new StreamableHTTPTransport();
  const server = createMcpServer(auth);
  await server.connect(transport);
  return transport.handleRequest(c);
});

console.log(`open-brain-homelab listening on :${PORT}`);

// Announce the metadata-extraction mode at boot so the two silent degradations
// (every capture stamping the stub; every capture going to the fallback, which
// may be off-box) are obvious from the startup log, not just per-capture lines.
// No secrets. "May be off-box" because whether the fallback endpoint is remote
// vs on-LAN depends on the operator's FALLBACK_CHAT_API_BASE.
if (!ENABLE_METADATA_EXTRACTION) {
  console.warn(
    "[metadata] extraction disabled (no primary or fallback configured) — captures stamp the uncategorized stub",
  );
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

// Graceful shutdown — stop accepting new connections, drain in-flight
// requests, then release the DB pool. `docker stop` sends SIGTERM; without
// this, in-flight requests are cut and postgres keeps the abandoned
// connections until its own timeout. Mirrors log_ingester.ts.
const shutdown = async () => {
  console.log("[mcp] shutdown signal received; draining server + pool");
  try {
    await httpServer.shutdown();
    await pool.end();
  } catch (e) {
    console.warn(`[mcp] shutdown cleanup failed: ${(e as Error).message}`);
  }
  Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", shutdown);
Deno.addSignalListener("SIGINT", shutdown);
