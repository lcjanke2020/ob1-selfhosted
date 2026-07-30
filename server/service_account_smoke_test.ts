import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildInitializeRequest,
  buildTokenRequest,
  decodeJwtPayload,
  parseInitializeResponse,
  responseText,
} from "../scripts/verify-service-account.ts";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

Deno.test("service-account smoke helper builds provider-specific token requests", async (t) => {
  await t.step("client_secret_post uses a form body", async () => {
    const request = buildTokenRequest({
      tokenUrl: "https://issuer.example/oauth/token",
      clientId: "client id",
      clientSecret: "secret:value",
      audience: "https://brain.example/mcp",
      authMethod: "client_secret_post",
    });
    assertEquals(request.redirect, "error");
    assertEquals(request.headers.has("authorization"), false);
    assertEquals(
      await request.text(),
      "grant_type=client_credentials&audience=https%3A%2F%2Fbrain.example%2Fmcp&client_id=client+id&client_secret=secret%3Avalue",
    );
  });

  await t.step(
    "client_secret_basic encodes credentials in the header",
    async () => {
      const request = buildTokenRequest({
        tokenUrl: "https://issuer.example/oauth/token",
        clientId: "client id",
        clientSecret: "secret:value",
        scope: "brain.read brain.write",
        authMethod: "client_secret_basic",
      });
      assertEquals(request.redirect, "error");
      const authorization = request.headers.get("authorization")!;
      assertEquals(authorization.startsWith("Basic "), true);
      assertEquals(atob(authorization.slice(6)), "client+id:secret%3Avalue");
      assertEquals(
        await request.text(),
        "grant_type=client_credentials&scope=brain.read+brain.write",
      );
    },
  );
});

Deno.test("service-account smoke helper builds a non-redirecting MCP request", async () => {
  const request = buildInitializeRequest(
    "https://brain.example/mcp",
    "header.payload.signature",
  );
  assertEquals(request.redirect, "error");
  assertEquals(
    request.headers.get("authorization"),
    "Bearer header.payload.signature",
  );
  assertEquals((await request.json()).method, "initialize");
});

Deno.test("service-account smoke helper refuses credential-bearing redirects", async (t) => {
  let address: Deno.NetAddr | undefined;
  let sinkRequests = 0;
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen(value) {
        address = value;
      },
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/token-redirect") {
        return new Response(null, {
          status: 307,
          headers: { location: new URL("/sink", request.url).href },
        });
      }
      if (url.pathname === "/mcp-redirect") {
        return new Response(null, {
          status: 308,
          headers: { location: new URL("/sink", request.url).href },
        });
      }
      if (url.pathname === "/sink") {
        sinkRequests++;
        await request.arrayBuffer();
        return new Response("unexpected redirect target");
      }
      return new Response("not found", { status: 404 });
    },
  );

  try {
    if (!address) throw new Error("redirect fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;

    await t.step("307 cannot replay the client-secret form body", async () => {
      const request = buildTokenRequest({
        tokenUrl: `${origin}/token-redirect`,
        clientId: "redirect-test-client",
        clientSecret: "redirect-test-secret",
        authMethod: "client_secret_post",
      });
      await assertRejects(
        () => fetch(request, { signal: AbortSignal.timeout(5_000) }),
        TypeError,
      );
      assertEquals(sinkRequests, 0);
    });

    await t.step("308 cannot replay the MCP bearer request", async () => {
      const request = buildInitializeRequest(
        `${origin}/mcp-redirect`,
        "redirect.test.token",
      );
      await assertRejects(
        () => fetch(request, { signal: AbortSignal.timeout(5_000) }),
        TypeError,
      );
      assertEquals(sinkRequests, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("service-account smoke helper bounds chunked responses while streaming", async () => {
  let chunks = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(700_000));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );

  await assertRejects(
    () => responseText(response),
    Error,
    "remote response exceeded the 1 MiB smoke-test limit",
  );
  assertEquals(chunks >= 2, true);
  assertEquals(cancelled, true);
});

Deno.test("service-account smoke helper decodes JWT identity without accepting opaque tokens", () => {
  assertEquals(
    decodeJwtPayload(
      jwt({ sub: "machine-subject", gty: "client-credentials" }),
    ),
    { sub: "machine-subject", gty: "client-credentials" },
  );
  assertThrows(() => decodeJwtPayload("opaque-token"), Error, "three-part JWT");
});

Deno.test("service-account smoke helper accepts JSON and SSE initialize results", () => {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "open-brain-homelab", version: "1.18.0" },
    },
  };
  assertEquals(
    parseInitializeResponse(JSON.stringify(message), "application/json"),
    message.result,
  );
  assertEquals(
    parseInitializeResponse(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      "text/event-stream",
    ),
    message.result,
  );
});
