// Fresh-process tests for the provider-neutral service-subject attribution
// contract. Subjects are identifiers, not credentials, but error output still
// avoids echoing them so boot logs do not become an identity inventory.

import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = `
  const c = await import("./config.ts");
  console.log(JSON.stringify([...c.OAUTH_SERVICE_ACCOUNT_SUBJECTS]));
`;

const BASE_ENV: Record<string, string> = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "",
  MCP_ACCESS_KEY_PRINCIPAL: "",
  AUTH0_ISSUER: "https://issuer.example/",
  AUTH0_JWKS_URI: "https://issuer.example/.well-known/jwks.json",
  AUTH0_AUDIENCE: "https://brain.example/mcp",
  OAUTH_SERVICE_ACCOUNT_SUBJECTS: "",
  METADATA_FALLBACK_POLICY: "off",
};

async function runConfig(overrides: Record<string, string>) {
  const command = new Deno.Command("deno", {
    args: ["eval", SCRIPT],
    cwd: import.meta.dirname!,
    env: { ...BASE_ENV, ...overrides },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

Deno.test("service-account subject config is exact, bounded, and OAuth-only", async (t) => {
  await t.step("empty list is valid", async () => {
    const result = await runConfig({});
    assertEquals(result.code, 0, result.stderr);
    assertEquals(JSON.parse(result.stdout), []);
  });

  await t.step("subjects are trimmed and retain exact case", async () => {
    const result = await runConfig({
      OAUTH_SERVICE_ACCOUNT_SUBJECTS: "service-A, auth0-service@clients",
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(JSON.parse(result.stdout), [
      "service-A",
      "auth0-service@clients",
    ]);
  });

  for (
    const [name, value, expected] of [
      ["empty entry", "service-a,,service-b", "non-empty exact JWT subjects"],
      ["duplicate", "service-a, service-a", "must not contain duplicate"],
      ["control character", "service-a\trole", "control characters"],
      ["oversized entry", "s".repeat(1025), "at most 1024 characters"],
      [
        "too many entries",
        Array.from({ length: 257 }, (_, index) => `service-${index}`).join(","),
        "at most 256 subjects",
      ],
    ] as const
  ) {
    await t.step(`${name} fails without echoing the subject`, async () => {
      const result = await runConfig({
        OAUTH_SERVICE_ACCOUNT_SUBJECTS: value,
      });
      assertEquals(result.code, 1);
      assertStringIncludes(result.stderr, expected);
      assertEquals(result.stderr.includes(value), false);
    });
  }

  await t.step("a configured list requires the OAuth door", async () => {
    const result = await runConfig({
      MCP_ACCESS_KEY: "k".repeat(64),
      AUTH0_ISSUER: "",
      AUTH0_JWKS_URI: "",
      AUTH0_AUDIENCE: "",
      OAUTH_SERVICE_ACCOUNT_SUBJECTS: "service-a",
    });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "requires the OAuth door");
  });
});
