import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  auditDeploymentPolicy,
  auditExampleEnvironment,
  auditForwardingRules,
  auditServerEnvironment,
  auditServerPlacement,
  collectComposeInterpolationVariables,
  composeFixtureValue,
  type ComposeSnapshot,
  type DeploymentPolicy,
  type ExampleVariableInventory,
  parseComposeVariableMetadata,
  parseExampleEnvironment,
  type UnknownRecord,
} from "./compose_env_audit.ts";
import {
  allowEnvComposeStacks,
  auditDeploymentManifest,
  COMPOSE_FILES,
  composeFilePaths,
  DOCUMENTED_DEPLOYMENTS,
  EXAMPLE_CONTRACTS,
  type ManifestAuditInput,
} from "./compose_deployments.ts";
import { renderComposeConfig } from "./check_allow_env.ts";

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

Deno.test("Compose variable inventory preserves required and default metadata", () => {
  const variables = parseComposeVariableMetadata({
    REQUIRED: { Name: "REQUIRED", Required: true, DefaultValue: "" },
    DEFAULTED: {
      Name: "DEFAULTED",
      Required: false,
      DefaultValue: "15000",
    },
  });

  assertEquals(variables.get("REQUIRED"), {
    name: "REQUIRED",
    required: true,
    defaultValue: "",
    source: "compose",
  });
  assertEquals(variables.get("DEFAULTED"), {
    name: "DEFAULTED",
    required: false,
    defaultValue: "15000",
    source: "compose",
  });
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

function variableInventory(
  definitions: Readonly<
    Record<string, { defaultValue?: string; required?: boolean }>
  >,
): ExampleVariableInventory {
  return new Map(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      [{
        name,
        shape: "mutation",
        required: definition.required ?? false,
        defaultValue: definition.defaultValue ?? "",
        source: "compose" as const,
      }],
    ]),
  );
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
    variableInventory({ FIRST: {}, SECOND: {} }),
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
  assertStringIncludes(drifted.join("\n"), "reviewed expression pair");
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
    "does not match the reviewed expression pair",
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
    variableInventory({ EXPECTED: {} }),
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

Deno.test("required Compose metadata requires an active example assignment", () => {
  const commented = parseExampleEnvironment(
    "# REQUIRED_VALUE=choose-me\n# TIMEOUT_MS=15000\n",
  );
  const issues = auditExampleEnvironment(
    "metadata-mutation",
    variableInventory({
      REQUIRED_VALUE: { required: true },
      TIMEOUT_MS: { defaultValue: "16000" },
    }),
    commented,
  );

  assertStringIncludes(issues.join("\n"), "must actively assign");
  assertStringIncludes(issues.join("\n"), "Compose defaults to 16000");

  const pinned = auditExampleEnvironment(
    "metadata-pin",
    variableInventory({
      REQUIRED_VALUE: { required: true },
      TIMEOUT_MS: { defaultValue: "16000" },
    }),
    parseExampleEnvironment("REQUIRED_VALUE=\nTIMEOUT_MS=15000\n"),
    {
      valuePins: {
        TIMEOUT_MS: {
          value: "15000",
          rationale: "This deployment deliberately uses a shorter timeout.",
        },
      },
    },
  );
  assertEquals(pinned, []);

  const stalePin = auditExampleEnvironment(
    "metadata-stale-pin",
    variableInventory({ TIMEOUT_MS: { defaultValue: "15000" } }),
    parseExampleEnvironment("TIMEOUT_MS=15000\n"),
    {
      valuePins: {
        TIMEOUT_MS: {
          value: "15000",
          rationale: "This used to differ from Compose.",
        },
      },
    },
  );
  assertStringIncludes(stalePin.join("\n"), "value-pin policy");
  assertStringIncludes(stalePin.join("\n"), "is stale");
});

Deno.test("shared forwarding rules reject unknown, stale, and unexplained entries", () => {
  const issues = auditForwardingRules(new Set(["KNOWN"]), {
    KNOWN: { kind: "variable", name: "KNOWN", rationale: "" },
    RETIRED: {
      kind: "literal",
      value: "fixed",
      rationale: "No longer supported.",
    },
  });

  assertStringIncludes(issues.join("\n"), "empty rationale");
  assertStringIncludes(issues.join("\n"), "identity forwarding is implicit");
  assertStringIncludes(issues.join("\n"), "unknown server key RETIRED");
});

Deno.test("deployment policy validation fails fast for invalid table entries", () => {
  const cases: ReadonlyArray<{
    expected: string;
    policy: DeploymentPolicy;
  }> = [
    {
      expected: "empty rationale",
      policy: { omissions: { FIRST: "" } },
    },
    {
      expected: "unknown server key RETIRED",
      policy: {
        pins: {
          RETIRED: { value: "fixed", rationale: "No longer supported." },
        },
      },
    },
    {
      expected: "conflicting policy categories",
      policy: {
        omissions: { FIRST: "Omit it." },
        pins: { FIRST: { value: "fixed", rationale: "Pin it." } },
      },
    },
  ];

  for (const mutation of cases) {
    assertStringIncludes(
      auditDeploymentPolicy(
        "policy-mutation",
        new Set(["FIRST"]),
        mutation.policy,
      ).join("\n"),
      mutation.expected,
    );
  }
});

Deno.test("manifest keeps all overlay subsets distinct from documented deployments", () => {
  assertEquals(auditDeploymentManifest(), []);
  assertEquals(allowEnvComposeStacks().length, 10);
  assertEquals(DOCUMENTED_DEPLOYMENTS.length, 8);

  const documented = new Set(
    DOCUMENTED_DEPLOYMENTS.map((shape) => shape.files.join("+")),
  );
  assert(!documented.has("local+cpuOllama"));
  assert(!documented.has("local+patternB+cpuOllama"));
  assert(
    allowEnvComposeStacks().some((stack) =>
      stack.files.join("+") === "local+cpuOllama"
    ),
  );
});

Deno.test("manifest validation rejects invalid shape combinations", () => {
  const base: ManifestAuditInput = {
    files: COMPOSE_FILES,
    examples: EXAMPLE_CONTRACTS,
    deployments: DOCUMENTED_DEPLOYMENTS,
  };
  const cases = [
    {
      expected: "repeats shape name",
      deployments: DOCUMENTED_DEPLOYMENTS.map((shape, index) =>
        index === 1 ? { ...shape, name: DOCUMENTED_DEPLOYMENTS[0].name } : shape
      ),
    },
    {
      expected: "server-absent shape cannot carry server policy",
      deployments: DOCUMENTED_DEPLOYMENTS.map((shape) =>
        shape.server.kind === "absent"
          ? {
            ...shape,
            server: { ...shape.server, policy: {} },
          }
          : shape
      ),
    },
    {
      expected: "references unknown example group",
      deployments: DOCUMENTED_DEPLOYMENTS.map((shape, index) =>
        index === 0 ? { ...shape, exampleGroup: "missing" } : shape
      ),
    },
  ];

  for (const mutation of cases) {
    const issues = auditDeploymentManifest({
      ...base,
      deployments: mutation.deployments,
    } as unknown as ManifestAuditInput);
    assertStringIncludes(issues.join("\n"), mutation.expected);
  }

  const optionalPolicy = DOCUMENTED_DEPLOYMENTS.map((shape, index) =>
    index === 0 ? { ...shape, server: { kind: "present" as const } } : shape
  );
  assertEquals(
    auditDeploymentManifest({
      ...base,
      deployments: optionalPolicy,
    }),
    [],
  );
});

Deno.test("un-interpolated oracle audits tools without making it a deployment", () => {
  const files = composeFilePaths(["local"]);
  const uninterpolated = renderComposeConfig(files);
  const interpolated = renderComposeConfig(files, {
    environment: { METADATA_FALLBACK_POLICY: "off" },
    interpolate: true,
  });
  const rawServices = uninterpolated.services as UnknownRecord;
  const activeServices = interpolated.services as UnknownRecord;

  assert(Object.hasOwn(rawServices, "token-admin"));
  assert(!Object.hasOwn(activeServices, "token-admin"));
  assert(
    !DOCUMENTED_DEPLOYMENTS.some((shape) => shape.profiles?.includes("tools")),
  );
});
