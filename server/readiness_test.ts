import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { readinessResponse } from "./readiness.ts";

Deno.test("readiness success preserves the connected response", async () => {
  let logCalls = 0;
  const response = await readinessResponse(
    () => Promise.resolve(),
    "db.internal.example:5432",
    () => logCalls++,
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, db: "connected" });
  assertEquals(logCalls, 0);
});

Deno.test("readiness failure logs DB detail without exposing it in the 503 body", async () => {
  const dbTarget = "db.internal.example:5432";
  const driverDetail =
    'password authentication failed for user "openbrain_app"';
  const logged: Array<{ dbTarget: string; error: unknown }> = [];

  const response = await readinessResponse(
    () => Promise.reject(new Error(driverDetail)),
    dbTarget,
    (target, error) => logged.push({ dbTarget: target, error }),
  );
  const body = await response.text();

  assertEquals(response.status, 503);
  assertEquals(JSON.parse(body), {
    ok: false,
    error: "database unavailable",
  });
  assert(!body.includes("openbrain_app"));
  assert(!body.includes(dbTarget));
  assertEquals(logged.length, 1);
  assertEquals(logged[0].dbTarget, dbTarget);
  assertStringIncludes((logged[0].error as Error).message, driverDetail);
});

Deno.test("default readiness failure logger names the DB target", async () => {
  const dbTarget = "db.internal.example:5432";
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await readinessResponse(
      () => Promise.reject(new Error("connection refused")),
      dbTarget,
    );
  } finally {
    console.error = originalError;
  }

  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], dbTarget);
});
