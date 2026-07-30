// Server-verified authentication context shared across the HTTP middleware,
// MCP/REST transports, service orchestration, scope resolution, and durable
// provenance. Keep this vocabulary centralized: adding an auth label in only
// one layer would either reject valid requests or stamp misleading provenance.

export const AUTH_DOORS = ["funnel", "tailnet", "service"] as const;

export const MAX_OAUTH_SUBJECT_LENGTH = 1_024;

export type AuthDoor = (typeof AUTH_DOORS)[number];

export type AuthContext = {
  // `tailnet`: shared x-brain-key credential.
  // `funnel`: OAuth Bearer representing a human/user subject.
  // `service`: OAuth Bearer representing a client-credentials machine subject.
  // These labels identify the verified credential class, not Caddy's network
  // branch; both OAuth labels can arrive over a private tailnet route.
  door: AuthDoor;
  // Verified JWT subject on either OAuth label; null on the shared-key label.
  sub: string | null;
};

export function isAuthDoor(value: unknown): value is AuthDoor {
  return typeof value === "string" &&
    (AUTH_DOORS as readonly string[]).includes(value);
}

// `jose`'s requiredClaims option proves only that a claim member exists. Keep
// the runtime identity contract here so auth middleware and both transport
// boundaries reject empty, non-string, oversized, or log-unsafe subjects.
export function isOAuthSubject(value: unknown): value is string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_OAUTH_SUBJECT_LENGTH
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

// Shared defensive gate for MCP and REST. `requireAuth` establishes this
// invariant first; checking it again where the Hono context becomes a service
// argument prevents a future middleware refactor from smuggling malformed
// identity into ownership or durable provenance.
export function authContextFromValues(
  door: unknown,
  sub: unknown,
): AuthContext | null {
  if (!isAuthDoor(door)) return null;
  if (door === "tailnet") {
    return sub === null || sub === undefined ? { door, sub: null } : null;
  }
  return isOAuthSubject(sub) ? { door, sub } : null;
}
