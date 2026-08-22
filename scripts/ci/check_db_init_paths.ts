import { assert, assertEquals } from "@std/assert";
import { globToRegExp } from "@std/path";
import { parse } from "@std/yaml";

type Trigger = { paths?: unknown };
type Workflow = {
  on?: {
    pull_request?: Trigger;
    push?: Trigger;
  };
};

const workflowPath = ".github/workflows/db-init.yml";
const workflow = parse(await Deno.readTextFile(workflowPath)) as Workflow;
const pullRequestPaths = workflow.on?.pull_request?.paths;
const pushPaths = workflow.on?.push?.paths;

assert(
  Array.isArray(pullRequestPaths) &&
    pullRequestPaths.every((entry) => typeof entry === "string"),
  "pull_request.paths must be a string list",
);
assert(
  Array.isArray(pushPaths) &&
    pushPaths.every((entry) => typeof entry === "string"),
  "push.paths must be a string list",
);
assertEquals(
  pushPaths,
  pullRequestPaths,
  "push and pull_request must resolve from one DB-init path contract",
);

const patterns = pullRequestPaths as string[];
const representativeChanges = [
  "db/01-schema.sql",
  "server/auth.ts",
  "deploy/qubes/ingress-qube/docker-compose.yml",
  "deploy/qubes/ingress-qube/openbrain-log-sink-dump_test.sh",
  "deploy/qubes/app-qube/rc.local",
  "scripts/ci/db_init_auth_smoke.sh",
  ".github/workflows/db-init.yml",
];
const roleContractConsumers = [
  "server/log_ingester.ts",
  "scripts/check_pattern_b_compose.nu",
  "deploy/qubes/ingress-qube/README.md",
  "deploy/compose-tailnet/README.md",
  "docs/security-model.md",
];

for (const candidate of [...representativeChanges, ...roleContractConsumers]) {
  assert(
    patterns.some((pattern) =>
      globToRegExp(pattern, { globstar: true }).test(candidate)
    ),
    `DB-init path contract does not cover representative change: ${candidate}`,
  );
}

console.log(
  `DB-init path contract: ${patterns.length} shared patterns cover ${representativeChanges.length} representative changes and ${roleContractConsumers.length} role-contract consumers`,
);
