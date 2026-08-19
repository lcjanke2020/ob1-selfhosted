import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  auditExampleEnvironment,
  auditServerEnvironment,
  auditServerPlacement,
  collectComposeInterpolationVariables,
  composeFixtureValue,
  type ComposeSnapshot,
  parseExampleEnvironment,
} from "./check_compose_env.ts";

Deno.test("interpolation inventory includes raw Compose variables but not escaped shell variables", () => {
  const variables = collectComposeInterpolationVariables({
    environment: [
      "PLAIN=$PLAIN",
      "DEFAULTED=${DEFAULTED:-value}",
      "REQUIRED=${REQUIRED:?set REQUIRED}",
      "ESCAPED=$$SHELL_VARIABLE",
    ],
    volume: { source: "/base/${BIND_SOURCE:?set BIND_SOURCE}" },
  });

  assertEquals(
    [...variables].sort(),
    ["BIND_SOURCE", "DEFAULTED", "PLAIN", "REQUIRED"],
  );
});

function snapshot(
  keys: readonly string[],
  overrides: Partial<ComposeSnapshot> = {},
): ComposeSnapshot {
  return {
    environment: Object.fromEntries(
      keys.map((key) => [key, composeFixtureValue(key)]),
    ),
    rawEnvironment: Object.fromEntries(
      keys.map((key) => [key, "${" + key + ":-}"]),
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
    rawEnvironment: { FIRST: "${FIRST:?set FIRST}" },
  });
  const policy = {
    expressionDifferences: {
      FIRST: {
        baselineValue: "${FIRST:-}",
        value: "${FIRST:?set FIRST}",
        rationale: "This deployment requires the value at render time.",
      },
    },
  };
  const issues = auditServerEnvironment(
    "allowed-mutation",
    new Set(["FIRST"]),
    deployment,
    baseline,
    policy,
  );
  const drifted = auditServerEnvironment(
    "drifted-mutation",
    new Set(["FIRST"]),
    snapshot(["FIRST"], {
      rawEnvironment: { FIRST: "${FIRST?set FIRST}" },
    }),
    baseline,
    policy,
  );

  assertEquals(issues, []);
  assertStringIncludes(drifted.join("\n"), "reviewed forwarding expression");
  assertStringIncludes(
    auditServerEnvironment(
      "drifted-baseline",
      new Set(["FIRST"]),
      deployment,
      snapshot(["FIRST"], {
        rawEnvironment: { FIRST: "${FIRST-}" },
      }),
      policy,
    ).join("\n"),
    "requires compose-local forwarding expression",
  );
});

Deno.test("baseline expression pin rejects default or operator drift", () => {
  const issues = auditServerEnvironment(
    "baseline-mutation",
    new Set(["FETCH_TIMEOUT_MS"]),
    snapshot(["FETCH_TIMEOUT_MS"], {
      rawEnvironment: { FETCH_TIMEOUT_MS: "${FETCH_TIMEOUT_MS-99999}" },
    }),
    undefined,
    {
      expressionPins: {
        FETCH_TIMEOUT_MS: {
          value: "${FETCH_TIMEOUT_MS:-15000}",
          rationale: "The documented default is fifteen seconds.",
        },
      },
    },
  );

  assertEquals(issues.length, 1);
  assertStringIncludes(issues[0], "must keep forwarding expression");
});

Deno.test("deployment difference rejects missing or empty rationale", () => {
  const baseline = snapshot(["FIRST"]);
  const deployment = snapshot(["FIRST"], {
    rawEnvironment: { FIRST: "${FIRST?set FIRST}" },
  });
  const unreviewed = auditServerEnvironment(
    "unreviewed-mutation",
    new Set(["FIRST"]),
    deployment,
    baseline,
  );
  const emptyRationale = auditServerEnvironment(
    "empty-rationale-mutation",
    new Set(["FIRST"]),
    deployment,
    baseline,
    {
      expressionDifferences: {
        FIRST: {
          baselineValue: "${FIRST:-}",
          value: "${FIRST?set FIRST}",
          rationale: "",
        },
      },
    },
  );

  assertStringIncludes(unreviewed.join("\n"), "without an allowlist rationale");
  assertStringIncludes(emptyRationale.join("\n"), "has an empty rationale");
});

Deno.test("example inventory observes export and lowercase dotenv assignments", () => {
  const example = parseExampleEnvironment(
    "EXPECTED=\nlowercase_extra=value\nexport EXPORTED_EXTRA=value\n",
  );
  const issues = auditExampleEnvironment(
    "dotenv-mutation",
    new Set(["EXPECTED"]),
    example,
  );

  assertEquals(issues.length, 2);
  assertStringIncludes(issues.join("\n"), "lowercase_extra");
  assertStringIncludes(issues.join("\n"), "EXPORTED_EXTRA");
});

Deno.test("example inventory fails closed on unsupported dotenv forms", () => {
  for (const line of ["BARE_EXTRA", "colon_extra: value"]) {
    assertThrows(
      () => parseExampleEnvironment(`EXPECTED=value\n${line}\n`),
      Error,
      "unsupported dotenv syntax",
    );
  }
});

Deno.test("literal pins reject conditional interpolation", () => {
  const issues = auditServerEnvironment(
    "conditional-literal",
    new Set(["FIRST"]),
    snapshot(["FIRST"], {
      environment: { FIRST: "fixed" },
      rawEnvironment: { FIRST: "${FIRST:+fixed}" },
    }),
    undefined,
    {
      pins: {
        FIRST: {
          value: "fixed",
          rationale: "This value must not depend on operator input.",
        },
      },
    },
  );

  assertEquals(issues.length, 1);
  assertStringIncludes(issues[0], "must be a literal");
});

Deno.test("server placement follows launcher identity rather than service name", () => {
  assertEquals(auditServerPlacement("local", ["mcp"]), []);
  assertStringIncludes(
    auditServerPlacement(
      "ingress",
      ["brain"],
      "The ingress deployment must not run the server.",
    ).join("\n"),
    "server launcher must be absent",
  );
});

Deno.test("deployment policy categories must be disjoint", () => {
  const issues = auditServerEnvironment(
    "conflicting-policy",
    new Set(["FIRST"]),
    snapshot(["FIRST"]),
    snapshot(["FIRST"]),
    {
      pins: {
        FIRST: {
          value: composeFixtureValue("FIRST"),
          rationale: "Pin the value.",
        },
      },
      expressionDifferences: {
        FIRST: {
          baselineValue: "${FIRST:-}",
          value: "${FIRST:?set FIRST}",
          rationale: "Change the expression.",
        },
      },
    },
  );

  assertStringIncludes(issues.join("\n"), "conflicting policy categories");
});
