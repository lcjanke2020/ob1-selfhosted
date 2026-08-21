// Pure parsers for runtime settings shared by the MCP server and its smaller
// companion processes. This module never reads Deno.env, so callers can import
// one setting contract without triggering unrelated startup validation.

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_DB_PORT = 5432;
export const DEFAULT_AUTH_BODY_READ_TIMEOUT_MS = 2_000;
export const DEFAULT_AUTH_AUDIT_MAX_IN_FLIGHT = 500;

export function parsePositiveIntegerSetting(
  name: string,
  raw: string | null | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a complete positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return parsed;
}

export function parseDbPort(raw: string | null | undefined): number {
  return parsePositiveIntegerSetting("DB_PORT", raw, DEFAULT_DB_PORT, 65_535);
}

// Boolean settings are case-insensitive after trimming, matching the existing
// strict auth-door flags. Blank/unset selects the caller's documented default;
// every nonblank value must be true or false so typos never silently flip a
// feature on or off.
export function parseBooleanSetting(
  name: string,
  raw: string | null | undefined,
  fallback: boolean,
): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export type AuthRuntimeConfig = Readonly<{
  bodyReadTimeoutMs: number;
}>;

export function parseAuthRuntimeConfig(input: {
  bodyReadTimeoutMs?: string | null;
}): AuthRuntimeConfig {
  return {
    bodyReadTimeoutMs: parsePositiveIntegerSetting(
      "AUTH_BODY_READ_TIMEOUT_MS",
      input.bodyReadTimeoutMs,
      DEFAULT_AUTH_BODY_READ_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
  };
}

export type AuthAuditRuntimeConfig = Readonly<{
  enabled: boolean;
  maxInFlight: number;
}>;

export function parseAuthAuditRuntimeConfig(input: {
  enabled?: string | null;
  maxInFlight?: string | null;
}): AuthAuditRuntimeConfig {
  return {
    enabled: parseBooleanSetting(
      "OBS_AUTH_EVENTS_ENABLED",
      input.enabled,
      true,
    ),
    maxInFlight: parsePositiveIntegerSetting(
      "OBS_AUTH_EVENTS_MAX_IN_FLIGHT",
      input.maxInFlight,
      DEFAULT_AUTH_AUDIT_MAX_IN_FLIGHT,
    ),
  };
}
