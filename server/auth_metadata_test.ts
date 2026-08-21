// Tests for `deriveProtectedResourceMetadata` — the RFC 9728 §3.1
// transformation that inserts `/.well-known/oauth-protected-resource` between
// the host and the resource path. Run with `deno task test`.
//
// Hermetic: the shared server-env fixture supplies the static-key door and
// clears ambient OAuth configuration before auth.ts loads.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { withEnv } from "./api_test_support.ts";

const TEST_ENV = {
  DB_PASSWORD: "test-password",
  MCP_ACCESS_KEY: "0".repeat(64),
  // Importing auth.ts also imports the audit emitter.
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
};

async function testProtectedResourceMetadata(
  t: Deno.TestContext,
): Promise<void> {
  await withEnv([], TEST_ENV, async () => {
    const {
      buildProtectedResourceMetadata,
      deriveProtectedResourceMetadata,
    } = await import("./auth.ts");

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
      const r = deriveProtectedResourceMetadata(
        "https://host.example/mcp///",
      );
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

    await t.step(
      "protected-resource document omits zero-valued scopes",
      () => {
        const document = buildProtectedResourceMetadata(
          "https://host.example/mcp",
          "https://issuer.example/",
        );
        assertEquals(document, {
          resource: "https://host.example/mcp",
          authorization_servers: ["https://issuer.example/"],
          bearer_methods_supported: ["header"],
        });
        assertEquals("scopes_supported" in document, false);
      },
    );
  })();
}

Deno.test(
  "deriveProtectedResourceMetadata (RFC 9728 §3.1)",
  testProtectedResourceMetadata,
);
