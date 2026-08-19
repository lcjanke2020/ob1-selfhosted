// Structural parity contract for the MCP server environment shipped by every
// canonical Compose deployment.
//
// The supported key set comes from the same AST walk used by check_allow_env,
// not from another hand-maintained inventory. Compose itself supplies both the
// merged service model and its interpolation-variable metadata. Its
// un-interpolated service environment preserves exact per-service default and
// empty-value semantics, including metadata gaps in older Compose releases.
// Unique sentinels then prove that a declared knob is actually forwarded. The
// only policy below is the finite set of deliberate aliases, literals,
// deployment omissions/pins, and forwarding-expression differences.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  analyzeTarget,
  parseDockerfile,
  parseRenderedComposeTargets,
  renderComposeConfig,
  type UnknownRecord,
} from "./check_allow_env.ts";

const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));
const REPO_DIR = resolve(SERVER_DIR, "..");
const DEPLOY_DIR = join(REPO_DIR, "deploy");

export interface ComposeSnapshot {
  environment: Readonly<Record<string, string>>;
  rawEnvironment: Readonly<Record<string, ComposeEnvironmentValue>>;
}

export type ComposeEnvironmentValue = string | number | boolean | null;

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

export interface ExampleEnvironment {
  active: ReadonlyMap<string, string>;
  keys: ReadonlySet<string>;
}

export interface ExamplePolicy {
  allowedExtras?: Readonly<Record<string, string>>;
  activeValues?: Readonly<
    Record<string, { rationale: string; value: string }>
  >;
}

interface ComposeShape {
  exampleGroup: "compose-local" | "qubes-app" | "qubes-ingress";
  files: readonly string[];
  name: string;
  profiles?: readonly string[];
  serverAbsent?: string;
  serverPolicy?: DeploymentPolicy;
}

interface RenderedShape {
  document: UnknownRecord;
  interpolationVariables: ReadonlySet<string>;
  rawEnvironment?: Readonly<Record<string, ComposeEnvironmentValue>>;
  serverServices: readonly string[];
}

type ForwardingRule =
  | { kind: "literal"; rationale: string; value: string }
  | { kind: "variable"; name: string; rationale?: string };

const SHARED_FORWARDING_RULES: Readonly<Record<string, ForwardingRule>> = {
  DB_NAME: {
    kind: "variable",
    name: "POSTGRES_DB",
    rationale:
      "Compose and the Postgres container share one database-name knob.",
  },
  DB_PASSWORD: {
    kind: "variable",
    name: "OPENBRAIN_APP_PASSWORD",
    rationale:
      "The server always receives the least-privilege app-role credential.",
  },
  DB_USER: {
    kind: "literal",
    value: "openbrain_app",
    rationale:
      "The shipped server must not be redirected to a broader database role.",
  },
  DB_POOL_SIZE: {
    kind: "literal",
    value: "10",
    rationale:
      "The deployment intentionally keeps the code default non-configurable.",
  },
  PORT: {
    kind: "literal",
    value: "8787",
    rationale:
      "Compose health checks and internal routing pin the server port.",
  },
};

const PATTERN_B_PINS: DeploymentPolicy["pins"] = {
  ENABLE_NATIVE_TOKENS: {
    value: "false",
    rationale: "The public Pattern B door is OAuth-only.",
  },
  MCP_ACCESS_KEY: {
    value: "",
    rationale:
      "Pattern B removes the static/native key door at the rendered boundary.",
  },
  MCP_ACCESS_KEY_PRINCIPAL: {
    value: "",
    rationale:
      "No native principal exists when the native key door is disabled.",
  },
};

const EXTERNAL_DB_DIFFERENCE: DeploymentPolicy["expressionDifferences"] = {
  DB_HOST: {
    baselineValue: "${DB_HOST:-postgres}",
    value:
      "${DB_HOST:?set DB_HOST to the external Postgres address (Qubes split — this qube own-IP ConnectTCP db forwarder) when layering the external-db override}",
    rationale:
      "The external-corpus overlay makes DB_HOST required instead of defaulting to the parked postgres service.",
  },
};

