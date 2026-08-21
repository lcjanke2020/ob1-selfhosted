// Shared hermetic fixtures for server tests. The filename deliberately does
// NOT match Deno's *_test.ts discovery pattern, so this file is only imported,
// never run as a suite.

import { assertEquals } from "@std/assert";
import { type Context, type Env, Hono, type MiddlewareHandler } from "hono";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import type { Pool } from "postgres";
import type { ServiceDeps } from "./services.ts";

// Keep every environment read available to the production server launcher in
// one test baseline. withEnv clears these before applying per-test overrides,
// so ambient developer/CI values cannot select a different module-load path.
// Adding a production setting should normally require one edit here, not an
// ENV_KEYS edit in every importing test.
export const SERVER_ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "DB_POOL_SIZE",
  "DB_BOOT_PROBE_TIMEOUT_MS",
  "DEFAULT_WORKSPACE_ID",
  "OLLAMA_URL",
  "EMBED_MODEL",
  "EMBED_DIM",
  "CHAT_API_BASE",
  "CHAT_API_KEY",
  "CHAT_MODEL",
  "CHAT_TIMEOUT_MS",
  "FALLBACK_CHAT_API_BASE",
  "FALLBACK_CHAT_API_KEY",
  "FALLBACK_CHAT_MODEL",
  "ENABLE_PRIMARY_EXTRACTION",
  "METADATA_FALLBACK_POLICY",
  "METADATA_NOTIFY_CHANNELS",
  "METADATA_NOTIFY_LABEL",
  "METADATA_NOTIFY_POLL_INTERVAL_MS",
  "METADATA_NOTIFY_ROLLUP_MS",
  "METADATA_NOTIFY_TIMEOUT_MS",
  "METADATA_PUSHOVER_APP_TOKEN",
  "METADATA_PUSHOVER_USER_KEY",
  "METADATA_NTFY_SERVER_URL",
  "METADATA_NTFY_TOPIC",
  "METADATA_NTFY_TOKEN",
  "ENABLE_REST_API",
  "ENABLE_NATIVE_TOKENS",
  "MCP_ACCESS_KEY",
  "MCP_ACCESS_KEY_PRINCIPAL",
  "PORT",
  "CITATION_BASE_URL",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OAUTH_ALLOWED_SUBJECTS",
  "OAUTH_SERVICE_ACCOUNT_SUBJECTS",
  "FETCH_TIMEOUT_MS",
  "JWKS_FETCH_TIMEOUT_MS",
  "OBS_AUTH_EVENTS_ENABLED",
  "OBS_AUTH_EVENTS_MAX_IN_FLIGHT",
  "AUTH_BODY_READ_TIMEOUT_MS",
  // deno-postgres reads these aliases internally; the production launcher
  // grants them even though OB1's config surface uses DB_*.
  "PGAPPNAME",
  "PGDATABASE",
  "PGHOST",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGPORT",
  "PGUSER",
] as const;

export type EnvOverrides = Readonly<Record<string, string | undefined>>;

// Returns a callback with a clean environment boundary. This shape composes
// directly with Deno.test(name, fn), preserving per-file process isolation and
// avoiding another outer callback solely for cleanup.
export function withEnv<Args extends unknown[], Result>(
  extraKeys: readonly string[],
  overrides: EnvOverrides,
  fn: (...args: Args) => Result | Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const keys = new Set<string>([
      ...SERVER_ENV_KEYS,
      ...extraKeys,
      ...Object.keys(overrides),
    ]);
    const original = new Map<string, string | undefined>();
    for (const key of keys) {
      original.set(key, Deno.env.get(key));
      Deno.env.delete(key);
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) Deno.env.set(key, value);
    }

    try {
      return await fn(...args);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  };
}

export interface DenoSubprocessResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface DenoSubprocessOptions {
  args: readonly string[];
  cwd?: string | URL;
  env?: Readonly<Record<string, string>>;
  clearEnv?: boolean;
  timeoutMs?: number;
  trimOutput?: boolean;
}

