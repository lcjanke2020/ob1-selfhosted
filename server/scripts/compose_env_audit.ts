// Pure policy and audit functions for the rendered Compose environment
// contract. This module performs no filesystem, process, or CLI operations.

export type UnknownRecord = Record<string, unknown>;

export type ComposeEnvironmentValue = string | number | boolean | null;

export interface ComposeSnapshot {
  environment: Readonly<Record<string, string>>;
  rawEnvironment: Readonly<Record<string, ComposeEnvironmentValue>>;
}

interface ExpressionPolicy {
  rationale: string;
  value: ComposeEnvironmentValue;
}

interface ExpressionDifferencePolicy extends ExpressionPolicy {
  baselineValue: ComposeEnvironmentValue;
}

export interface DeploymentPolicy {
  expressionDifferences?: Readonly<
    Record<string, ExpressionDifferencePolicy>
  >;
  expressionPins?: Readonly<Record<string, ExpressionPolicy>>;
  omissions?: Readonly<Record<string, string>>;
  pins?: Readonly<Record<string, { rationale: string; value: string }>>;
}

export type ForwardingRule =
  | { kind: "literal"; rationale: string; value: string }
  | { kind: "variable"; name: string; rationale: string };

export type ForwardingRules = Readonly<Record<string, ForwardingRule>>;

export interface ExampleEnvironment {
  active: ReadonlyMap<string, string>;
  declared: ReadonlyMap<string, string>;
  keys: ReadonlySet<string>;
}

export interface ExamplePolicy {
  allowedExtras?: Readonly<Record<string, string>>;
  valuePins?: Readonly<
    Record<string, { rationale: string; value: string }>
  >;
}

export type ComposeVariableMetadata =
  | {
    defaultValue: string;
    name: string;
    required: boolean;
    source: "compose";
  }
  | {
    defaultValue: null;
    name: string;
    required: null;
    source: "raw-model-fallback";
  };

export type ComposeVariableUsage = ComposeVariableMetadata & { shape: string };

export type ExampleVariableInventory = ReadonlyMap<
  string,
  readonly ComposeVariableUsage[]
>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rationaleIssues(
  category: string,
  entries: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(entries).flatMap(([key, rationale]) =>
    rationale.trim().length === 0
      ? [`${category}: ${key} has an empty rationale`]
      : []
  );
}

export function composeFixtureValue(name: string): string {
  if (name === "LOG_SINK_SOCKET_DIR") {
    return "/tmp/openbrain-compose-parity";
  }
  if (name === "INGESTER_DB_HOST") return "/var/run/postgresql";
  return `compose-parity-${name.toLowerCase().replaceAll("_", "-")}`;
}

export function auditForwardingRules(
  supportedKeys: ReadonlySet<string>,
  rules: ForwardingRules,
): string[] {
  const issues: string[] = [];
  for (const [key, rule] of Object.entries(rules)) {
    if (!supportedKeys.has(key)) {
      issues.push(`shared forwarding rule names unknown server key ${key}`);
    }
    if (rule.rationale.trim().length === 0) {
      issues.push(`shared forwarding rule for ${key} has an empty rationale`);
    }
    if (rule.kind === "variable") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.name)) {
        issues.push(
          `shared forwarding rule for ${key} has invalid variable ${rule.name}`,
        );
      } else if (rule.name === key) {
        issues.push(
          `shared forwarding rule for ${key} is stale; identity forwarding is implicit`,
        );
      }
    }
  }
  return issues;
}

