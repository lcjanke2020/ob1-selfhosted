// Fresh-process tests for the OAUTH_ALLOWED_SUBJECTS authorization-allowlist
// config contract. Mirrors auth_service_account_config_test.ts — the two
// lists share one parser (config.ts oauthSubjectList) — but the semantics
// under test differ: this list is the AUTHORIZATION gate, so what matters
// here is that the value parses exactly, that it refuses to exist without
// the OAuth door, and that parse errors never echo subject values.
//
// The fail-closed RUNTIME behavior (empty list rejects every Bearer) is
// middleware behavior, tested in auth_subject_allowlist_failclosed_test.ts.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runConfigSubprocess } from "./api_test_support.ts";

const SCRIPT = `
  const c = await import("./config.ts");
  console.log(JSON.stringify([...c.OAUTH_ALLOWED_SUBJECTS]));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "",
  MCP_ACCESS_KEY_PRINCIPAL: "",
  AUTH0_ISSUER: "https://issuer.example/",
  AUTH0_JWKS_URI: "https://issuer.example/.well-known/jwks.json",
  AUTH0_AUDIENCE: "https://brain.example/mcp",
  OAUTH_ALLOWED_SUBJECTS: "",
  OAUTH_SERVICE_ACCOUNT_SUBJECTS: "",
  METADATA_FALLBACK_POLICY: "off",
};

const runConfig = (overrides: Record<string, string>) =>
  runConfigSubprocess(SCRIPT, BASE_ENV, overrides);

Deno.test("allowed-subject config is exact, bounded, and OAuth-only", async (t) => {
  await t.step(
    "empty list is a valid config (runtime seals the door)",
    async () => {
      const result = await runConfig({});
      assertEquals(result.code, 0, result.stderr);
      assertEquals(JSON.parse(result.stdout), []);
    },
  );

  await t.step("subjects are trimmed and retain exact case", async () => {
    const result = await runConfig({
      OAUTH_ALLOWED_SUBJECTS: "auth0|User-A, allowed-machine@clients",
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(JSON.parse(result.stdout), [
      "auth0|User-A",
      "allowed-machine@clients",
    ]);
  });

  await t.step("requires the OAuth door", async () => {
    const result = await runConfig({
      AUTH0_ISSUER: "",
      AUTH0_JWKS_URI: "",
      AUTH0_AUDIENCE: "",
      // Keep the boot legal without OAuth: static-key door on.
      MCP_ACCESS_KEY: "k".repeat(64),
      OAUTH_ALLOWED_SUBJECTS: "auth0|orphaned-subject",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "OAUTH_ALLOWED_SUBJECTS requires the OAuth door",
    );
  });

  await t.step("duplicate subjects are refused", async () => {
    const result = await runConfig({
      OAUTH_ALLOWED_SUBJECTS: "auth0|twin,auth0|twin",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "OAUTH_ALLOWED_SUBJECTS must not contain duplicate subjects",
    );
  });

  await t.step("empty entries are refused", async () => {
    const result = await runConfig({
      OAUTH_ALLOWED_SUBJECTS: "auth0|real,,auth0|other",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "OAUTH_ALLOWED_SUBJECTS must be a comma-separated list",
    );
  });

  await t.step(
    "control characters are refused without echoing the value",
    async () => {
      const poisoned = "auth0|bad\u0007subject";
      const result = await runConfig({
        OAUTH_ALLOWED_SUBJECTS: poisoned,
      });
      assertEquals(result.code, 1);
      assertStringIncludes(
        result.stderr,
        "OAUTH_ALLOWED_SUBJECTS entry must be at most 1024 characters and contain no control characters",
      );
      // Boot logs must not become an identity inventory — the refused value
      // itself stays out of the error output.
      assertEquals(result.stderr.includes("auth0|bad"), false);
    },
  );

  await t.step("subject-count limit is enforced", async () => {
    const subjects = Array.from({ length: 257 }, (_, i) => `sub-${i}`);
    const result = await runConfig({
      OAUTH_ALLOWED_SUBJECTS: subjects.join(","),
    });
    assertEquals(result.code, 1);
    assertStringIncludes(
      result.stderr,
      "OAUTH_ALLOWED_SUBJECTS must contain at most 256 subjects",
    );
  });
});
