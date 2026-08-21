// Canonical metadata and reviewed policy for every documented Compose
// deployment. The allow-env consumer deliberately expands every classified
// overlay to its full power set; DOCUMENTED_DEPLOYMENTS is the smaller set
// users are actually told to run.

import { fromFileUrl, join, resolve } from "@std/path";
import type {
  DeploymentPolicy,
  ExamplePolicy,
  ForwardingRules,
} from "./compose_env_audit.ts";

export const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));
export const REPO_DIR = resolve(SERVER_DIR, "..");
export const DEPLOY_DIR = join(REPO_DIR, "deploy");

export type ComposeFileKind = "base" | "overlay" | "standalone";

export interface ComposeFileDefinition {
  kind: ComposeFileKind;
  path: string;
}

export const COMPOSE_FILES = {
  local: {
    kind: "base",
    path: join(DEPLOY_DIR, "compose-local", "docker-compose.yml"),
  },
  patternB: {
    kind: "overlay",
    path: join(
      DEPLOY_DIR,
      "compose-tailnet",
      "docker-compose.pattern-b.yml",
    ),
  },
  externalDb: {
    kind: "overlay",
    path: join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
  },
  cpuOllama: {
    kind: "overlay",
    path: join(DEPLOY_DIR, "qubes", "docker-compose.cpu-ollama.yml"),
  },
  qubesApp: {
    kind: "standalone",
    path: join(DEPLOY_DIR, "qubes", "app-qube", "docker-compose.yml"),
  },
  qubesIngress: {
    kind: "standalone",
    path: join(DEPLOY_DIR, "qubes", "ingress-qube", "docker-compose.yml"),
  },
} as const satisfies Readonly<Record<string, ComposeFileDefinition>>;

export type ComposeFileId = keyof typeof COMPOSE_FILES;

export type ExampleGroupName =
  | "compose-local"
  | "qubes-app"
  | "qubes-ingress";

export type DeploymentCapability =
  | "cpu-ollama"
  | "external-corpus"
  | "log-sink"
  | "mcp-server"
  | "pattern-b-edge"
  | "token-admin";

export interface ServiceCapabilityContract {
  service: string;
}

// These capability labels describe services declared by the rendered,
// un-interpolated Compose model. That distinction is load-bearing for
// token-admin: the service remains auditable while its `tools` profile stays
// inactive in every documented long-running deployment.
export const SERVICE_CAPABILITY_CONTRACTS = {
  "log-sink": { service: "log-sink" },
  "token-admin": { service: "token-admin" },
} as const satisfies Readonly<
  Partial<Record<DeploymentCapability, ServiceCapabilityContract>>
>;

interface DeploymentBase {
  capabilities: readonly DeploymentCapability[];
  exampleGroup: ExampleGroupName;
  files: readonly ComposeFileId[];
  name: string;
  profiles?: readonly string[];
}

export interface ServerPresentDeployment extends DeploymentBase {
  server: { kind: "present"; policy?: DeploymentPolicy };
}

export interface ServerAbsentDeployment extends DeploymentBase {
  server: { kind: "absent"; rationale: string };
}

export type DeploymentShape =
  | ServerPresentDeployment
  | ServerAbsentDeployment;

export interface ExampleContract {
  path: string;
  policy?: ExamplePolicy;
}