export function auditDeploymentPolicy(
  name: string,
  supportedKeys: ReadonlySet<string>,
  policy: DeploymentPolicy,
): string[] {
  const issues: string[] = [];
  const expressionDifferences = policy.expressionDifferences ?? {};
  const expressionPins = policy.expressionPins ?? {};
  const omissions = policy.omissions ?? {};
  const pins = policy.pins ?? {};

  issues.push(...rationaleIssues(`${name} omission policy`, omissions));
  for (const [key, pin] of Object.entries(pins)) {
    if (pin.rationale.trim().length === 0) {
      issues.push(`${name} pin policy: ${key} has an empty rationale`);
    }
  }
  for (
    const [category, entries] of [
      ["expression-difference", expressionDifferences],
      ["expression-pin", expressionPins],
    ] as const
  ) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.rationale.trim().length === 0) {
        issues.push(
          `${name} ${category} policy: ${key} has an empty rationale`,
        );
      }
    }
  }

  const categories = [
    ["expression difference", expressionDifferences],
    ["expression pin", expressionPins],
    ["omission", omissions],
    ["literal pin", pins],
  ] as const;
  const policyKeys = new Set(
    categories.flatMap(([, entries]) => Object.keys(entries)),
  );
  for (const key of policyKeys) {
    const present = categories.filter(([, entries]) =>
      Object.hasOwn(entries, key)
    ).map(([category]) => category);
    if (present.length > 1) {
      issues.push(
        `${name}: ${key} appears in conflicting policy categories: ${
          present.join(", ")
        }`,
      );
    }
    if (!supportedKeys.has(key)) {
      issues.push(`${name}: policy names unknown server key ${key}`);
    }
  }
  return issues;
}

function forwardingRule(
  key: string,
  policy: DeploymentPolicy,
  sharedRules: ForwardingRules,
): ForwardingRule | { kind: "variable"; name: string } {
  const pin = policy.pins?.[key];
  if (pin) {
    return { kind: "literal", value: pin.value, rationale: pin.rationale };
  }
  return sharedRules[key] ?? { kind: "variable", name: key };
}

