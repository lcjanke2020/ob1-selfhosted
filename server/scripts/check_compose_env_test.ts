import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditExampleEnvironment,
  auditServerEnvironment,
  composeFixtureValue,
  type ComposeSnapshot,
  parseExampleEnvironment,
} from "./check_compose_env.ts";

function snapshot(
  keys: readonly string[],
  overrides: Partial<ComposeSnapshot> = {},
): ComposeSnapshot {
  return {
    environment: Object.fromEntries(
      keys.map((key) => [key, composeFixtureValue(key)]),
    ),
    variables: Object.fromEntries(
      keys.map((key) => [key, { required: false, defaultValue: "" }]),
    ),
    ...overrides,
  };
}

Deno.test("environment parity reports a missing forwarded key", () => {
  const issues = auditServerEnvironment(
    "mutation",
    new Set(["FIRST", "SECOND"]),
    snapshot(["FIRST"]),
    undefined,
  );

  assertEquals(issues.length, 1);
  assertStringIncludes(issues[0], "missing supported key SECOND");
});

Deno.test("environment parity reports an undocumented extra key", () => {
  const issues = auditServerEnvironment(
    "mutation",
    new Set(["FIRST"]),
    snapshot(["FIRST", "SURPRISE"]),
    undefined,
  );

  assertEquals(issues.length, 1);
  assertStringIncludes(issues[0], "undocumented extra key SURPRISE");
});

Deno.test("example parity reports drift from Compose variable inventory", () => {
  const example = parseExampleEnvironment(
    "FIRST=\n# SECOND is described but not declared\n",
  );
  const issues = auditExampleEnvironment(
    "mutation",
    new Set(["FIRST", "SECOND"]),
    example,
  );

  assertEquals(issues.length, 1);
  assertStringIncludes(issues[0], "missing Compose variable SECOND");
});

Deno.test("rationale-bearing deployment difference is accepted and pinned", () => {
  const baseline = snapshot(["FIRST"]);
  const deployment = snapshot(["FIRST"], {
    variables: {
      FIRST: { required: true, defaultValue: "" },
    },
  });
  const issues = auditServerEnvironment(
    "allowed-mutation",
    new Set(["FIRST"]),
    deployment,
    baseline,
    {
      variableDifferences: {
        FIRST: "This deployment requires the value at render time.",
      },
    },
  );

  assertEquals(issues, []);
});
