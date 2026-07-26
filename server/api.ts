// REST gateway (/api/v1). Mounted by index.ts ONLY when ENABLE_REST_API is
// true — the docker-compose installs opt in; the Qubes deployment leaves the
// flag unset so this surface never exists there. Same auth doors, same pool,
// same validation bounds as the MCP transport (schemas.ts), same
// orchestration (services.ts) — but structured JSON in and out, never the
// prose formatting some MCP tools return.
//
// Error body shape everywhere:
//   { "error": { "code": string, "message": string, "details"?: [...] } }
// with `details` carrying flattened Zod issues on validation failures.

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Pool } from "postgres";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

import {
  type AppVariables,
  requireAuth,
  UNAUTHORIZED_MESSAGE,
} from "./auth.ts";
import {
  captureThoughtBody,
  listSessionsQuery,
  listThoughtsQuery,
  scopeQuery,
  searchThoughtsBody,
  sessionCaptureBody,
  sessionIdParam,
  sessionLookupQuery,
  sessionSearchBody,
  sessionUpdateStatusBody,
  thoughtIdParam,
} from "./schemas.ts";
import {
  type AuthContext,
  captureSessionFromToml,
  captureThoughtWithMetadata,
  defaultDeps,
  fetchThoughtInScope,
  getSessionInScope,
  getThoughtStatsInScope,
  listSessionsInScope,
  listThoughtsInScope,
  lookupSessionInScope,
  NotFoundError,
  searchSessionsByQuery,
  searchThoughtsByQuery,
  type ServiceDeps,
  updateSessionStatusInScope,
  UpstreamError,
  ValidationError,
} from "./services.ts";

// Cap REST bodies at 1 MiB — parity with the funnel-only request_body cap in
// the Caddyfile, and a real bound for tailnet-direct callers who have no edge
// in front of them (c.req.json() would otherwise buffer unbounded bodies
// before Zod ever runs). Far above the 100k UTF-8 content cap, so no
// legitimate request gets near it.
const MAX_BODY_BYTES = 1024 * 1024;

type ApiContext = Context<{ Variables: AppVariables }>;

function errorJson(
  c: ApiContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    status,
  );
}

// requireAuth speaks MCP on auth failure: HTTP 401 with a JSON-RPC error
// envelope body (id-correlated for MCP clients), which is the wrong body
// shape for REST scripts parsing `{error: {code, message}}`. This wrapper
// runs OUTSIDE requireAuth and rewrites any auth-failure response to a
// plain 401 JSON error. The auth decision, audit rows, WWW-Authenticate,
// and Cache-Control still come from requireAuth — only the body shape
// changes. Detection: requireAuth sets `door` on success, so an unset door
// after next() means it short-circuited with a failure response.
const restifyAuthFailure: MiddlewareHandler<{ Variables: AppVariables }> =
  async (c, next) => {
    await next();
    if (c.get("door") !== undefined) return;
    const headers = new Headers({
      "content-type": "application/json; charset=UTF-8",
    });
    // Hono's c.res setter also carries prior headers over; the explicit copy
    // keeps the two auth-relevant ones correct even if that behavior changes.
    for (const h of ["www-authenticate", "cache-control"]) {
      const v = c.res.headers.get(h);
      if (v) headers.set(h, v);
    }
    c.res = new Response(
      JSON.stringify({
        error: { code: "unauthorized", message: UNAUTHORIZED_MESSAGE },
      }),
      { status: 401, headers },
    );
  };

// Mirror of index.ts's authContextOr500 guard: `door` is always set by
// requireAuth before a handler runs; if a future refactor drops the c.set
// calls, fail as a 500 (via onError) rather than persisting door: undefined.
function authOr500(c: ApiContext): AuthContext {
  const door = c.get("door");
  if (door !== "funnel" && door !== "tailnet") {
    throw new Error("auth context missing after requireAuth");
  }
  return { door, sub: c.get("sub") ?? null };
}

async function readJsonBody(c: ApiContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
}

// safeParse or throw a ValidationError whose message summarizes the issues
// and whose details carry them structurally (onError puts both in the 400).
function parseOr400<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }));
  const summary = issues
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join("; ");
  const e = new ValidationError(summary);
  (e as ValidationError & { details: unknown }).details = issues;
  throw e;
}

