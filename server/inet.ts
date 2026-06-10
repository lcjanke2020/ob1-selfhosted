// Best-effort INET extraction from upstream-provided source
// strings (X-Forwarded-For tokens, Caddy `remote_addr`, etc.).
//
// Why this exists:
//   `funnel_access_log.client_ip` and `mcp_auth_events.client_ip` are
//   typed as Postgres `inet`. When we INSERT with `$N::inet`, Postgres
//   rejects values that aren't parseable as an IP — and silently drops
//   the row from the caller's perspective (the INSERT throws; the catch
//   in auth_audit/log_ingester logs and moves on, but the audit/log row
//   is gone). Upstream-provided strings include several legal-but-not-INET
//   shapes we need to normalize or discard:
//
//     • RFC 7239: `unknown` is a valid X-Forwarded-For token meaning the
//       upstream proxy intentionally elided the source.
//     • Caddy `remote_addr` is `ip:port` for IPv4 and `[ip]:port` for IPv6.
//       The port is meaningless for our analysis and breaks the inet cast.
//     • Bare IPv6 with brackets but no port: `[::1]` from some proxies.
//
//   This helper trims, unwraps brackets, strips a single trailing port
//   when unambiguously safe, rejects placeholder tokens, and applies a
//   shape check to filter random garbage. Postgres still does the final
//   semantic validation; this just makes sure we don't hand it `unknown`
//   or `1.2.3.4:5678`.

const SHAPE_RE = /^[0-9a-fA-F:.]+$/;

export function parseInetCandidate(
  raw: string | undefined | null,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Common placeholder tokens that proxies emit for "no useful source".
  const lowered = trimmed.toLowerCase();
  if (lowered === "unknown" || lowered === "-") return undefined;

  let candidate = trimmed;

  // Bracketed IPv6 with optional :port suffix → unwrap to the address.
  // Examples: "[::1]" → "::1" ; "[2001:db8::1]:8080" → "2001:db8::1"
  const bracketMatch = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketMatch) {
    candidate = bracketMatch[1];
  } else if (
    // Plain IPv4 with a trailing :port — strip it. We only do this when
    // there's a single colon AND a dot (i.e., this looks like IPv4:port
    // and NOT an unbracketed IPv6 like "::1" or "fe80::1"). Bare unbracketed
    // IPv6 without a port stays as-is; Postgres' inet accepts that form.
    candidate.indexOf(":") === candidate.lastIndexOf(":") &&
    candidate.includes(".")
  ) {
    candidate = candidate.split(":")[0];
  }

  // Loose shape check to filter random garbage. Postgres inet does the
  // real validation; this catches strings that obviously aren't IPs.
  if (!SHAPE_RE.test(candidate)) return undefined;

  return candidate;
}