const LOCAL_EXPRESSION_PINS: DeploymentPolicy["expressionPins"] = {
  FETCH_TIMEOUT_MS: {
    value: "${FETCH_TIMEOUT_MS:-15000}",
    rationale:
      "The operator contract documents a 15-second embedding request deadline.",
  },
};

const SHAPES: readonly ComposeShape[] = [
  {
    name: "compose-local",
    exampleGroup: "compose-local",
    files: [join(DEPLOY_DIR, "compose-local", "docker-compose.yml")],
    serverPolicy: { expressionPins: LOCAL_EXPRESSION_PINS },
  },
  {
    name: "compose-tailnet-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "compose-tailnet", "docker-compose.pattern-b.yml"),
    ],
    profiles: ["pattern-b"],
    serverPolicy: { pins: PATTERN_B_PINS },
  },
  {
    name: "compose-external-db-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
    ],
    serverPolicy: { expressionDifferences: EXTERNAL_DB_DIFFERENCE },
  },
  {
    name: "compose-external-db-cpu-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.cpu-ollama.yml"),
    ],
    serverPolicy: { expressionDifferences: EXTERNAL_DB_DIFFERENCE },
  },
  {
    name: "compose-tailnet-external-corpus-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "compose-tailnet", "docker-compose.pattern-b.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
    ],
    profiles: ["pattern-b"],
    serverPolicy: {
      pins: PATTERN_B_PINS,
      expressionDifferences: EXTERNAL_DB_DIFFERENCE,
    },
  },
  {
    name: "compose-tailnet-external-corpus-cpu-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "compose-tailnet", "docker-compose.pattern-b.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.cpu-ollama.yml"),
    ],
    profiles: ["pattern-b"],
    serverPolicy: {
      pins: PATTERN_B_PINS,
      expressionDifferences: EXTERNAL_DB_DIFFERENCE,
    },
  },
  {
    name: "qubes-app",
    exampleGroup: "qubes-app",
    files: [join(DEPLOY_DIR, "qubes", "app-qube", "docker-compose.yml")],
    serverPolicy: {
      omissions: {
        ENABLE_REST_API:
          "The split app qube exposes MCP only; its ingress contract has no REST route.",
        MCP_ACCESS_KEY:
          "The split deployment is OAuth-only and carries no native/static credential.",
        MCP_ACCESS_KEY_PRINCIPAL:
          "The OAuth-only app qube has no native credential principal.",
      },
      pins: {
        ENABLE_NATIVE_TOKENS: {
          value: "false",
          rationale: "The split app qube is OAuth-only.",
        },
      },
      expressionDifferences: {
        DB_HOST: {
          baselineValue: "${DB_HOST:-postgres}",
          value:
            "${DB_HOST:?set DB_HOST to this qube's own IP — the ob1-db-forward ConnectTCP forwarder (the three-qube split has no local postgres)}",
          rationale:
            "The split app qube requires its explicit ConnectTCP database forwarder.",
        },
        DB_PASSWORD: {
          baselineValue: "${OPENBRAIN_APP_PASSWORD}",
          value:
            "${OPENBRAIN_APP_PASSWORD:?set OPENBRAIN_APP_PASSWORD (the app role mcp connects as)}",
          rationale:
            "The split app qube requires the app-role credential at Compose render time.",
        },
        AUTH0_ISSUER: {
          baselineValue: "${AUTH0_ISSUER:-}",
          value:
            "${AUTH0_ISSUER:?set AUTH0_ISSUER (Qubes deployment is OAuth-only)}",
          rationale:
            "OAuth is the split deployment's only authentication door.",
        },
        AUTH0_JWKS_URI: {
          baselineValue: "${AUTH0_JWKS_URI:-}",
          value:
            "${AUTH0_JWKS_URI:?set AUTH0_JWKS_URI (Qubes deployment is OAuth-only)}",
          rationale:
            "OAuth is the split deployment's only authentication door.",
        },
        AUTH0_AUDIENCE: {
          baselineValue: "${AUTH0_AUDIENCE:-}",
          value:
            "${AUTH0_AUDIENCE:?set AUTH0_AUDIENCE (Qubes deployment is OAuth-only)}",
          rationale:
            "OAuth is the split deployment's only authentication door.",
        },
      },
    },
  },
  {
    name: "qubes-ingress",
    exampleGroup: "qubes-ingress",
    files: [
      join(DEPLOY_DIR, "qubes", "ingress-qube", "docker-compose.yml"),
    ],
    serverAbsent:
      "The ingress qube may run only the public edge and its local log sink; MCP belongs to the app qube.",
  },
];

