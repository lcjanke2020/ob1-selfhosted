// Unit tests for `probeJwksReachability` in auth.ts. The positive
// case (probe succeeds → module loads cleanly) is covered implicitly by
// auth_oauth_test.ts: the fetch mock there returns HTTP 200 with a
// {keys: [publicJwk]} body, which is exactly the shape the probe requires,
// and the boot-time call fires on every `await import("./auth.ts")` in
// that suite.
//
// This file covers the negative cases: the operator misconfigured
// AUTH0_JWKS_URI (typo, stale tenant, reverse-proxy intercept). The
// production code path is the module-level `if (ENABLE_OAUTH) await
// probeJwksReachability(...)` — but exercising that path per-test would
// require either (a) cache-busting the auth.ts import (Deno treats
// `./auth.ts?suffix` as a remote-URL specifier needing --allow-read,
// which the `deno task test` permission set intentionally omits) or
// (b) one separate test file per failure mode (3× boilerplate for what
// is one fail-fast helper). Both are worse than directly unit-testing
// the exported `probeJwksReachability` function. We load auth.ts once
// with ENABLE_OAUTH=false so the module-load probe is skipped, then
// call the function directly per subtest with a per-subtest fetch mock.
//
// Run with: `deno task test` (or `deno test --allow-env
// --allow-net=127.0.0.1 auth_jwks_boot_probe_test.ts`).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { withEnv } from "./api_test_support.ts";

const JWKS_URL = "https://test.invalid/.well-known/jwks.json";
const TEST_ENV = {
  DB_PASSWORD: "test-password",
  // Satisfies the at-least-one-door guard while OAuth stays disabled.
  MCP_ACCESS_KEY: "k".repeat(64),
  OBS_AUTH_EVENTS_ENABLED: "false",
  METADATA_FALLBACK_POLICY: "off",
};

function installFetchMock(
  jwksHandler: (req: Request) => Response | Promise<Response>,
): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url === JWKS_URL) {
      const req = input instanceof Request ? input : new Request(url, init);
      return Promise.resolve(jwksHandler(req));
    }
    return orig(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

async function testJwksProbeFailures(t: Deno.TestContext): Promise<void> {
  await withEnv([], TEST_ENV, async () => {
    // ─── Setup ───────────────────────────────────────────────────────────
    // Load auth.ts with OAuth DISABLED so the module-load probe is skipped.
    // We import the function and exercise it directly with per-subtest
    // fetch mocks — keeps each subtest independent without needing a
    // separate test file per failure mode.
    const { probeJwksReachability } = await import("./auth.ts");

    await t.step(
      "HTTP 500 → throws with status + URL + env-var hint",
      async () => {
        const restore = installFetchMock(() =>
          new Response("upstream sad", {
            status: 500,
            headers: { "Content-Type": "text/plain" },
          })
        );
        try {
          const err = await assertRejects(
            () => probeJwksReachability(JWKS_URL, 1000),
            Error,
          );
          assertStringIncludes(
            err.message,
            "HTTP 500",
            "names the status code",
          );
          assertStringIncludes(err.message, JWKS_URL, "names the URL");
          assertStringIncludes(
            err.message,
            "AUTH0_JWKS_URI",
            "points operators at the relevant env var",
          );
        } finally {
          restore();
        }
      },
    );

    await t.step(
      "200 with non-JSON body → throws with non-JSON hint",
      async () => {
        const restore = installFetchMock(() =>
          new Response("<html><body>oops</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        );
        try {
          const err = await assertRejects(
            () => probeJwksReachability(JWKS_URL, 1000),
            Error,
          );
          assertStringIncludes(
            err.message,
            "non-JSON",
            "names the non-JSON failure mode",
          );
          assertStringIncludes(err.message, JWKS_URL, "names the URL");
        } finally {
          restore();
        }
      },
    );

    await t.step(
      "200 with missing 'keys' array → throws with missing-array hint",
      async () => {
        const restore = installFetchMock(() =>
          new Response(JSON.stringify({ not_keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
        try {
          const err = await assertRejects(
            () => probeJwksReachability(JWKS_URL, 1000),
            Error,
          );
          assertStringIncludes(
            err.message,
            "'keys'",
            "names the missing array field",
          );
          assertStringIncludes(err.message, JWKS_URL, "names the URL");
        } finally {
          restore();
        }
      },
    );

    await t.step(
      "network error → throws with timeout-context message",
      async () => {
        const restore = installFetchMock(() => {
          throw new TypeError("dns: NXDOMAIN");
        });
        try {
          const err = await assertRejects(
            () => probeJwksReachability(JWKS_URL, 1000),
            Error,
          );
          assertStringIncludes(
            err.message,
            "failed to reach",
            "names the failure shape",
          );
          assertStringIncludes(
            err.message,
            "NXDOMAIN",
            "includes the underlying network error",
          );
          assertStringIncludes(err.message, JWKS_URL, "names the URL");
        } finally {
          restore();
        }
      },
    );

    await t.step(
      "timeout while consuming a 200 body stays a reachability failure",
      async () => {
        const restore = installFetchMock((request) => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => controller.error(request.signal.reason),
                { once: true },
              );
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
        try {
          const err = await assertRejects(
            () => probeJwksReachability(JWKS_URL, 20),
            Error,
          );
          assertStringIncludes(err.message, "failed to reach");
          assertStringIncludes(err.message, "request timed out after 20ms");
          assertEquals(err.message.includes("non-JSON"), false);
        } finally {
          restore();
        }
      },
    );

    await t.step(
      "200 with valid {keys: []} body → resolves (probe is best-effort, not strict)",
      async () => {
        // Empty keys can occur briefly during a rotation; the probe must
        // NOT fail on this so a deploy isn't bricked by transient Auth0
        // state. jose's lazy verify will retry on the next request.
        const restore = installFetchMock(() =>
          new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
        try {
          // assertEquals on a resolved promise's return value — `undefined`
          // because probeJwksReachability returns Promise<void>.
          assertEquals(
            await probeJwksReachability(JWKS_URL, 1000),
            undefined,
          );
        } finally {
          restore();
        }
      },
    );
  })();
}

Deno.test("probeJwksReachability — negative cases", testJwksProbeFailures);
