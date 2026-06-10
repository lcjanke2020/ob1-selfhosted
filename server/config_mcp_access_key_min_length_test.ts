// Negative test for the MCP_ACCESS_KEY minimum-length enforcement
// in config.ts. The positive case (key ≥ 32 chars → boot succeeds) is
// covered implicitly by every other test in this directory, all of which
// use 64-character keys (`"k".repeat(64)`, `"0".repeat(64)`, `"b".repeat(64)`)
// and assert that config.ts loads cleanly. This file covers the negative
// case: a weak short key (the kind an operator types in a hurry —
// `password`, `dev`, `test`) must throw at module load with a clear,
// operator-actionable error citing `openssl rand -hex 32`.
//
// Why a separate test file: see config_pattern_b_test.ts header comment.
// Deno caches dynamic imports per worker subprocess; one-throw-per-file
// is the contract we need.
//
// Run with: `deno task test` (or `deno test --allow-env --allow-net=127.0.0.1
// config_mcp_access_key_min_length_test.ts`).

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
  "config.ts: throws when MCP_ACCESS_KEY is shorter than 32 chars (min length)",
  async () => {
    const origEnv = new Map<string, string | undefined>(
      ENV_KEYS.map((k) => [k, Deno.env.get(k)]),
    );

    // Force Pattern A so this test isn't gated on the Pattern B fail-fast
    // (which would mask the min-length throw if we left OAuth env partially
    // set from a developer's shell).
    Deno.env.delete("AUTH0_ISSUER");
    Deno.env.delete("AUTH0_JWKS_URI");
    Deno.env.delete("AUTH0_AUDIENCE");
    Deno.env.delete("PATTERN_B");
    Deno.env.set("DB_PASSWORD", "test-password");
    Deno.env.set("OBS_AUTH_EVENTS_ENABLED", "false");
    // The weak literal the ticket calls out. 8 chars < 32 → must throw.
    Deno.env.set("MCP_ACCESS_KEY", "password");

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
        "config.ts must throw at module load when MCP_ACCESS_KEY is too short",
      );
      assertStringIncludes(
        message,
        "MCP_ACCESS_KEY",
        "error message must name MCP_ACCESS_KEY",
      );
      assertStringIncludes(
        message,
        "32",
        "error message must cite the minimum length",
      );
      assertStringIncludes(
        message,
        "openssl rand -hex 32",
        "error message must point operators at the recommended generator",
      );
    } finally {
      for (const [k, v] of origEnv) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  },
);
