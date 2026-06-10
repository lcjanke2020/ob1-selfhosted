// Negative test for the Pattern B compose-mode fail-fast in
// config.ts. The positive case (ENABLE_OAUTH && PATTERN_B → boot succeeds)
// is covered implicitly by auth_oauth_test.ts: that suite sets all three
// AUTH0_* values plus PATTERN_B=true and asserts auth.ts (which
// transitively imports config.ts) loads cleanly. This file covers the
// negative case: with the same OAuth env but PATTERN_B missing, the
// config.ts module-load must throw with a message naming PATTERN_B.
//
// Why a separate test file: Deno caches dynamic imports per module URL
// within a single process. The first `import("./config.ts")` either
// succeeds (caching the module) or throws (caching the failure). A second
// import in the same file returns the cached state. `deno test` by
// default runs one worker subprocess per test file, so each file gets a
// fresh module-load context — which is exactly what we want here.
//
// Run with: `deno task test` (or directly `deno test --allow-env
// --allow-net=127.0.0.1 config_pattern_b_test.ts`).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
  "PATTERN_B",
];

Deno.test(
  "config.ts: throws when ENABLE_OAUTH && !PATTERN_B (Pattern B fail-fast)",
  async () => {
    // ─── Setup ────────────────────────────────────────────────────────
    const origEnv = new Map<string, string | undefined>(
      ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
    );

    // Set the minimum config.ts requires PLUS all three AUTH0_* (so
    // ENABLE_OAUTH evaluates to true). Then EXPLICITLY delete PATTERN_B
    // even if the host shell has it set — without this, a developer who
    // has PATTERN_B exported in their shell would see the test pass for
    // the wrong reason.
    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
    Deno.env.set("AUTH0_ISSUER", "https://test.invalid/");
    Deno.env.set(
      "AUTH0_JWKS_URI",
      "https://test.invalid/.well-known/jwks.json",
    );
    Deno.env.set("AUTH0_AUDIENCE", "https://test.invalid:8443/mcp");
    Deno.env.delete("PATTERN_B");
    // Disable audit emission so the failed config.ts load doesn't try to
    // open a postgres connection in any transitive auth_audit init.
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

    // ─── Act + assert ─────────────────────────────────────────────────
    try {
      let threw = false;
      let message = "";
      try {
        await import("./config.ts");
      } catch (e) {
        threw = true;
        message = (e as Error).message;
      }
      assertEquals(
        threw,
        true,
        "config.ts must throw at module load when ENABLE_OAUTH is set " +
          "but PATTERN_B is not",
      );
      assertStringIncludes(
        message,
        "PATTERN_B",
        "error message must name PATTERN_B so the operator knows what " +
          "to fix",
      );
      assertStringIncludes(
        message,
        "docker-compose.pattern-b.yml",
        "error message must point at the compose override file the " +
          "operator forgot to load",
      );
    } finally {
      // ─── Teardown ───────────────────────────────────────────────────
      for (const [k, v] of origEnv) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
);