export async function runDenoSubprocess(
  options: DenoSubprocessOptions,
): Promise<DenoSubprocessResult> {
  // Keep the executable name rather than Deno.execPath(): the repository test
  // task intentionally grants --allow-run=deno and regression-pins that bound.
  const command = new Deno.Command("deno", {
    args: [...options.args],
    cwd: options.cwd,
    env: options.env ? { ...options.env } : undefined,
    clearEnv: options.clearEnv,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The subprocess won the race and already exited.
      }
    }, options.timeoutMs);

  try {
    const output = await child.output();
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const normalize = options.trimOutput
      ? (value: string) => value.trim()
      : (value: string) => value;
    return {
      code: output.code,
      success: output.success,
      stdout: normalize(decode(output.stdout)),
      stderr: normalize(decode(output.stderr)),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function runConfigSubprocess(
  script: string,
  baseEnv: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>> = {},
  cwd: string | URL = import.meta.dirname!,
): Promise<DenoSubprocessResult> {
  const configuredEnv = { ...baseEnv, ...overrides };
  const keys = [
    ...new Set([
      ...SERVER_ENV_KEYS,
      ...Object.keys(configuredEnv),
    ]),
  ];
  const prelude = `const __fixtureKeys=${JSON.stringify(keys)};` +
    `const __fixtureEnv=${JSON.stringify(configuredEnv)};` +
    `for(const key of __fixtureKeys)Deno.env.delete(key);` +
    `for(const [key,value] of Object.entries(__fixtureEnv))Deno.env.set(key,value);`;
  return runDenoSubprocess({
    args: ["eval", `${prelude}\n${script}`],
    cwd,
    trimOutput: true,
  });
}

export interface JwksFixtureOptions {
  issuer?: string;
  audience?: string | string[];
  jwksUrl?: string;
  kid?: string;
  subject?: string;
  expirationTime?: string | number;
  jwksResponse?: () => Response | Promise<Response>;
}

export interface SignTestTokenOptions {
  claims?: Record<string, unknown>;
  protectedHeader?: Record<string, unknown>;
  issuer?: string;
  audience?: string | string[];
  issuedAt?: number | false;
  expirationTime?: string | number | false;
  notBefore?: string | number;
  privateKey?: CryptoKey;
}

export interface JwksFixture {
  issuer: string;
  audience: string | string[];
  jwksUrl: string;
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
  readonly fetchCount: number;
  installFetchMock(): () => void;
  signToken(options?: SignTestTokenOptions): Promise<string>;
}

export async function makeJwksFixture(
  options: JwksFixtureOptions = {},
): Promise<JwksFixture> {
  const issuer = options.issuer ?? "https://test.invalid/";
  const audience = options.audience ?? "https://test.invalid/mcp";
  const jwksUrl = options.jwksUrl ??
    "https://test.invalid/.well-known/jwks.json";
  const kid = options.kid ?? "test-key-1";
  const subject = options.subject ?? "user-under-test";
  const defaultExpiration = options.expirationTime ?? "1h";
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  let fetchCount = 0;

  return {
    issuer,
    audience,
    jwksUrl,
    kid,
    privateKey: privateKey as CryptoKey,
    publicJwk,
    get fetchCount() {
      return fetchCount;
    },
    installFetchMock() {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url;
        if (url === jwksUrl) {
          fetchCount++;
          return options.jwksResponse
            ? await options.jwksResponse()
            : Response.json({ keys: [publicJwk] });
        }
        return await originalFetch(input, init);
      }) as typeof fetch;
      return () => {
        globalThis.fetch = originalFetch;
      };
    },
    async signToken(tokenOptions: SignTestTokenOptions = {}) {
      const claims = tokenOptions.claims ?? { sub: subject };
      const jwt = new SignJWT(claims as JWTPayload)
        .setProtectedHeader({
          alg: "RS256",
          kid,
          ...tokenOptions.protectedHeader,
        })
        .setIssuer(tokenOptions.issuer ?? issuer)
        .setAudience(tokenOptions.audience ?? audience);
      if (tokenOptions.issuedAt !== false) {
        jwt.setIssuedAt(tokenOptions.issuedAt);
      }
      if (tokenOptions.expirationTime !== false) {
        jwt.setExpirationTime(
          tokenOptions.expirationTime ?? defaultExpiration,
        );
      }
      if (tokenOptions.notBefore !== undefined) {
        jwt.setNotBefore(tokenOptions.notBefore);
      }
      return await jwt.sign(
        tokenOptions.privateKey ?? (privateKey as CryptoKey),
      );
    },
  };
}

