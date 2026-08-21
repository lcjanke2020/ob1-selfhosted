import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  FakeClient,
  makeAuthTestApp,
  makeJwksFixture,
  runConfigSubprocess,
  SERVER_ENV_KEYS,
  withEnv,
} from "./api_test_support.ts";

function restoreEnv(original: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of original) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

Deno.test("withEnv clears the canonical baseline and restores on throw", async () => {
  const extraKey = "OB1_TEST_SUPPORT_EXTRA";
  const keys = ["DB_PASSWORD", "AUTH0_ISSUER", extraKey];
  const original = new Map(keys.map((key) => [key, Deno.env.get(key)]));
  Deno.env.set("DB_PASSWORD", "ambient-password");
  Deno.env.set("AUTH0_ISSUER", "https://ambient.invalid/");
  Deno.env.delete(extraKey);

  try {
    const wrapped = withEnv(
      [extraKey],
      {
        DB_PASSWORD: "fixture-password",
        [extraKey]: "fixture-extra",
      },
      (argument: string) => {
        assertEquals(argument, "forwarded");
        assertEquals(Deno.env.get("DB_PASSWORD"), "fixture-password");
        assertEquals(Deno.env.get(extraKey), "fixture-extra");
        assertEquals(
          Deno.env.get("AUTH0_ISSUER"),
          undefined,
          "unmentioned canonical keys are cleared",
        );
        throw new Error("fixture callback failed");
      },
    );

    await assertRejects(
      () => wrapped("forwarded"),
      Error,
      "fixture callback failed",
    );
    assertEquals(Deno.env.get("DB_PASSWORD"), "ambient-password");
    assertEquals(Deno.env.get("AUTH0_ISSUER"), "https://ambient.invalid/");
    assertEquals(Deno.env.get(extraKey), undefined);
  } finally {
    restoreEnv(original);
  }
});

Deno.test("test env baseline matches the production Docker launcher grant", async () => {
  const dockerfile = await Deno.readTextFile(
    new URL("./Dockerfile", import.meta.url),
  );
  const match = dockerfile.match(/--allow-env=([A-Z0-9_,]+)/);
  if (!match) throw new Error("Dockerfile has no bounded --allow-env launcher");
  assertEquals(
    [...SERVER_ENV_KEYS].sort(),
    match[1].split(",").sort(),
  );
});

Deno.test("JWKS fixture signs a token the remote verifier accepts", async () => {
  const fixture = await makeJwksFixture({
    issuer: "https://issuer.invalid/",
    audience: "https://brain.invalid/mcp",
    subject: "fixture-subject",
  });
  const restoreFetch = fixture.installFetchMock();
  try {
    const token = await fixture.signToken({
      claims: { sub: "fixture-subject", gty: "client-credentials" },
    });
    const verified = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(fixture.jwksUrl)),
      { issuer: fixture.issuer, audience: fixture.audience },
    );
    assertEquals(verified.payload.sub, "fixture-subject");
    assertEquals(verified.payload.gty, "client-credentials");
    assertEquals(fixture.fetchCount, 1);
  } finally {
    restoreFetch();
  }
});

Deno.test("FakeClient rejects unscripted DB work", async () => {
  const client = new FakeClient(() => undefined);
  await assertRejects(
    () => client.queryArray("DELETE FROM missing_fixture"),
    Error,
    "unscripted queryArray: DELETE FROM missing_fixture",
  );
  await assertRejects(
    () => client.queryObject("SELECT secret FROM missing_fixture"),
    Error,
    "unscripted queryObject: SELECT secret FROM missing_fixture",
  );
});

Deno.test(
  "config subprocess helper clears ambient server env and captures output",
  withEnv([], { AUTH0_ISSUER: "https://ambient.invalid/" }, async () => {
    const result = await runConfigSubprocess(
      `console.log(JSON.stringify({value:Deno.env.get("FIXTURE_VALUE"),issuer:Deno.env.get("AUTH0_ISSUER")??null})); console.error("diagnostic")`,
      { FIXTURE_VALUE: "base" },
      { FIXTURE_VALUE: "override" },
    );
    assertEquals(result.code, 0, result.stderr);
    assertStrictEquals(result.success, true);
    assertEquals(JSON.parse(result.stdout), {
      value: "override",
      issuer: null,
    });
    assertEquals(result.stderr, "diagnostic");
  }),
);

Deno.test("auth app helper installs middleware before the sentinel handler", async () => {
  const app = makeAuthTestApp(async (context, next) => {
    context.header("x-fixture-middleware", "seen");
    await next();
  });
  const response = await app.request("/");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-fixture-middleware"), "seen");
  assertEquals(await response.json(), { ok: true });
});
