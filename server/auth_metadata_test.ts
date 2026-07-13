// Tests for `deriveProtectedResourceMetadata` — the RFC 9728 §3.1
// transformation that inserts `/.well-known/oauth-protected-resource` between
// the host and the resource path. Run with `deno task test`.
//
// Hermetic: snapshots + restores DB_PASSWORD / MCP_ACCESS_KEY / AUTH0_* so
// the suite is not order-/machine-dependent. Explicitly deletes AUTH0_*
// before importing auth.ts so a dev/CI host that has those set in its
// shell doesn't accidentally enable OAuth.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  // importing auth.ts pulls in auth_audit.ts which would
  // otherwise construct a postgres pool. Defensively disable for tests.
  "OBS_AUTH_EVENTS_ENABLED",
];

Deno.test("deriveProtectedResourceMetadata (RFC 9728 §3.1)", async (t) => {
  // ─── Setup ─────────────────────────────────────────────────────────────
  const origEnv = new Map<string, string | undefined>(
    ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
  );

  // Force Pattern A at module load — delete AUTH0_* even if the host shell
  // has them set, so `ENABLE_OAUTH` evaluates to false in config.ts.
  Deno.env.delete("AUTH0_ISSUER");
  Deno.env.delete("AUTH0_JWKS_URI");
  Deno.env.delete("AUTH0_AUDIENCE");

  // config.ts requires these to be present (else throws at module load).
  Deno.env.set("DB_PASSWORD", "test-password");
  Deno.env.set("MCP_ACCESS_KEY", "0".repeat(64));
  // disable audit emission for the same reason as the other
  // auth_*_test files.
  Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

  const { deriveProtectedResourceMetadata } = await import("./auth.ts");

  try {
    await t.step("root resource yields well-known at origin root", () => {
      const r = deriveProtectedResourceMetadata("https://host.example/");
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource",
      );
      assertEquals(r.path, "/.well-known/oauth-protected-resource");
    });

    await t.step("single-segment resource appends path component", () => {
      const r = deriveProtectedResourceMetadata("https://host.example/mcp");
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/mcp",
      );
      assertEquals(r.path, "/.well-known/oauth-protected-resource/mcp");
    });

    await t.step("trailing slash is stripped (mcp/ → mcp)", () => {
      const r = deriveProtectedResourceMetadata("https://host.example/mcp/");
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/mcp",
      );
    });

    await t.step("multiple trailing slashes are all stripped", () => {
      const r = deriveProtectedResourceMetadata("https://host.example/mcp///");
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/mcp",
      );
    });

    await t.step("multi-segment resource path is preserved", () => {
      const r = deriveProtectedResourceMetadata(
        "https://host.example/api/v1/mcp",
      );
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/api/v1/mcp",
      );
    });

    await t.step("explicit port is preserved (Funnel :8443 case)", () => {
      const r = deriveProtectedResourceMetadata(
        "https://host.example:8443/mcp",
      );
      assertEquals(
        r.url,
        "https://host.example:8443/.well-known/oauth-protected-resource/mcp",
      );
    });

    await t.step("query string is stripped", () => {
      const r = deriveProtectedResourceMetadata(
        "https://host.example/mcp?key=value&foo=bar",
      );
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/mcp",
      );
    });

    await t.step("hash fragment is stripped", () => {
      const r = deriveProtectedResourceMetadata(
        "https://host.example/mcp#section",
      );
      assertEquals(
        r.url,
        "https://host.example/.well-known/oauth-protected-resource/mcp",
      );
    });

    await t.step(
      "returned path matches the path component of the URL",
      () => {
        // Invariant used by index.ts for Hono route mounting — the path
        // field should equal new URL(url).pathname so we don't have to
        // re-parse.
        const cases = [
          "https://host.example/",
          "https://host.example/mcp",
          "https://host.example:8443/mcp",
          "https://host.example/api/v1/mcp",
        ];
        for (const input of cases) {
          const r = deriveProtectedResourceMetadata(input);
          assertEquals(
            r.path,
            new URL(r.url).pathname,
            `path mismatch for ${input}`,
          );
        }
      },
    );

    await t.step("malformed URL throws", () => {
      assertThrows(() => deriveProtectedResourceMetadata("not-a-url"));
      assertThrows(() => deriveProtectedResourceMetadata(""));
    });
  } finally {
    // ─── Teardown ──────────────────────────────────────────────────────
    for (const [k, v] of origEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
