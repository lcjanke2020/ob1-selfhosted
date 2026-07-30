FROM denoland/deno:2.9.4

WORKDIR /app

# --frozen: fail the build if the dependency graph doesn't match the
# committed lockfile — the image must ship exactly what CI tested, and a
# republished transitive can't silently enter the perimeter image.
# postgres_deferred_patched.ts must be in this layer, before `deno install`:
# the import map remaps the driver's utils/deferred.ts to it, so dependency
# resolution fails without the file. It changes about as rarely as the
# lockfile, so the layer-cache benefit of the split COPY survives.
COPY deno.json deno.lock postgres_deferred_patched.ts ./
RUN deno install --frozen

COPY *.ts ./

# Cache and type-check at build time so first request is fast.
RUN deno cache --frozen index.ts token_admin.ts

USER deno

EXPOSE 8787

# `deno eval` runs with implicit access to all permissions (see `deno eval
# --help`), so no `--allow-*` flag is needed here — and `eval` rejects them
# anyway. If you switch to `deno run`, permission flags become required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD deno eval "const p = Deno.env.get('PORT') ?? '8787'; const r = await fetch('http://127.0.0.1:' + p + '/health'); if (!r.ok) Deno.exit(1);"

# Deno permissions:
# --allow-net  unrestricted because Auth0 JWKS host and any operator-configured
#              CHAT_API_BASE / ntfy endpoint are runtime-configured — a static
#              allowlist would break flexibility. Postgres, Ollama, Auth0, and
#              selected notification providers are the expected targets.
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
CMD ["deno", "run", "--allow-net", "--allow-env=DB_HOST,DB_PORT,DB_NAME,DB_USER,DB_PASSWORD,DB_POOL_SIZE,DB_BOOT_PROBE_TIMEOUT_MS,DEFAULT_WORKSPACE_ID,OLLAMA_URL,EMBED_MODEL,EMBED_DIM,CHAT_API_BASE,CHAT_API_KEY,CHAT_MODEL,CHAT_TIMEOUT_MS,FALLBACK_CHAT_API_BASE,FALLBACK_CHAT_API_KEY,FALLBACK_CHAT_MODEL,ENABLE_PRIMARY_EXTRACTION,METADATA_FALLBACK_POLICY,METADATA_NOTIFY_CHANNELS,METADATA_NOTIFY_LABEL,METADATA_NOTIFY_POLL_INTERVAL_MS,METADATA_NOTIFY_ROLLUP_MS,METADATA_NOTIFY_TIMEOUT_MS,METADATA_PUSHOVER_APP_TOKEN,METADATA_PUSHOVER_USER_KEY,METADATA_NTFY_SERVER_URL,METADATA_NTFY_TOPIC,METADATA_NTFY_TOKEN,ENABLE_REST_API,ENABLE_NATIVE_TOKENS,MCP_ACCESS_KEY,MCP_ACCESS_KEY_PRINCIPAL,PORT,CITATION_BASE_URL,AUTH0_ISSUER,AUTH0_JWKS_URI,AUTH0_AUDIENCE,OAUTH_SERVICE_ACCOUNT_SUBJECTS,FETCH_TIMEOUT_MS,JWKS_FETCH_TIMEOUT_MS,OBS_AUTH_EVENTS_ENABLED,OBS_AUTH_EVENTS_MAX_IN_FLIGHT,AUTH_BODY_READ_TIMEOUT_MS,PGAPPNAME,PGDATABASE,PGHOST,PGOPTIONS,PGPASSWORD,PGPORT,PGUSER,PGSSLMODE,PGSSLCERT,PGSSLKEY,PGSSLROOTCERT,PGREQUIRESSL,PGSERVICE,PGSERVICEFILE,PGCONNECT_TIMEOUT", "--allow-read=/app", "index.ts"]