export function auditServerEnvironment(
  name: string,
  supportedKeys: ReadonlySet<string>,
  snapshot: ComposeSnapshot,
  baseline: ComposeSnapshot | undefined,
  policy: DeploymentPolicy = {},
  sharedRules: ForwardingRules = {},
): string[] {
  const issues = auditDeploymentPolicy(name, supportedKeys, policy);
  const expressionDifferences = policy.expressionDifferences ?? {};
  const expressionPins = policy.expressionPins ?? {};
  const omissions = policy.omissions ?? {};

  const actualKeys = new Set(Object.keys(snapshot.environment));
  const rawKeys = new Set(Object.keys(snapshot.rawEnvironment));
  for (const key of supportedKeys) {
    if (Object.hasOwn(omissions, key)) {
      if (actualKeys.has(key)) {
        issues.push(
          `${name}: omission allowlist for ${key} is stale; the key is present`,
        );
      }
      continue;
    }
    if (!actualKeys.has(key)) {
      issues.push(`${name}: mcp environment is missing supported key ${key}`);
    }
  }
  for (const key of actualKeys) {
    if (!supportedKeys.has(key)) {
      issues.push(`${name}: mcp environment has undocumented extra key ${key}`);
    }
  }
  for (const key of actualKeys) {
    if (!rawKeys.has(key)) {
      issues.push(
        `${name}: un-interpolated mcp environment is missing rendered key ${key}`,
      );
    }
  }
  for (const key of rawKeys) {
    if (!actualKeys.has(key)) {
      issues.push(
        `${name}: un-interpolated mcp environment has unmatched key ${key}`,
      );
    }
  }

  for (const [key, expected] of Object.entries(expressionPins)) {
    if (!supportedKeys.has(key) || !rawKeys.has(key)) continue;
    const rule = forwardingRule(key, policy, sharedRules);
    if (rule.kind !== "variable") {
      issues.push(
        `${name}: expression pin for ${key} cannot target a literal forwarding rule`,
      );
      continue;
    }
    const actual = snapshot.rawEnvironment[key];
    if (!Object.is(actual, expected.value)) {
      issues.push(
        `${name}: ${key} must keep forwarding expression ${
          JSON.stringify(expected.value)
        }; got ${JSON.stringify(actual)}`,
      );
    }
  }

  const observedExpressionDifferences = new Set<string>();
  for (const key of supportedKeys) {
    if (!actualKeys.has(key)) continue;
    const rule = forwardingRule(key, policy, sharedRules);
    const actual = snapshot.environment[key];
    if (rule.kind === "literal") {
      if (actual !== rule.value) {
        issues.push(
          `${name}: ${key} must be pinned to ${
            JSON.stringify(rule.value)
          }; got ${JSON.stringify(actual)}`,
        );
      }
      const raw = snapshot.rawEnvironment[key];
      if (rawKeys.has(key) && !Object.is(raw, rule.value)) {
        issues.push(
          `${name}: ${key} must be a literal ${
            JSON.stringify(rule.value)
          } in un-interpolated Compose; got ${JSON.stringify(raw)}`,
        );
      }
      continue;
    }

    const expected = composeFixtureValue(rule.name);
    if (actual !== expected) {
      issues.push(
        `${name}: ${key} does not forward ${rule.name}; expected sentinel ${
          JSON.stringify(expected)
        }, got ${JSON.stringify(actual)}`,
      );
    }

    if (!baseline) continue;
    if (!Object.hasOwn(baseline.rawEnvironment, key)) {
      issues.push(
        `${name}: compose-local baseline has no forwarding expression for ${key}`,
      );
      continue;
    }
    if (!Object.hasOwn(snapshot.rawEnvironment, key)) continue;
    const baselineExpression = baseline.rawEnvironment[key];
    const expression = snapshot.rawEnvironment[key];
    const differs = !Object.is(expression, baselineExpression);
    const allowed = expressionDifferences[key];
    if (differs) observedExpressionDifferences.add(key);
    if (allowed) {
      if (
        !Object.is(baselineExpression, allowed.baselineValue) ||
        !Object.is(expression, allowed.value)
      ) {
        issues.push(
          `${name}: ${key} does not match the reviewed expression pair; ` +
            `expected compose-local ${JSON.stringify(allowed.baselineValue)} ` +
            `and ${name} ${JSON.stringify(allowed.value)}, got compose-local ${
              JSON.stringify(baselineExpression)
            } and ${name} ${JSON.stringify(expression)}`,
        );
      }
      if (!differs) {
        issues.push(
          `${name}: expression-difference allowlist for ${key} is stale; it matches compose-local`,
        );
      }
    } else if (differs) {
      issues.push(
        `${name}: ${key} changes its mcp forwarding expression from ${
          JSON.stringify(baselineExpression)
        } to ${JSON.stringify(expression)} without an allowlist rationale`,
      );
    }
  }

  for (const key of Object.keys(expressionDifferences)) {
    if (!supportedKeys.has(key)) continue;
    const rule = forwardingRule(key, policy, sharedRules);
    if (rule.kind !== "variable") {
      issues.push(
        `${name}: expression difference for ${key} cannot target a literal forwarding rule`,
      );
    } else if (!baseline) {
      issues.push(
        `${name}: expression difference for ${key} cannot be declared on the baseline`,
      );
    } else if (
      !observedExpressionDifferences.has(key) && !actualKeys.has(key)
    ) {
      issues.push(
        `${name}: expression difference for ${key} is not observable`,
      );
    }
  }
  return issues;
}

export function parseExampleEnvironment(content: string): ExampleEnvironment {
  const keys = new Set<string>();
  const active = new Map<string, string>();
  const declared = new Map<string, string>();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(
      /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
    );
    if (!match) {
      const candidate = line.trim();
      if (candidate.length > 0 && !candidate.startsWith("#")) {
        throw new Error(
          `.env.example:${index + 1}: unsupported dotenv syntax; use KEY=value`,
        );
      }
      continue;
    }
    const [, comment, key, rawValue] = match;
    const value = rawValue.trim();
    keys.add(key);
    if (comment) {
      if (!active.has(key)) declared.set(key, value);
      continue;
    }
    if (active.has(key)) {
      throw new Error(
        `.env.example:${index + 1}: duplicate active assignment for ${key}`,
      );
    }
    active.set(key, value);
    declared.set(key, value);
  }
  return { keys, active, declared };
}

