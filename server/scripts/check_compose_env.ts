// CLI engine for the canonical rendered-Compose environment contract.
// Deployment metadata and reviewed exceptions live in compose_deployments.ts;
// all policy evaluation lives in compose_env_audit.ts.

import { dirname, resolve } from "@std/path";
import {
  analyzeTarget,
  parseDockerfile,
  parseRenderedComposeTargets,
  renderComposeConfig,
} from "./check_allow_env.ts";
import {
  auditDeclaredServiceCapabilities,
  auditExampleEnvironment,
  auditForwardingRules,
  auditServerEnvironment,
  auditServerPlacement,
  collectComposeInterpolationVariables,
  type ComposeEnvironmentValue,
  composeFixtureValue,
  composeServiceNames,
  type ComposeSnapshot,
  type ComposeVariableMetadata,
  groupComposeVariables,
  parseComposeVariableMetadata,
  parseExampleEnvironment,
  serviceEnvironment,
  serviceEnvironmentValues,
  type UnknownRecord,
} from "./compose_env_audit.ts";
import {
  auditDeploymentManifest,
  composeFilePaths,
  type DeploymentShape,
  DOCUMENTED_DEPLOYMENTS,
  EXAMPLE_CONTRACTS,
  SERVER_DIR,
  SERVICE_CAPABILITY_CONTRACTS,
  SHARED_FORWARDING_RULES,
} from "./compose_deployments.ts";

interface RenderedShape {
  declaredServices: ReadonlySet<string>;
  document: UnknownRecord;
  rawEnvironment?: Readonly<Record<string, ComposeEnvironmentValue>>;
  serverServices: readonly string[];
  variables: ReadonlyMap<string, ComposeVariableMetadata>;
}

function serverServiceNames(
  document: UnknownRecord,
  shape: DeploymentShape,
  files: readonly string[],
  serverEntrypoint: string,
): string[] {
  const source = shape.name;
  const prefix = `${source}#`;
  return parseRenderedComposeTargets(
    document,
    source,
    dirname(resolve(files[0])),
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
  shape: DeploymentShape,
  serverEntrypoint: string,
): RenderedShape {
  const files = composeFilePaths(shape.files);
  const composeControlEnvironment = { COMPOSE_PROFILES: "" };
  const uninterpolatedDocument = renderComposeConfig(files, {
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
  // Seed variables from the real un-interpolated model so inventory remains
  // version-stable while required/default metadata still comes from Compose.
  const variableDocument = renderComposeConfig(files, {
    environment: inventoryEnvironment,
    profiles: shape.profiles,
    variables: true,
  });
  const variables = new Map(parseComposeVariableMetadata(variableDocument));
  // Compose 2.38.2 omits a supplied required bind-source variable from
  // --variables. Preserve the name from Compose's own un-interpolated model,
  // but represent unavailable metadata honestly instead of parsing Compose
  // expressions a second time. The current-version lane supplies and audits
  // Required/DefaultValue for the same variable.
  for (const key of interpolationVariables) {
    if (!variables.has(key)) {
      variables.set(key, {
        name: key,
        required: null,
        defaultValue: null,
        source: "raw-model-fallback",
      });
    }
  }
  const environment: Record<string, string> = {
    ...composeControlEnvironment,
  };
  for (const key of variables.keys()) interpolationVariables.add(key);
  for (const key of interpolationVariables) {
    environment[key] = composeFixtureValue(key);
  }
  return {
    declaredServices: composeServiceNames(uninterpolatedDocument, shape.name),
    variables,
    rawEnvironment,
    serverServices: serverServiceNames(
      uninterpolatedDocument,
      shape,
      files,
      serverEntrypoint,
    ),
    document: renderComposeConfig(files, {
      environment,
      interpolate: true,
      profiles: shape.profiles,
    }),
  };
}

function serverContract(): { entrypoint: string; supported: Set<string> } {
  const dockerfile = resolve(SERVER_DIR, "Dockerfile");
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
    const manifestIssues = auditDeploymentManifest();
    if (manifestIssues.length > 0) {
      throw new Error(
        `invalid Compose deployment manifest:\n${manifestIssues.join("\n")}`,
      );
    }

    const server = serverContract();
    const supported = server.supported;
    const rendered = new Map<string, RenderedShape>();
    for (const shape of DOCUMENTED_DEPLOYMENTS) {
      rendered.set(shape.name, renderShape(shape, server.entrypoint));
    }

    const baselineRendered = rendered.get("compose-local");
    if (!baselineRendered) {
      throw new Error("deployment manifest has no compose-local baseline");
    }
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

    const issues = auditForwardingRules(
      supported,
      SHARED_FORWARDING_RULES,
    );
    for (const shape of DOCUMENTED_DEPLOYMENTS) {
      const snapshot = rendered.get(shape.name)!;
      issues.push(
        ...auditDeclaredServiceCapabilities(
          shape.name,
          shape.capabilities,
          snapshot.declaredServices,
          SERVICE_CAPABILITY_CONTRACTS,
        ),
      );
      const environment = serviceEnvironment(snapshot.document, shape.name);
      const absentRationale = shape.server.kind === "absent"
        ? shape.server.rationale
        : undefined;
      const placementIssues = auditServerPlacement(
        shape.name,
        snapshot.serverServices,
        absentRationale,
      );
      issues.push(...placementIssues);
      if (shape.server.kind === "absent") {
        if (placementIssues.length === 0) {
          console.log(
            `✓ ${shape.name}: no server launcher (${shape.server.rationale})`,
          );
        }
        continue;
      }
      if (placementIssues.length > 0) continue;
      if (!environment || !snapshot.rawEnvironment) {
        issues.push(
          `${shape.name}: rendered Compose omitted required mcp service`,
        );
        continue;
      }
      const policy = shape.server.policy ?? {};
      const deploymentIssues = auditServerEnvironment(
        shape.name,
        supported,
        { environment, rawEnvironment: snapshot.rawEnvironment },
        shape.name === "compose-local" ? undefined : baseline,
        policy,
        SHARED_FORWARDING_RULES,
      );
      issues.push(...deploymentIssues);
      if (deploymentIssues.length === 0) {
        const omissionCount = Object.keys(policy.omissions ?? {}).length;
        console.log(
          `✓ ${shape.name}: ${Object.keys(environment).length} server keys` +
            (omissionCount > 0
              ? ` + ${omissionCount} documented omissions`
              : ""),
        );
      }
    }

    for (const [groupName, contract] of Object.entries(EXAMPLE_CONTRACTS)) {
      const inventories = DOCUMENTED_DEPLOYMENTS.filter((shape) =>
        shape.exampleGroup === groupName
      ).map((shape) => ({
        shape: shape.name,
        variables: rendered.get(shape.name)!.variables,
      }));
      const variables = groupComposeVariables(inventories);
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
        const metadataGapCount = [...variables.values()].filter((usages) =>
          usages.some((usage) =>
            usage.source === "raw-model-fallback"
          )
        ).length;
        console.log(
          `✓ ${groupName}/.env.example: documents ${variables.size} Compose variables` +
            (metadataGapCount > 0
              ? ` (${metadataGapCount} older-version metadata gap(s) normalized from the raw Compose model)`
              : " with required/default metadata"),
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
