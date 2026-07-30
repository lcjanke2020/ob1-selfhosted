import { assertEquals, assertThrows } from "@std/assert";
import {
  buildTokenRequest,
  decodeJwtPayload,
  parseInitializeResponse,
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