const EXAMPLE_CONTRACTS = {
  "compose-local": {
    path: join(DEPLOY_DIR, "compose-local", ".env.example"),
    policy: {
      allowedExtras: {
        COMPOSE_FILE:
          "Compose consumes this CLI control variable before model interpolation.",
        COMPOSE_PATH_SEPARATOR:
          "Compose consumes this CLI control variable before model interpolation.",
        COMPOSE_PROFILES:
          "Compose consumes this CLI control variable before model interpolation.",
        COMPOSE_PROJECT_NAME:
          "Compose consumes this CLI control variable before model interpolation.",
      },
      activeValues: {
        METADATA_FALLBACK_POLICY: {
          value: "off",
          rationale:
            "The single-host quickstart ships the strictest safe policy so copying the example boots without permitting off-box fallback.",
        },
      },
    },
  },
  "qubes-app": {
    path: join(DEPLOY_DIR, "qubes", "app-qube", ".env.example"),
    policy: {
      allowedExtras: {
        COMPOSE_PROJECT_NAME:
          "Compose consumes this CLI control variable before model interpolation.",
        OPENBRAIN_READONLY_PASSWORD:
          "The app qube's host-side encrypted backup job uses this corpus role.",
        POSTGRES_PASSWORD:
          "The app qube retains the corpus migration credential outside the MCP service environment.",
      },
      activeValues: {
        METADATA_FALLBACK_POLICY: {
          value: "",
          rationale:
            "The security-separated Qubes deployment requires its operator to choose the off/alert/allow privacy posture explicitly.",
        },
      },
    },
  },
  "qubes-ingress": {
    path: join(DEPLOY_DIR, "qubes", "ingress-qube", ".env.example"),
    policy: {
      allowedExtras: {
        COMPOSE_PROJECT_NAME:
          "Compose consumes this CLI control variable before model interpolation.",
      },
    },
  },
} as const;

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

function forwardingRule(
  key: string,
  policy: DeploymentPolicy,
): ForwardingRule {
  const pin = policy.pins?.[key];
  if (pin) {
    return { kind: "literal", value: pin.value, rationale: pin.rationale };
  }
  return SHARED_FORWARDING_RULES[key] ?? {
    kind: "variable",
    name: key,
  };
}

export function auditServerEnvironment(
  name: string,
  supportedKeys: ReadonlySet<string>,
  snapshot: ComposeSnapshot,
  baseline: ComposeSnapshot | undefined,
  policy: DeploymentPolicy = {},
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
    const rule = forwardingRule(key, policy);
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
    const rule = forwardingRule(key, policy);
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
    if (allowed && !Object.is(baselineExpression, allowed.baselineValue)) {
      issues.push(
        `${name}: ${key} requires compose-local forwarding expression ${
          JSON.stringify(allowed.baselineValue)
        }; got ${JSON.stringify(baselineExpression)}`,
      );
    }
    if (differs && !allowed) {
      issues.push(
        `${name}: ${key} changes its mcp forwarding expression from ${
          JSON.stringify(baselineExpression)
        } to ${JSON.stringify(expression)} without an allowlist rationale`,
      );
    } else if (differs && !Object.is(expression, allowed.value)) {
      issues.push(
        `${name}: ${key} must use reviewed forwarding expression ${
          JSON.stringify(allowed.value)
        }; got ${JSON.stringify(expression)}`,
      );
    } else if (!differs && allowed) {
      issues.push(
        `${name}: expression-difference allowlist for ${key} is stale; it matches compose-local`,
      );
    }
  }

  for (const key of Object.keys(expressionDifferences)) {
    if (!supportedKeys.has(key)) continue;
    const rule = forwardingRule(key, policy);
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
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(
      /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/,
    );
    if (!match) {
      const candidate = line.trim();
      // Keep this inventory parser deliberately narrow, but never let valid or
      // invalid active dotenv syntax disappear from the parity contract.
      if (candidate.length > 0 && !candidate.startsWith("#")) {
        throw new Error(
          `.env.example:${index + 1}: unsupported dotenv syntax; use KEY=value`,
        );
      }
      continue;
    }
    const [, comment, key, rawValue] = match;
    keys.add(key);
    if (comment) continue;
    if (active.has(key)) {
      throw new Error(
        `.env.example:${index + 1}: duplicate active assignment for ${key}`,
      );
    }
    active.set(key, rawValue.trim());
  }
  return { keys, active };
}