export const SHARED_FORWARDING_RULES: ForwardingRules = {
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

const PATTERN_B_EXPRESSION_DIFFERENCES:
  DeploymentPolicy["expressionDifferences"] = {
    AUTH0_ISSUER: {
      baselineValue: "${AUTH0_ISSUER:-}",
      value: "${AUTH0_ISSUER:?set AUTH0_ISSUER (Pattern B is OAuth-only)}",
      rationale:
        "Pattern B has no non-OAuth credential door, so the issuer must be present before startup.",
    },
    AUTH0_JWKS_URI: {
      baselineValue: "${AUTH0_JWKS_URI:-}",
      value: "${AUTH0_JWKS_URI:?set AUTH0_JWKS_URI (Pattern B is OAuth-only)}",
      rationale:
        "Pattern B has no non-OAuth credential door, so the JWKS endpoint must be present before startup.",
    },
    AUTH0_AUDIENCE: {
      baselineValue: "${AUTH0_AUDIENCE:-}",
      value: "${AUTH0_AUDIENCE:?set AUTH0_AUDIENCE (Pattern B is OAuth-only)}",
      rationale:
        "Pattern B has no non-OAuth credential door, so the audience must be present before startup.",
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

export const DOCUMENTED_DEPLOYMENTS: readonly DeploymentShape[] = [
  {
    name: "compose-local",
    exampleGroup: "compose-local",
    files: ["local"],
    capabilities: ["mcp-server", "token-admin"],
    server: {
      kind: "present",
      policy: { expressionPins: LOCAL_EXPRESSION_PINS },
    },
  },
  {
    name: "compose-tailnet-overlay",
    exampleGroup: "compose-local",
    files: ["local", "patternB"],
    profiles: ["pattern-b"],
    capabilities: [
      "mcp-server",
      "token-admin",
      "pattern-b-edge",
      "log-sink",
    ],
    server: {
      kind: "present",
      policy: {
        pins: PATTERN_B_PINS,
        expressionDifferences: PATTERN_B_EXPRESSION_DIFFERENCES,
      },
    },
  },
  {
    name: "compose-external-db-overlay",
    exampleGroup: "compose-local",
    files: ["local", "externalDb"],
    capabilities: ["mcp-server", "token-admin", "external-corpus"],
    server: {
      kind: "present",
      policy: { expressionDifferences: EXTERNAL_DB_DIFFERENCE },
    },
  },
  {
    name: "compose-external-db-cpu-overlay",
    exampleGroup: "compose-local",
    files: ["local", "externalDb", "cpuOllama"],
    capabilities: [
      "mcp-server",
      "token-admin",
      "external-corpus",
      "cpu-ollama",
    ],
    server: {
      kind: "present",
      policy: { expressionDifferences: EXTERNAL_DB_DIFFERENCE },
    },
  },
  {
    name: "compose-tailnet-external-corpus-overlay",
    exampleGroup: "compose-local",
    files: ["local", "patternB", "externalDb"],
    profiles: ["pattern-b"],
    capabilities: [
      "mcp-server",
      "token-admin",
      "pattern-b-edge",
      "log-sink",
      "external-corpus",
    ],
    server: {
      kind: "present",
      policy: {
        pins: PATTERN_B_PINS,
        expressionDifferences: {
          ...PATTERN_B_EXPRESSION_DIFFERENCES,
          ...EXTERNAL_DB_DIFFERENCE,
        },
      },
    },
  },
  {
    name: "compose-tailnet-external-corpus-cpu-overlay",
    exampleGroup: "compose-local",
    files: ["local", "patternB", "externalDb", "cpuOllama"],
    profiles: ["pattern-b"],
    capabilities: [
      "mcp-server",
      "token-admin",
      "pattern-b-edge",
      "log-sink",
      "external-corpus",
      "cpu-ollama",
    ],
    server: {
      kind: "present",
      policy: {
        pins: PATTERN_B_PINS,
        expressionDifferences: {
          ...PATTERN_B_EXPRESSION_DIFFERENCES,
          ...EXTERNAL_DB_DIFFERENCE,
        },
      },
    },
  },
  {
    name: "qubes-app",
    exampleGroup: "qubes-app",
    files: ["qubesApp"],
    capabilities: ["mcp-server", "external-corpus", "cpu-ollama"],
    server: {
      kind: "present",
      policy: {
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
  },
  {
    name: "qubes-ingress",
    exampleGroup: "qubes-ingress",
    files: ["qubesIngress"],
    capabilities: ["pattern-b-edge", "log-sink"],
    server: {
      kind: "absent",
      rationale:
        "The ingress qube may run only the public edge and its local log sink; MCP belongs to the app qube.",
    },
  },
] as const;

export const EXAMPLE_CONTRACTS: Readonly<
  Record<ExampleGroupName, ExampleContract>
> = {
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
      valuePins: {
        DB_HOST: {
          value: "",
          rationale:
            "The shared example leaves the external-corpus address for an operator to choose; the local base uses its Compose default.",
        },
        ENABLE_REST_API: {
          value: "false",
          rationale:
            "The commented assignment demonstrates the explicit opt-out rather than restating the enabled default.",
        },
        ENABLE_PRIMARY_EXTRACTION: {
          value: "true",
          rationale:
            "The example demonstrates the explicit opt-in while Compose's empty default keeps primary extraction disabled.",
        },
        CITATION_BASE_URL: {
          value: "",
          rationale:
            "A blank optional citation URL deliberately exercises the server's non-resolving fallback.",
        },
        MCP_UPSTREAM: {
          value: "",
          rationale:
            "The shared example leaves the split-deployment forwarder unset while the single-host stack uses its service-name default.",
        },
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
      valuePins: {
        ENABLE_PRIMARY_EXTRACTION: {
          value: "true",
          rationale:
            "The example demonstrates the explicit opt-in while Compose's empty default keeps primary extraction disabled.",
        },
        CITATION_BASE_URL: {
          value: "",
          rationale:
            "The operator must replace the informational URL when consumers need a resolvable citation target.",
        },
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
};

export interface ComposeStack<FileId extends string = ComposeFileId> {
  files: readonly FileId[];
  name: string;
}

export function composeFilePaths(
  fileIds: readonly ComposeFileId[],
): string[] {
  return fileIds.map((id) => COMPOSE_FILES[id].path);
}

function composeFileIdsByKind<FileId extends string>(
  files: Readonly<Record<FileId, ComposeFileDefinition>>,
  kind: ComposeFileKind,
): FileId[] {
  // Object declaration order is the canonical base/overlay/standalone order.
  return (Object.entries(files) as [FileId, ComposeFileDefinition][])
    .filter(([, file]) => file.kind === kind)
    .map(([id]) => id);
}

export function deriveAllowEnvComposeStacks<FileId extends string>(
  files: Readonly<Record<FileId, ComposeFileDefinition>>,
): readonly ComposeStack<FileId>[] {
  const baseFileIds = composeFileIdsByKind(files, "base");
  if (baseFileIds.length !== 1) {
    throw new Error(
      `Compose launcher partition requires exactly one base file; found ${baseFileIds.length}`,
    );
  }
  const [baseFileId] = baseFileIds;
  const overlayFileIds = composeFileIdsByKind(files, "overlay");
  const standaloneFileIds = composeFileIdsByKind(files, "standalone");

  const stacks: ComposeStack<FileId>[] = [];
  for (let mask = 0; mask < 1 << overlayFileIds.length; mask++) {
    const stackFiles: FileId[] = [baseFileId];
    for (const [index, id] of overlayFileIds.entries()) {
      if ((mask & (1 << index)) !== 0) stackFiles.push(id);
    }
    stacks.push({
      name: `allow-env:${stackFiles.join("+")}`,
      files: stackFiles,
    });
  }
  for (const id of standaloneFileIds) {
    stacks.push({ name: `allow-env:${id}`, files: [id] });
  }
  return stacks;
}

export function allowEnvComposeStacks(): readonly ComposeStack[] {
  return deriveAllowEnvComposeStacks(COMPOSE_FILES);
}

export interface ManifestAuditInput {
  deployments: readonly DeploymentShape[];
  examples: Readonly<Record<string, ExampleContract>>;
  files: Readonly<Record<string, ComposeFileDefinition>>;
}

export function auditDeploymentManifest(
  manifest: ManifestAuditInput = {
    deployments: DOCUMENTED_DEPLOYMENTS,
    examples: EXAMPLE_CONTRACTS,
    files: COMPOSE_FILES,
  },
): string[] {
  const issues: string[] = [];
  const paths = new Set<string>();
  const fileKinds = new Map<string, ComposeFileKind>();
  for (const [id, file] of Object.entries(manifest.files)) {
    if (paths.has(file.path)) {
      issues.push(`Compose file ${id} repeats path ${file.path}`);
    }
    paths.add(file.path);
    if (!(["base", "overlay", "standalone"] as const).includes(file.kind)) {
      issues.push(`Compose file ${id} has unknown kind ${file.kind}`);
      continue;
    }
    fileKinds.set(id, file.kind);
  }
  const baseFileIds = [...fileKinds].filter(([, kind]) => kind === "base")
    .map(([id]) => id);
  if (baseFileIds.length !== 1) {
    issues.push(
      `Compose manifest must classify exactly one base file; found ${baseFileIds.length}`,
    );
  }

  const names = new Set<string>();
  const referencedFiles = new Set<string>();
  for (const shape of manifest.deployments) {
    if (names.has(shape.name)) {
      issues.push(`deployment manifest repeats shape name ${shape.name}`);
    }
    names.add(shape.name);
    if (shape.files.length === 0) {
      issues.push(`${shape.name}: Compose stack is empty`);
    }
    const stackFiles = new Set<string>();
    for (const id of shape.files) {
      if (!Object.hasOwn(manifest.files, id)) {
        issues.push(`${shape.name}: references unknown Compose file ${id}`);
      } else if (stackFiles.has(id)) {
        issues.push(`${shape.name}: repeats Compose file ${id}`);
      } else {
        stackFiles.add(id);
        referencedFiles.add(id);
      }
    }
    const stackKinds = shape.files.flatMap((id) => {
      const kind = fileKinds.get(id);
      return kind ? [kind] : [];
    });
    const standaloneCount = stackKinds.filter((kind) =>
      kind === "standalone"
    ).length;
    const overlayCount = stackKinds.filter((kind) => kind === "overlay")
      .length;
    const baseCount = stackKinds.filter((kind) => kind === "base").length;
    if (standaloneCount > 0) {
      if (stackKinds.length !== 1 || standaloneCount !== 1) {
        issues.push(
          `${shape.name}: a standalone Compose file must be the only file in its stack`,
        );
      }
    } else if (baseCount > 0 || overlayCount > 0) {
      if (baseCount !== 1) {
        issues.push(
          `${shape.name}: layered Compose stack requires exactly one base file`,
        );
      } else if (fileKinds.get(shape.files[0]) !== "base") {
        issues.push(
          `${shape.name}: layered Compose stack must start with its base file`,
        );
      }
    }
    if (!Object.hasOwn(manifest.examples, shape.exampleGroup)) {
      issues.push(
        `${shape.name}: references unknown example group ${shape.exampleGroup}`,
      );
    }
    const profiles = shape.profiles ?? [];
    if (profiles.some((profile) => profile.trim().length === 0)) {
      issues.push(`${shape.name}: profile names must be non-empty`);
    }
    if (new Set(profiles).size !== profiles.length) {
      issues.push(`${shape.name}: repeats an active profile`);
    }
    if (new Set(shape.capabilities).size !== shape.capabilities.length) {
      issues.push(`${shape.name}: repeats a deployment capability`);
    }

    const hasMcp = shape.capabilities.includes("mcp-server");
    if (shape.server.kind === "present" && !hasMcp) {
      issues.push(
        `${shape.name}: server-present shape lacks mcp-server capability`,
      );
    }
    if (shape.server.kind === "absent") {
      if (hasMcp) {
        issues.push(
          `${shape.name}: server-absent shape claims mcp-server capability`,
        );
      }
      if (shape.server.rationale.trim().length === 0) {
        issues.push(`${shape.name}: absent-server rationale is empty`);
      }
      if (Object.hasOwn(shape.server, "policy")) {
        issues.push(
          `${shape.name}: server-absent shape cannot carry server policy`,
        );
      }
    }

    const layered = stackKinds.includes("base");
    const patternB = shape.capabilities.includes("pattern-b-edge");
    if (layered && patternB !== profiles.includes("pattern-b")) {
      issues.push(
        `${shape.name}: layered pattern-b-edge capability and pattern-b profile must agree`,
      );
    }
    for (
      const [fileId, capability] of [
        ["patternB", "pattern-b-edge"],
        ["externalDb", "external-corpus"],
        ["cpuOllama", "cpu-ollama"],
      ] as const
    ) {
      const hasFile = shape.files.includes(fileId);
      const hasCapability = shape.capabilities.includes(capability);
      if (hasFile !== hasCapability && (hasFile || layered)) {
        issues.push(
          `${shape.name}: Compose file ${fileId} and capability ${capability} must agree`,
        );
      }
    }
  }
  for (const id of Object.keys(manifest.files)) {
    if (!referencedFiles.has(id)) {
      issues.push(`Compose file ${id} is not used by a documented deployment`);
    }
  }
  return issues;
}

export function auditDiscoveredComposeFiles(
  discoveredPaths: ReadonlySet<string>,
): string[] {
  const classified = new Set(
    Object.values(COMPOSE_FILES).map((file) => file.path),
  );
  const issues: string[] = [];
  for (const path of discoveredPaths) {
    if (!classified.has(path)) {
      issues.push(
        `Compose file is not classified as standalone or a supported override: ${path}`,
      );
    }
  }
  for (const path of classified) {
    if (!discoveredPaths.has(path)) {
      issues.push(`Missing classified Compose file: ${path}`);
    }
  }
  return issues;
}
