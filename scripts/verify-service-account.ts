// Browserless OAuth client-credentials smoke test for Open Brain.
//
// Secrets and tokens stay in memory: configuration is read from the environment,
// the access token is never printed, and provider error bodies are not echoed.
// See docs/service-account-oauth-client.md for setup and invocation.

export type ClientAuthMethod = "client_secret_post" | "client_secret_basic";

export type TokenRequestConfig = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  audience?: string;
  scope?: string;
  authMethod: ClientAuthMethod;
};

type JsonObject = Record<string, unknown>;

const MAX_RESPONSE_BYTES = 1_048_576;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function formComponent(value: string): string {
  return new URLSearchParams([["v", value]]).toString().slice(2);
}

function basicCredentials(clientId: string, clientSecret: string): string {
  // RFC 6749 §2.3.1 applies application/x-www-form-urlencoded encoding to
  // each credential before Base64 encoding the `id:secret` pair.
  return btoa(
    `${formComponent(clientId)}:${formComponent(clientSecret)}`,
  );
}

export function buildTokenRequest(config: TokenRequestConfig): Request {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (config.audience) body.set("audience", config.audience);
  if (config.scope) body.set("scope", config.scope);

  const headers = new Headers({
    "accept": "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (config.authMethod === "client_secret_basic") {
    headers.set(
      "authorization",
      `Basic ${basicCredentials(config.clientId, config.clientSecret)}`,
    );
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }

  return new Request(config.tokenUrl, {
    method: "POST",
    headers,
    body,
    // A 307/308 would otherwise replay the client_secret_post body. Token
    // endpoints must be configured directly; never forward credentials.
    redirect: "error",
  });
}

export function buildInitializeRequest(mcpUrl: string, token: string): Request {
  return new Request(mcpUrl, {
    method: "POST",
    headers: {
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "openbrain-service-account-smoke",
          version: "1.0.0",
        },
      },
    }),
    // Authorization is just as sensitive as the client secret. Require the
    // operator to supply the final MCP URL rather than following redirects.
    redirect: "error",
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function decodeJwtPayload(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error(
      "the issuer returned an opaque or malformed token; Open Brain requires a three-part JWT",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[1])),
    );
  } catch {
    throw new Error("the issuer returned a JWT with an unreadable payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("the issuer returned a JWT with a non-object payload");
  }
  return payload as JsonObject;
}

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function parseInitializeResponse(
  body: string,
  contentType: string,
): JsonObject {
  let messages: unknown[];
  if (contentType.toLowerCase().includes("text/event-stream")) {
    messages = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
  } else {
    try {
      const parsed = JSON.parse(body);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error("MCP returned a non-JSON initialize response");
    }
  }

  for (const message of messages) {
    const object = asJsonObject(message);
    if (object?.id !== 1) continue;
    const result = asJsonObject(object.result);
    if (result) return result;
    if (object.error) {
      throw new Error("MCP rejected the initialize request");
    }
  }
  throw new Error("MCP response did not contain the initialize result");
}

