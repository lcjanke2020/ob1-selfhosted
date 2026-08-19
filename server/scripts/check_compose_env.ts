// Structural parity contract for the MCP server environment shipped by every
// canonical Compose deployment.
//
// The supported key set comes from the same AST walk used by check_allow_env,
// not from another hand-maintained inventory. Compose itself supplies both the
// merged service model and its interpolation-variable metadata. Unique
// sentinels then prove that a declared knob is actually forwarded. The only
// policy below is the finite set of deliberate aliases, literals, deployment
// omissions/pins, and required-vs-defaulted differences.

import { fromFileUrl, join, resolve } from "@std/path";
import {
  analyzeTarget,
  parseDockerfile,
  renderComposeConfig,
  type UnknownRecord,
} from "./check_allow_env.ts";

const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));
const REPO_DIR = resolve(SERVER_DIR, "..");
const DEPLOY_DIR = join(REPO_DIR, "deploy");

export interface ComposeVariableContract {
  defaultValue: string;
  required: boolean;
}

export interface ComposeSnapshot {
  environment: Readonly<Record<string, string>>;
  variables: Readonly<Record<string, ComposeVariableContract>>;
}

export interface DeploymentPolicy {
  omissions?: Readonly<Record<string, string>>;
  pins?: Readonly<Record<string, { rationale: string; value: string }>>;
  variableDifferences?: Readonly<Record<string, string>>;
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
  variables: Record<string, ComposeVariableContract>;
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

const EXTERNAL_DB_DIFFERENCE: DeploymentPolicy["variableDifferences"] = {
  DB_HOST:
    "The external-corpus overlay makes DB_HOST required instead of defaulting to the parked postgres service.",
};

const SHAPES: readonly ComposeShape[] = [
  {
    name: "compose-local",
    exampleGroup: "compose-local",
    files: [join(DEPLOY_DIR, "compose-local", "docker-compose.yml")],
    serverPolicy: {},
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
    serverPolicy: { variableDifferences: EXTERNAL_DB_DIFFERENCE },
  },
  {
    name: "compose-external-db-cpu-overlay",
    exampleGroup: "compose-local",
    files: [
      join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
      join(DEPLOY_DIR, "qubes", "docker-compose.cpu-ollama.yml"),
    ],
    serverPolicy: { variableDifferences: EXTERNAL_DB_DIFFERENCE },
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
      variableDifferences: EXTERNAL_DB_DIFFERENCE,
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
      variableDifferences: EXTERNAL_DB_DIFFERENCE,
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
      variableDifferences: {
        DB_HOST:
          "The split app qube requires its explicit ConnectTCP database forwarder.",
        DB_PASSWORD:
          "The split app qube requires the app-role credential at Compose render time.",
        AUTH0_ISSUER:
          "OAuth is the split deployment's only authentication door.",
        AUTH0_JWKS_URI:
          "OAuth is the split deployment's only authentication door.",
        AUTH0_AUDIENCE:
          "OAuth is the split deployment's only authentication door.",
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

function sameVariableContract(
  left: ComposeVariableContract,
  right: ComposeVariableContract,
): boolean {
  return left.required === right.required &&
    left.defaultValue === right.defaultValue;
}

export function auditServerEnvironment(
  name: string,
  supportedKeys: ReadonlySet<string>,
  snapshot: ComposeSnapshot,
  baseline: ComposeSnapshot | undefined,
  policy: DeploymentPolicy = {},
): string[] {
  const issues: string[] = [];
  const omissions = policy.omissions ?? {};
  const pins = policy.pins ?? {};
  const variableDifferences = policy.variableDifferences ?? {};

  issues.push(...rationaleIssues(`${name} omission policy`, omissions));
  issues.push(...rationaleIssues(
    `${name} variable-difference policy`,
    variableDifferences,
  ));
  for (const [key, pin] of Object.entries(pins)) {
    if (pin.rationale.trim().length === 0) {
      issues.push(`${name} pin policy: ${key} has an empty rationale`);
    }
  }

  const actualKeys = new Set(Object.keys(snapshot.environment));
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
  for (const key of Object.keys(omissions)) {
    if (!supportedKeys.has(key)) {
      issues.push(
        `${name}: omission allowlist names unknown server key ${key}`,
      );
    }
  }

  const observedVariableDifferences = new Set<string>();
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
      continue;
    }

    const variable = snapshot.variables[rule.name];
    if (!variable) {
      issues.push(
        `${name}: ${key} claims forwarding from ${rule.name}, but Compose does not report that variable`,
      );
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
    const baselineRule = forwardingRule(key, {});
    if (baselineRule.kind !== "variable") continue;
    const baselineVariable = baseline.variables[baselineRule.name];
    if (!baselineVariable) {
      issues.push(
        `${name}: compose-local baseline does not report ${baselineRule.name} for ${key}`,
      );
      continue;
    }
    const differs = !sameVariableContract(variable, baselineVariable);
    const allowed = Object.hasOwn(variableDifferences, key);
    if (differs) observedVariableDifferences.add(key);
    if (differs && !allowed) {
      issues.push(
        `${name}: ${key} changes Compose variable semantics for ${rule.name} ` +
          `(local required=${baselineVariable.required}, default=${
            JSON.stringify(baselineVariable.defaultValue)
          }; ` +
          `here required=${variable.required}, default=${
            JSON.stringify(variable.defaultValue)
          }) without an allowlist rationale`,
      );
    } else if (!differs && allowed) {
      issues.push(
        `${name}: variable-difference allowlist for ${key} is stale; it matches compose-local`,
      );
    }
  }

  for (const key of Object.keys(variableDifferences)) {
    if (!supportedKeys.has(key)) {
      issues.push(
        `${name}: variable-difference allowlist names unknown server key ${key}`,
      );
    } else if (!observedVariableDifferences.has(key) && !actualKeys.has(key)) {
      issues.push(
        `${name}: variable-difference allowlist for ${key} cannot be observed because the key is absent`,
      );
    }
  }
  for (const key of Object.keys(pins)) {
    if (!supportedKeys.has(key)) {
      issues.push(`${name}: pin allowlist names unknown server key ${key}`);
    }
  }
  return issues;
}

export function parseExampleEnvironment(content: string): ExampleEnvironment {
  const keys = new Set<string>();
  const active = new Map<string, string>();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
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

function parseComposeVariables(document: UnknownRecord): Record<
  string,
  ComposeVariableContract
> {
  const variables: Record<string, ComposeVariableContract> = {};
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
    variables[key] = {
      required: raw.Required,
      defaultValue: raw.DefaultValue,
    };
  }
  return variables;
}

function serviceEnvironment(
  document: UnknownRecord,
  shapeName: string,
): Record<string, string> | undefined {
  if (!isRecord(document.services)) {
    throw new Error(
      `${shapeName}: rendered Compose services must be a mapping`,
    );
  }
  const service = document.services.mcp;
  if (service === undefined) return undefined;
  if (!isRecord(service) || !isRecord(service.environment)) {
    throw new Error(`${shapeName}: rendered mcp environment must be a mapping`);
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(service.environment)) {
    if (typeof value !== "string") {
      throw new Error(
        `${shapeName}: rendered mcp environment value for ${key} must be a string`,
      );
    }
    environment[key] = value;
  }
  return environment;
}

function renderShape(shape: ComposeShape): RenderedShape {
  const composeControlEnvironment = { COMPOSE_PROFILES: "" };
  const variableDocument = renderComposeConfig(shape.files, {
    environment: composeControlEnvironment,
    variables: true,
  });
  const variables = parseComposeVariables(variableDocument);
  const environment: Record<string, string> = {
    ...composeControlEnvironment,
  };
  for (const key of Object.keys(variables)) {
    environment[key] = composeFixtureValue(key);
  }
  return {
    variables,
    document: renderComposeConfig(shape.files, {
      environment,
      interpolate: true,
      profiles: shape.profiles,
    }),
  };
}

function supportedServerKeys(): Set<string> {
  const dockerfile = join(SERVER_DIR, "Dockerfile");
  const target = {
    source: "server/Dockerfile",
    ...parseDockerfile(dockerfile),
  };
  return analyzeTarget(target).reads;
}

function main(): number {
  try {
    const supported = supportedServerKeys();
    const rendered = new Map<string, RenderedShape>();
    for (const shape of SHAPES) rendered.set(shape.name, renderShape(shape));

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
    const baseline: ComposeSnapshot = {
      environment: baselineEnvironment,
      variables: baselineRendered.variables,
    };

    const issues: string[] = [];
    for (const shape of SHAPES) {
      const snapshot = rendered.get(shape.name)!;
      const environment = serviceEnvironment(snapshot.document, shape.name);
      if (shape.serverAbsent) {
        if (shape.serverAbsent.trim().length === 0) {
          issues.push(`${shape.name}: absent-server rationale is empty`);
        }
        if (environment) {
          issues.push(
            `${shape.name}: mcp service is present despite the reviewed per-qube boundary`,
          );
        } else {
          console.log(
            `✓ ${shape.name}: no mcp service (${shape.serverAbsent})`,
          );
        }
        continue;
      }
      if (!environment || !shape.serverPolicy) {
        issues.push(
          `${shape.name}: rendered Compose omitted required mcp service`,
        );
        continue;
      }
      const deploymentIssues = auditServerEnvironment(
        shape.name,
        supported,
        { environment, variables: snapshot.variables },
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
        for (const key of Object.keys(rendered.get(shape.name)!.variables)) {
          variables.add(key);
        }
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