export function createApiRouter(
  pool: Pool,
  deps: ServiceDeps = defaultDeps,
): Hono<{ Variables: AppVariables }> {
  const api = new Hono<{ Variables: AppVariables }>();

  // Order matters: restifyAuthFailure wraps requireAuth (outermost), and the
  // body cap runs only for authenticated requests.
  api.use("*", restifyAuthFailure);
  api.use("*", requireAuth);
  api.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        errorJson(
          c as ApiContext,
          413,
          "payload_too_large",
          `request body exceeds ${MAX_BODY_BYTES} bytes`,
        ),
    }),
  );

  api.onError((e, c) => {
    if (e instanceof ValidationError) {
      return errorJson(
        c,
        400,
        "validation_error",
        e.message,
        (e as ValidationError & { details?: unknown }).details,
      );
    }
    if (e instanceof NotFoundError) {
      return errorJson(c, 404, "not_found", e.message);
    }
    if (e instanceof UpstreamError) {
      // Embedding backend (Ollama) unreachable/failed — same message text
      // the MCP tools surface, so nothing new is leaked.
      return errorJson(c, 502, "upstream_error", e.message);
    }
    // Anything else (DB failures included) is an internal error; log it,
    // don't leak it.
    console.error(
      `[api] ${c.req.method} ${c.req.path}: ${(e as Error).message}`,
    );
    return errorJson(c, 500, "internal_error", "Internal server error.");
  });

  // ---- thoughts -------------------------------------------------------
  // Search is POST-with-body (not GET) so it reuses the exact MCP Zod shape
  // — no query-string coercion divergence between the two transports.

  api.post("/thoughts", async (c) => {
    const { content, provenance, scope } = parseOr400(
      captureThoughtBody,
      await readJsonBody(c),
    );
    const out = await captureThoughtWithMetadata(
      pool,
      { content, provenance, scope, auth: authOr500(c), via: "rest" },
      deps,
    );
    // captureThought upserts by content fingerprint, so a re-capture of
    // identical content returns the existing row's id — still 201, the id in
    // the body is authoritative either way.
    return c.json(out, 201);
  });

  api.post("/thoughts/search", async (c) => {
    const opts = parseOr400(searchThoughtsBody, await readJsonBody(c));
    const results = await searchThoughtsByQuery(
      pool,
      { ...opts, auth: authOr500(c) },
      deps,
    );
    return c.json({ results });
  });

  // Static routes registered before /thoughts/:id so the intent is obvious
  // (Hono's router prefers static matches regardless, but explicit is free).
  api.get("/thoughts/stats", async (c) => {
    const scope = parseOr400(scopeQuery, c.req.query());
    return c.json(
      await getThoughtStatsInScope(pool, { scope, auth: authOr500(c) }),
    );
  });

  api.get("/thoughts", async (c) => {
    const opts = parseOr400(listThoughtsQuery, c.req.query());
    const {
      workspace_id,
      project_id,
      visibility,
      ...filters
    } = opts;
    const thoughts = await listThoughtsInScope(pool, {
      ...filters,
      scope: { workspace_id, project_id, visibility },
      auth: authOr500(c),
    });
    return c.json({ thoughts });
  });

  api.get("/thoughts/:id", async (c) => {
    const id = parseOr400(thoughtIdParam, c.req.param("id"));
    const scope = parseOr400(scopeQuery, c.req.query());
    const t = await fetchThoughtInScope(pool, id, {
      scope,
      auth: authOr500(c),
    });
    if (!t) throw new NotFoundError(`No thought found for ID ${id}.`);
    return c.json(t);
  });

  // ---- sessions -------------------------------------------------------

  api.post("/sessions", async (c) => {
    const { toml_text } = parseOr400(sessionCaptureBody, await readJsonBody(c));
    const res = await captureSessionFromToml(
      pool,
      { tomlText: toml_text, auth: authOr500(c) },
      deps,
    );
    // 201 when the capture minted a new session, 200 when it refreshed an
    // existing one (TOML carried the id).
    return c.json(res, res.created ? 201 : 200);
  });

  api.post("/sessions/search", async (c) => {
    const opts = parseOr400(sessionSearchBody, await readJsonBody(c));
    const results = await searchSessionsByQuery(
      pool,
      { ...opts, auth: authOr500(c) },
      deps,
    );
    return c.json({ results });
  });

  api.get("/sessions/lookup", async (c) => {
    const q = parseOr400(sessionLookupQuery, c.req.query());
    const rec = await lookupSessionInScope(pool, {
      id: q.id,
      branch: q.branch,
      scope: {
        workspace_id: q.workspace_id,
        project_id: q.project_id,
        visibility: q.visibility,
      },
      auth: authOr500(c),
    });
    if (!rec) {
      throw new NotFoundError("No session matched the given id/branch.");
    }
    return c.json(rec);
  });

  api.get("/sessions", async (c) => {
    const opts = parseOr400(listSessionsQuery, c.req.query());
    const {
      workspace_id,
      project_id,
      visibility,
      ...filters
    } = opts;
    const sessions = await listSessionsInScope(pool, {
      ...filters,
      scope: { workspace_id, project_id, visibility },
      auth: authOr500(c),
    });
    return c.json({ sessions });
  });

  api.get("/sessions/:id", async (c) => {
    const id = parseOr400(sessionIdParam, c.req.param("id"));
    const scope = parseOr400(scopeQuery, c.req.query());
    const rec = await getSessionInScope(pool, id, {
      scope,
      auth: authOr500(c),
    });
    if (!rec) throw new NotFoundError(`No session found for id ${id}.`);
    return c.json(rec);
  });

  api.patch("/sessions/:id/status", async (c) => {
    const id = parseOr400(sessionIdParam, c.req.param("id"));
    const { status, scope } = parseOr400(
      sessionUpdateStatusBody,
      await readJsonBody(c),
    );
    const row = await updateSessionStatusInScope(pool, id, status, {
      scope,
      auth: authOr500(c),
    });
    if (!row) throw new NotFoundError(`No session found for id ${id}.`);
    return c.json(row);
  });

  // Terminal catch-all, registered LAST: an authenticated request for an
  // unknown path or an unsupported method must still get the JSON error
  // shape, not Hono's default text/plain 404. A route (not api.notFound)
  // because a sub-app's notFound handler does not travel through
  // app.route() mounting — a catch-all route does. Matched routes above
  // return without calling next(), so this never shadows them; an
  // unauthenticated probe never reaches it (requireAuth short-circuits
  // into the uniform 401 first).
  api.all("*", (c) => errorJson(c, 404, "not_found", "No such API route."));

  return api;
}
