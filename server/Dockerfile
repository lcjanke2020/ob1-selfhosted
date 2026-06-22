FROM denoland/deno:2.3.3

WORKDIR /app

# --frozen: fail the build if the dependency graph doesn't match the
# committed lockfile — the image must ship exactly what CI tested, and a
# republished transitive can't silently enter the perimeter image.
COPY deno.json deno.lock ./
RUN deno install --frozen

COPY *.ts ./

# Cache and type-check at build time so first request is fast.
RUN deno cache --frozen index.ts

USER deno

EXPOSE 8787

# `deno eval` runs with implicit access to all permissions (see `deno eval
# --help`), so no `--allow-*` flag is needed here — and `eval` rejects them
# anyway. If you switch to `deno run`, permission flags become required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD deno eval "const p = Deno.env.get('PORT') ?? '8787'; const r = await fetch('http://127.0.0.1:' + p + '/health'); if (!r.ok) Deno.exit(1);"

# Deno permissions:
# --allow-net  unrestricted because Auth0 JWKS host and any operator-configured
#              CHAT_API_BASE are runtime-configured — a static allowlist would
#              break flexibility. Postgres, Ollama, and Auth0 are the expected
#              outbound targets.
# --allow-env  enumerated explicitly so a compromised transitive dep can't
#              read arbitrary env (including SUPABASE_* or other secrets that
#              shouldn't be visible to this process). Two groups:
#                * App config — keep in sync with config.ts.
#                * Postgres libpq-style vars (PG*) — deno-postgres probes
#                  these at pool construction even when explicit config is
#                  passed. Without them in the allowlist the container exits
#                  at startup with `Requires env access to "PGAPPNAME"`.
# --allow-read restricted to /app — Deno doesn't need to read anything else
#              at runtime.
CMD ["deno", "run", "--allow-net", "--allow-env=DB_HOST,DB_PORT,DB_NAME,DB_USER,DB_PASSWORD,DB_POOL_SIZE,OLLAMA_URL,EMBED_MODEL,EMBED_DIM,CHAT_API_BASE,CHAT_API_KEY,CHAT_MODEL,CHAT_TIMEOUT_MS,FALLBACK_CHAT_API_BASE,FALLBACK_CHAT_API_KEY,FALLBACK_CHAT_MODEL,ENABLE_PRIMARY_EXTRACTION,MCP_ACCESS_KEY,PORT,CITATION_BASE_URL,AUTH0_ISSUER,AUTH0_JWKS_URI,AUTH0_AUDIENCE,FETCH_TIMEOUT_MS,JWKS_FETCH_TIMEOUT_MS,OBS_AUTH_EVENTS_ENABLED,OBS_AUTH_EVENTS_MAX_IN_FLIGHT,AUTH_BODY_READ_TIMEOUT_MS,PATTERN_B,PGAPPNAME,PGDATABASE,PGHOST,PGOPTIONS,PGPASSWORD,PGPORT,PGUSER,PGSSLMODE,PGSSLCERT,PGSSLKEY,PGSSLROOTCERT,PGREQUIRESSL,PGSERVICE,PGSERVICEFILE,PGCONNECT_TIMEOUT", "--allow-read=/app", "index.ts"]