function required(name: string, maxLength = 8_192): string {
  const value = Deno.env.get(name)?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  if (value.length > maxLength || hasControlCharacters(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optional(name: string, maxLength = 8_192): string | undefined {
  const value = Deno.env.get(name)?.trim() ?? "";
  if (!value) return undefined;
  if (value.length > maxLength || hasControlCharacters(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function endpoint(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `${name} must use HTTPS (HTTP is allowed only on loopback)`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
  return url.toString();
}

function timeoutMs(): number {
  const raw = optional("OAUTH_SMOKE_TIMEOUT_MS", 6) ?? "15000";
  if (!/^\d+$/u.test(raw)) throw new Error("OAUTH_SMOKE_TIMEOUT_MS is invalid");
  const value = Number(raw);
  if (value < 1_000 || value > 120_000) {
    throw new Error("OAUTH_SMOKE_TIMEOUT_MS must be between 1000 and 120000");
  }
  return value;
}

function authMethod(): ClientAuthMethod {
  const value = optional("OAUTH_CLIENT_AUTH_METHOD", 32) ??
    "client_secret_post";
  if (value !== "client_secret_post" && value !== "client_secret_basic") {
    throw new Error(
      "OAUTH_CLIENT_AUTH_METHOD must be client_secret_post or client_secret_basic",
    );
  }
  return value;
}

export async function responseText(response: Response): Promise<string> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (
    declared !== null && Number.isFinite(declared) &&
    declared > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new Error("remote response exceeded the 1 MiB smoke-test limit");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the deterministic size error even if cancellation races a
        // peer close.
      }
      throw new Error("remote response exceeded the 1 MiB smoke-test limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function providerErrorCode(body: string): string | null {
  try {
    const error = asJsonObject(JSON.parse(body))?.error;
    return typeof error === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(error)
      ? error
      : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const tokenUrl = endpoint("OAUTH_TOKEN_URL", required("OAUTH_TOKEN_URL"));
  const mcpUrl = endpoint(
    "OPENBRAIN_MCP_URL",
    required("OPENBRAIN_MCP_URL"),
  );
  const timeout = timeoutMs();
  const tokenResponse = await fetch(
    buildTokenRequest({
      tokenUrl,
      clientId: required("OAUTH_CLIENT_ID", 4_096),
      clientSecret: required("OAUTH_CLIENT_SECRET", 8_192),
      audience: optional("OAUTH_AUDIENCE"),
      scope: optional("OAUTH_SCOPE"),
      authMethod: authMethod(),
    }),
    { signal: AbortSignal.timeout(timeout) },
  );
  const tokenBody = await responseText(tokenResponse);
  if (!tokenResponse.ok) {
    const code = providerErrorCode(tokenBody);
    throw new Error(
      `token endpoint returned HTTP ${tokenResponse.status}` +
        (code ? ` (${code})` : ""),
    );
  }

  let tokenDocument: JsonObject;
  try {
    tokenDocument = asJsonObject(JSON.parse(tokenBody)) ?? {};
  } catch {
    throw new Error("token endpoint returned non-JSON success content");
  }
  const token = tokenDocument.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("token endpoint success response had no access_token");
  }
  const payload = decodeJwtPayload(token);
  if (
    typeof payload.sub !== "string" || !payload.sub ||
    payload.sub.length > 1_024 || hasControlCharacters(payload.sub)
  ) {
    throw new Error("access token sub is missing or unsafe to display");
  }

  const initializeResponse = await fetch(
    buildInitializeRequest(mcpUrl, token),
    { signal: AbortSignal.timeout(timeout) },
  );
  const initializeBody = await responseText(initializeResponse);
  if (!initializeResponse.ok) {
    throw new Error(
      `MCP initialize returned HTTP ${initializeResponse.status}`,
    );
  }
  const result = parseInitializeResponse(
    initializeBody,
    initializeResponse.headers.get("content-type") ?? "",
  );
  const serverInfo = asJsonObject(result.serverInfo);
  const displayValue = (value: unknown): string =>
    typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/u.test(value)
      ? value
      : "unknown";
  const serverName = displayValue(serverInfo?.name);
  const serverVersion = displayValue(serverInfo?.version);

  console.log(
    `OK: browserless client_credentials authenticated to ${serverName} ${serverVersion}`,
  );
  if (payload.gty === "client-credentials") {
    console.log(
      "Attribution signal: signed gty=client-credentials present; expected server label is service.",
    );
  } else {
    console.log(
      "Attribution signal: no signed gty=client-credentials claim; service labeling requires this exact subject in OAUTH_SERVICE_ACCOUNT_SUBJECTS.",
    );
  }
  if (Deno.env.get("OAUTH_SMOKE_PRINT_SUBJECT") === "true") {
    console.log(`Verified JWT subject: ${payload.sub}`);
  } else if (payload.gty !== "client-credentials") {
    console.log(
      "Set OAUTH_SMOKE_PRINT_SUBJECT=true for one run to print the verified subject needed by that allowlist.",
    );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`FAILED: ${message}`);
    Deno.exit(1);
  }
}