export function parseComposeVariableMetadata(
  document: UnknownRecord,
): ReadonlyMap<string, ComposeVariableMetadata> {
  const variables = new Map<string, ComposeVariableMetadata>();
  for (const [key, raw] of Object.entries(document)) {
    if (
      !isRecord(raw) || raw.Name !== key ||
      typeof raw.Required !== "boolean" ||
      typeof raw.DefaultValue !== "string"
    ) {
      throw new Error(
        `docker compose config --variables returned an unsupported record for ${key}`,
      );
    }
    variables.set(key, {
      name: key,
      required: raw.Required,
      defaultValue: raw.DefaultValue,
      source: "compose",
    });
  }
  return variables;
}

export function groupComposeVariables(
  inventories: readonly {
    shape: string;
    variables: ReadonlyMap<string, ComposeVariableMetadata>;
  }[],
): ExampleVariableInventory {
  const grouped = new Map<string, ComposeVariableUsage[]>();
  for (const inventory of inventories) {
    for (const variable of inventory.variables.values()) {
      const usages = grouped.get(variable.name) ?? [];
      usages.push({ ...variable, shape: inventory.shape });
      grouped.set(variable.name, usages);
    }
  }
  return grouped;
}

export function auditExampleEnvironment(
  name: string,
  composeVariables: ExampleVariableInventory,
  example: ExampleEnvironment,
  policy: ExamplePolicy = {},
): string[] {
  const issues: string[] = [];
  const allowedExtras = policy.allowedExtras ?? {};
  const valuePins = policy.valuePins ?? {};
  issues.push(
    ...rationaleIssues(`${name} example-extra policy`, allowedExtras),
  );

  for (const key of composeVariables.keys()) {
    if (!example.keys.has(key)) {
      issues.push(`${name}: .env.example is missing Compose variable ${key}`);
    }
  }
  const observedExtras = new Set<string>();
  for (const key of example.keys) {
    if (composeVariables.has(key)) continue;
    observedExtras.add(key);
    if (!Object.hasOwn(allowedExtras, key)) {
      issues.push(`${name}: .env.example has undocumented extra key ${key}`);
    }
  }
  for (const key of Object.keys(allowedExtras)) {
    if (!observedExtras.has(key)) {
      issues.push(`${name}: example-extra allowlist for ${key} is stale`);
    }
  }

  for (const [key, pin] of Object.entries(valuePins)) {
    if (pin.rationale.trim().length === 0) {
      issues.push(`${name} value-pin policy: ${key} has an empty rationale`);
    }
    if (!composeVariables.has(key)) {
      issues.push(
        `${name}: value-pin policy names unknown Compose variable ${key}`,
      );
    } else if (!example.declared.has(key)) {
      issues.push(`${name}: .env.example must declare ${key}`);
    } else if (example.declared.get(key) !== pin.value) {
      issues.push(
        `${name}: .env.example must document ${key}=${pin.value}; got ${
          example.declared.get(key)
        }`,
      );
    } else {
      const defaults = new Set(
        composeVariables.get(key)!.map((usage) => usage.defaultValue).filter(
          (value): value is string => value !== null && value.length > 0,
        ),
      );
      if (defaults.size === 1 && defaults.has(pin.value)) {
        issues.push(
          `${name}: value-pin policy for ${key} is stale; it matches the Compose default`,
        );
      }
    }
  }

  for (const [key, usages] of composeVariables) {
    const requiredBy = usages.filter((usage) => usage.required).map((usage) =>
      usage.shape
    );
    if (requiredBy.length > 0 && !example.active.has(key)) {
      issues.push(
        `${name}: .env.example must actively assign Compose-required variable ${key} ` +
          `(required by ${requiredBy.join(", ")})`,
      );
    }
    if (Object.hasOwn(valuePins, key) || !example.declared.has(key)) continue;
    const defaults = new Set(
      usages.map((usage) => usage.defaultValue).filter(
        (value): value is string => value !== null && value.length > 0,
      ),
    );
    if (defaults.size > 1) {
      issues.push(
        `${name}: Compose shapes disagree on the default for ${key}; add a rationale-bearing value pin`,
      );
      continue;
    }
    const expected = [...defaults][0];
    const documented = example.declared.get(key);
    if (expected !== undefined && documented !== expected) {
      issues.push(
        `${name}: .env.example documents ${key}=${documented}, but Compose defaults to ${expected}; ` +
          "synchronize the example or add a rationale-bearing value pin",
      );
    }
  }
  return issues;
}

