// Negative test for the "at least one auth door" guard in config.ts. With both
// MCP_ACCESS_KEY (x-brain-key door) and AUTH0_* (OAuth door) now optional, a
// deployment that configures NEITHER would boot with no authentication at all —
// config.ts must refuse to start in that state.
//
// The positive cases are covered implicitly elsewhere: auth_brainkey_test.ts
// boots with MCP_ACCESS_KEY only (x-brain-key door), and auth_oauth_test.ts +
// auth_oauth_only_test.ts boot with AUTH0_* (OAuth door). This file covers the
// single negative case (one-throw-per-file; see the min-length test header for
// why the import-throws-once contract forces a dedicated file).
//
// Run with: `deno task test` (or `deno test --allow-env --allow-net=127.0.0.1
// config_require_at_least_one_auth_test.ts`).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const ENV_KEYS = [
  "DB_PASSWORD",
  "MCP_ACCESS_KEY",
  "AUTH0_ISSUER",
  "AUTH0_JWKS_URI",
  "AUTH0_AUDIENCE",
  "OBS_AUTH_EVENTS_ENABLED",
];

Deno.test(
  "config.ts: throws when neither auth door is configured (no MCP_ACCESS_KEY, no AUTH0_*)",
  async () => {
    const origEnv = new Map<string, string | undefined>(
      ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
    );

    // Disable BOTH doors: no x-brain-key, no OAuth. DB_PASSWORD is set so the
    // throw we observe is the auth guard, not the unrelated DB_PASSWORD required().
    Deno.env.delete("MCP_ACCESS_KEY");
    Deno.env.delete("AUTH0_ISSUER");
    Deno.env.delete("AUTH0_JWKS_URI");
    Deno.env.delete("AUTH0_AUDIENCE");
    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");

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
        "config.ts must throw at module load when no auth door is configured",
      );
      assertStringIncludes(
        message,
        "MCP_ACCESS_KEY",
        "error must name the x-brain-key option",
      );
      assertStringIncludes(
        message,
        "AUTH0_",
        "error must name the OAuth option",
      );
    } finally {
      for (const [k, v] of origEnv) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
);