export function makeAuthTestApp<E extends Env>(
  middleware: MiddlewareHandler<E>,
  respond?: (context: Context<E>) => Response | Promise<Response>,
): Hono<E> {
  const app = new Hono<E>();
  app.use("*", middleware);
  const handler = respond ??
    ((context: Context<E>) => context.json({ ok: true }));
  app.get("/", (context) => handler(context as Context<E>));
  app.post("/", (context) => handler(context as Context<E>));
  app.delete("/", (context) => handler(context as Context<E>));
  return app;
}

export async function assertUnauthorized401(
  response: Response,
  expectedId: string | number | null = null,
): Promise<void> {
  assertEquals(response.status, 401, "expected HTTP 401");
  assertEquals(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
    "envelope content-type is JSON",
  );
  assertEquals(
    response.headers.get("cache-control"),
    "no-store",
    "envelope must not be cacheable",
  );
  const body = await response.json();
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.error?.code, -32001);
  assertEquals(
    body.error?.message,
    "Unauthorized: missing or invalid authentication.",
  );
  assertEquals(body.id, expectedId);
}

// Per-test SQL dispatcher. Return rows for statements the test expects;
// undefined falls through only for the small infrastructure statement set
// below. Every other unscripted array/object query rejects with SQL context.
export type QueryResult = { rows: unknown[] };

export type QueryHandler = (
  sql: string,
  params: unknown[],
) => QueryResult | undefined;

export interface QueryCall {
  sql: string;
  params: unknown[];
}

export interface FakeClientOptions {
  /** Let a lifecycle adapter script getClient()'s SELECT 1 probe itself. */
  scriptValidation?: boolean;
}

function implicitQueryArrayResult(sql: string): QueryResult | undefined {
  const statement = sql.trim();
  const compact = statement.replace(/\s+/g, " ");
  if (compact === "SELECT 1") return { rows: [[1]] };
  if (
    compact === "BEGIN" || compact === "COMMIT" ||
    compact === "ROLLBACK" ||
    compact === "SAVEPOINT thought_mutation" ||
    compact === "ROLLBACK TO SAVEPOINT thought_mutation" ||
    compact === "RELEASE SAVEPOINT thought_mutation" ||
    compact.startsWith("SELECT set_config(") ||
    compact === "SET LOCAL hnsw.iterative_scan = strict_order" ||
    compact.startsWith("DELETE FROM sessions.artifact WHERE session_pk") ||
    compact.startsWith("INSERT INTO sessions.artifact (")
  ) {
    return { rows: [] };
  }
  return undefined;
}

export class FakeClient {
  readonly queryArrayCalls: QueryCall[] = [];
  readonly queryObjectCalls: QueryCall[] = [];
  releaseCalls = 0;
  endCalls = 0;

  constructor(
    private handler: QueryHandler,
    private options: FakeClientOptions = {},
  ) {}