export function collectComposeInterpolationVariables(
  value: unknown,
  variables = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    const interpolation =
      /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
    for (const match of value.matchAll(interpolation)) {
      variables.add(match[1] ?? match[2]);
    }
    return variables;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectComposeInterpolationVariables(item, variables);
    }
    return variables;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectComposeInterpolationVariables(item, variables);
    }
  }
  return variables;
}

export function serviceEnvironmentValues(
  document: UnknownRecord,
  shapeName: string,
): Record<string, ComposeEnvironmentValue> | undefined {
  if (!isRecord(document.services)) {
    throw new Error(
      `${shapeName}: rendered Compose services must be a mapping`,
    );
  }
  const service = document.services.mcp;
  if (service === undefined) return undefined;
  if (!isRecord(service)) {
    throw new Error(`${shapeName}: rendered mcp service must be a mapping`);
  }
  const raw = service.environment;
  if (!isRecord(raw) && !Array.isArray(raw)) {
    throw new Error(
      `${shapeName}: rendered mcp environment must be a mapping or list`,
    );
  }
  const environment: Record<string, ComposeEnvironmentValue> = {};
  const add = (key: string, value: ComposeEnvironmentValue) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `${shapeName}: rendered mcp environment has invalid key ${key}`,
      );
    }
    if (Object.hasOwn(environment, key)) {
      throw new Error(
        `${shapeName}: rendered mcp environment repeats key ${key}`,
      );
    }
    environment[key] = value;
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") {
        throw new Error(
          `${shapeName}: rendered mcp environment list must contain strings`,
        );
      }
      const delimiter = item.indexOf("=");
      add(
        delimiter < 0 ? item : item.slice(0, delimiter),
        delimiter < 0 ? null : item.slice(delimiter + 1),
      );
    }
    return environment;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (
      value !== null && typeof value !== "string" &&
      typeof value !== "number" && typeof value !== "boolean"
    ) {
      throw new Error(
        `${shapeName}: rendered mcp environment value for ${key} must be scalar`,
      );
    }
    add(key, value);
  }
  return environment;
}

export function serviceEnvironment(
  document: UnknownRecord,
  shapeName: string,
): Record<string, string> | undefined {
  const values = serviceEnvironmentValues(document, shapeName);
  if (!values) return undefined;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      throw new Error(
        `${shapeName}: interpolated mcp environment value for ${key} must be a string`,
      );
    }
    environment[key] = value;
  }
  return environment;
}

export function auditServerPlacement(
  name: string,
  serverServices: readonly string[],
  absentRationale?: string,
): string[] {
  if (absentRationale !== undefined) {
    const issues = absentRationale.trim().length === 0
      ? [`${name}: absent-server rationale is empty`]
      : [];
    if (serverServices.length > 0) {
      issues.push(
        `${name}: server launcher must be absent; found service(s) ${
          serverServices.join(", ")
        }`,
      );
    }
    return issues;
  }
  return serverServices.length === 1 && serverServices[0] === "mcp" ? [] : [
    `${name}: expected exactly one server launcher named mcp; found ${
      serverServices.length > 0 ? serverServices.join(", ") : "none"
    }`,
  ];
}