export function auditExampleEnvironment(
  name: string,
  composeVariables: ReadonlySet<string>,
  example: ExampleEnvironment,
  policy: ExamplePolicy = {},
): string[] {
  const issues: string[] = [];
  const allowedExtras = policy.allowedExtras ?? {};
  issues.push(
    ...rationaleIssues(`${name} example-extra policy`, allowedExtras),
  );

  for (const key of composeVariables) {
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

  for (const [key, expected] of Object.entries(policy.activeValues ?? {})) {
    if (expected.rationale.trim().length === 0) {
      issues.push(`${name} active-value policy: ${key} has an empty rationale`);
    }
    if (!example.active.has(key)) {
      issues.push(`${name}: .env.example must actively assign ${key}`);
    } else if (example.active.get(key) !== expected.value) {
      issues.push(
        `${name}: .env.example must assign ${key}=${expected.value}; got ${
          example.active.get(key)
        }`,
      );
    }
  }
  return issues;
}

function parseComposeVariableNames(document: UnknownRecord): Set<string> {
  const variables = new Set<string>();
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
    variables.add(key);
  }
  return variables;
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

function serviceEnvironmentValues(
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

function serviceEnvironment(
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

function serverServiceNames(
  document: UnknownRecord,
  shape: ComposeShape,
  serverEntrypoint: string,
): string[] {
  const source = shape.name;
  const prefix = `${source}#`;
  return parseRenderedComposeTargets(
    document,
    source,
    dirname(resolve(shape.files[0])),
  ).filter((target) => analyzeTarget(target).files.has(serverEntrypoint)).map(
    (target) => {
      if (!target.source.startsWith(prefix)) {
        throw new Error(
          `${shape.name}: cannot identify service for ${target.source}`,
        );
      }
      return target.source.slice(prefix.length);
    },
  ).sort();
}

function renderShape(
  shape: ComposeShape,
  serverEntrypoint: string,
): RenderedShape {
  const composeControlEnvironment = { COMPOSE_PROFILES: "" };
  const uninterpolatedDocument = renderComposeConfig(shape.files, {
    environment: composeControlEnvironment,
    profiles: shape.profiles,
  });
  const interpolationVariables = collectComposeInterpolationVariables(
    uninterpolatedDocument,
  );
  const rawEnvironment = serviceEnvironmentValues(
    uninterpolatedDocument,
    shape.name,
  );
  const inventoryEnvironment: Record<string, string> = {
    ...composeControlEnvironment,
  };
  for (const key of interpolationVariables) {
    inventoryEnvironment[key] = composeFixtureValue(key);
  }

  // Compose 2.38.x validates required bind-source interpolation before
  // producing --variables output, then omits that variable from the output.
  // Seed every variable from the real un-interpolated model so inventory is
  // version-stable without weakening required-variable behavior.
  const variableDocument = renderComposeConfig(shape.files, {
    environment: inventoryEnvironment,
    profiles: shape.profiles,
    variables: true,
  });
  const variables = parseComposeVariableNames(variableDocument);
  const environment: Record<string, string> = {
    ...composeControlEnvironment,
  };
  for (const key of variables) interpolationVariables.add(key);
  for (const key of interpolationVariables) {
    environment[key] = composeFixtureValue(key);
  }
  return {
    interpolationVariables,
    rawEnvironment,
    serverServices: serverServiceNames(
      uninterpolatedDocument,
      shape,
      serverEntrypoint,
    ),
    document: renderComposeConfig(shape.files, {
      environment,
      interpolate: true,
      profiles: shape.profiles,
    }),
  };
}

function serverContract(): { entrypoint: string; supported: Set<string> } {
  const dockerfile = join(SERVER_DIR, "Dockerfile");
  const target = {
    source: "server/Dockerfile",
    ...parseDockerfile(dockerfile),
  };
  return {
    entrypoint: target.entrypoint,
    supported: analyzeTarget(target).reads,
  };
}

function main(): number {
  try {
    const server = serverContract();
    const supported = server.supported;
    const rendered = new Map<string, RenderedShape>();
    for (const shape of SHAPES) {
      rendered.set(shape.name, renderShape(shape, server.entrypoint));
    }

    const baselineRendered = rendered.get("compose-local")!;
    const baselineEnvironment = serviceEnvironment(
      baselineRendered.document,
      "compose-local",
    );
    if (!baselineEnvironment) {
      throw new Error(
        "compose-local: rendered Compose omitted required mcp service",
      );
    }
    if (!baselineRendered.rawEnvironment) {
      throw new Error(
        "compose-local: un-interpolated Compose omitted required mcp service",
      );
    }
    const baseline: ComposeSnapshot = {
      environment: baselineEnvironment,
      rawEnvironment: baselineRendered.rawEnvironment,
    };

    const issues: string[] = [];
    for (const shape of SHAPES) {
      const snapshot = rendered.get(shape.name)!;
      const environment = serviceEnvironment(snapshot.document, shape.name);
      const placementIssues = auditServerPlacement(
        shape.name,
        snapshot.serverServices,
        shape.serverAbsent,
      );
      issues.push(...placementIssues);
      if (shape.serverAbsent) {
        if (placementIssues.length === 0) {
          console.log(
            `✓ ${shape.name}: no server launcher (${shape.serverAbsent})`,
          );
        }
        continue;
      }
      if (placementIssues.length > 0) continue;
      if (!environment || !snapshot.rawEnvironment || !shape.serverPolicy) {
        issues.push(
          `${shape.name}: rendered Compose omitted required mcp service`,
        );
        continue;
      }
      const deploymentIssues = auditServerEnvironment(
        shape.name,
        supported,
        { environment, rawEnvironment: snapshot.rawEnvironment },
        shape.name === "compose-local" ? undefined : baseline,
        shape.serverPolicy,
      );
      issues.push(...deploymentIssues);
      if (deploymentIssues.length === 0) {
        const omissionCount = Object.keys(
          shape.serverPolicy.omissions ?? {},
        ).length;
        console.log(
          `✓ ${shape.name}: ${
            environment ? Object.keys(environment).length : 0
          } server keys` +
            (omissionCount > 0
              ? ` + ${omissionCount} documented omissions`
              : ""),
        );
      }
    }

    for (const [groupName, contract] of Object.entries(EXAMPLE_CONTRACTS)) {
      const variables = new Set<string>();
      for (const shape of SHAPES) {
        if (shape.exampleGroup !== groupName) continue;
        for (
          const key of rendered.get(shape.name)!.interpolationVariables
        ) variables.add(key);
      }
      const example = parseExampleEnvironment(
        Deno.readTextFileSync(contract.path),
      );
      const exampleIssues = auditExampleEnvironment(
        groupName,
        variables,
        example,
        contract.policy,
      );
      issues.push(...exampleIssues);
      if (exampleIssues.length === 0) {
        console.log(
          `✓ ${groupName}/.env.example: documents ${variables.size} Compose variables`,
        );
      }
    }

    if (issues.length === 0) {
      console.log(
        `✓ Compose environment parity holds for ${supported.size} supported MCP keys`,
      );
      return 0;
    }
    for (const issue of issues) console.error(`✗ ${issue}`);
    console.error(
      "\nUpdate every affected Compose shape/example, or add a narrow rationale-bearing exception to the reviewed policy.",
    );
    return 1;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(main());