  queryArray<T extends unknown[] = unknown[]>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    this.queryArrayCalls.push({ sql, params });
    // getClient() validates every borrow with SELECT 1. Keep that driver-level
    // probe out of semantic handlers; it is still visible in queryArrayCalls.
    const implicitValidation = !this.options.scriptValidation &&
        sql.trim() === "SELECT 1"
      ? implicitQueryArrayResult(sql)
      : undefined;
    let result: QueryResult | undefined;
    try {
      result = implicitValidation ?? this.handler(sql, params) ??
        implicitQueryArrayResult(sql);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!result) {
      return Promise.reject(
        new Error(
          `FakeClient: unscripted queryArray: ${sql.trim().slice(0, 80)}`,
        ),
      );
    }
    return Promise.resolve(result as { rows: T[] });
  }

  queryObject<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    this.queryObjectCalls.push({ sql, params });
    let r: QueryResult | undefined;
    try {
      r = this.handler(sql, params);
    } catch (error) {
      return Promise.reject(error);
    }
    // Every scoped service resolves the registry before doing work. Keep the
    // default legacy workspace implicit in existing hermetic tests; focused
    // scope tests can override by returning their own row (or `{rows: []}`).
    if (!r && sql.includes("FROM memory_scope.workspace AS w")) {
      return Promise.resolve({
        rows: [{
          default_visibility: "workspace",
          personal_only: false,
          project_exists: true,
        }],
      } as { rows: T[] });
    }
    if (!r) {
      return Promise.reject(
        new Error(
          `FakeClient: unscripted queryObject: ${sql.trim().slice(0, 80)}`,
        ),
      );
    }
    return Promise.resolve(r as { rows: T[] });
  }

  release(): void {
    this.releaseCalls++;
  }

  end(): Promise<void> {
    this.endCalls++;
    return Promise.resolve();
  }
}

export interface FakePoolOptions {
  /** Reuse one client when a test needs aggregate release/query counters. */
  client?: FakeClient;
}

export class FakePool {
  connectCalls = 0;
  readonly clients: FakeClient[] = [];
  constructor(
    private handler: QueryHandler,
    private options: FakePoolOptions = {},
  ) {}
  connect(): Promise<FakeClient> {
    this.connectCalls++;
    const client = this.options.client ?? new FakeClient(this.handler);
    this.clients.push(client);
    return Promise.resolve(client);
  }
}

export const asPool = (p: { connect(): Promise<unknown> }): Pool =>
  p as unknown as Pool;

export function makeFakePool(
  handler: QueryHandler,
  clientOptions: FakeClientOptions = {},
): { pool: Pool; fakePool: FakePool; client: FakeClient } {
  const client = new FakeClient(handler, clientOptions);
  const fakePool = new FakePool(handler, { client });
  return { pool: asPool(fakePool), fakePool, client };
}

// A valid 768-dim embedding is irrelevant to these tests; 3 floats keeps
// assertion output readable. The query layer only joins it into a pgvector
// literal.
export const FAKE_VECTOR = [0.1, 0.2, 0.3];

export type RecordingDeps = ServiceDeps & {
  embedCalls: string[];
  extractCalls: string[];
};

export function makeDeps(overrides: Partial<ServiceDeps> = {}): RecordingDeps {
  const embedCalls: string[] = [];
  const extractCalls: string[] = [];
  return {
    embedCalls,
    extractCalls,
    embed: overrides.embed ?? ((text) => {
      embedCalls.push(text);
      return Promise.resolve([...FAKE_VECTOR]);
    }),
    extractMetadata: overrides.extractMetadata ?? ((text) => {
      extractCalls.push(text);
      return Promise.resolve({
        metadata: { type: "observation", topics: ["testing"] },
        classifier: {
          schema_version: 1 as const,
          endpoint: "primary" as const,
          model: "test-local-model",
        },
        degradation_events: [],
      });
    }),
  };
}

// deps whose embed always fails — the "Ollama is down" case.
export function makeEmbedDownDeps(message = "Ollama embed failed: 500 down") {
  const deps = makeDeps({
    embed: () => Promise.reject(new Error(message)),
  });
  return { deps, message };
}
