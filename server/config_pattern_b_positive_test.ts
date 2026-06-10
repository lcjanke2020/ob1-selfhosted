// Positive companion to config_pattern_b_test.ts. The negative
// case (ENABLE_OAUTH && !PATTERN_B → throws) is covered there. This file
// explicitly tests the positive case (ENABLE_OAUTH && PATTERN_B → boots
// cleanly), so this fail-fast coverage doesn't depend on auth_oauth_test.ts's
// happy-path import. If someone refactors that file later — e.g., factors
// out the env setup or removes the PATTERN_B=true line — the regression
// would still land here instead of vanishing silently. (Opus-4.7 PR #15
// round-1 observation #5.)
//
// Why a separate file: Deno caches dynamic imports per module URL within
// a single test worker. config_pattern_b_test.ts loads config.ts in a
// FAILING state (PATTERN_B intentionally missing); a positive-case test
// in that same file would either get the cached failure on re-import OR
// have to run before the negative test set the env — both fragile.
// `deno test` defaults to one worker subprocess per test file, so putting
// the positive case in its own file guarantees a fresh module-load
// context with no shared cache state.

import { assertEquals, assertExists } from "jsr:@std/assert@1";

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
  "config.ts: boots cleanly when ENABLE_OAUTH && PATTERN_B (Pattern B fail-fast, positive)",
  async () => {
    // ─── Setup ────────────────────────────────────────────────────────
    const origEnv = new Map<string, string | undefined>(
      ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
    );

    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.set("MCP_ACCESS_KEY", "k".repeat(64));
    Deno.env.set("AUTH0_ISSUER", "https://test.invalid/");
    Deno.env.set(
      "AUTH0_JWKS_URI",
      "https://test.invalid/.well-known/jwks.json",
    );
    Deno.env.set("AUTH0_AUDIENCE", "https://test.invalid:8443/mcp");
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
    Deno.env.set("PATTERN_B", "true");

    try {
      // ─── Act + assert ───────────────────────────────────────────────
      const config = await import("./config.ts");
      // The exports we care about are present (the throw would have
      // happened at module load, so reaching here is most of the
      // proof). Spot-check a few exports to defend against a future
      // refactor that accidentally short-circuits module-load.
      assertEquals(config.ENABLE_OAUTH, true, "OAuth must be enabled");
      assertExists(config.MCP_ACCESS_KEY, "MCP_ACCESS_KEY export must exist");
      assertExists(config.AUTH0_ISSUER, "AUTH0_ISSUER export must exist");
    } finally {
      // ─── Teardown ───────────────────────────────────────────────────
      for (const [k, v] of origEnv) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
);
