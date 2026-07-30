// Server-verified authentication context shared across the HTTP middleware,
// MCP/REST transports, service orchestration, scope resolution, and durable
// provenance. Keep this vocabulary centralized: adding an auth label in only
// one layer would either reject valid requests or stamp misleading provenance.

export const AUTH_DOORS = ["funnel", "tailnet", "service"] as const;

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
