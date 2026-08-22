type Role = {
  key: string;
  name: string;
  required: boolean;
  password_env: string;
  database_privileges: string;
  direct_privileges: string;
};

type RoleContract = {
  version: number;
  roles: Role[];
};

type ReadText = (path: string) => Promise<string>;

const ROLE_TOKEN = /\bopenbrain_[a-z][a-z0-9_]*\b/g;
const PASSWORD_TOKEN = /\bOPENBRAIN_[A-Z0-9_]+_PASSWORD\b/g;
const EXPECTED_KEYS = ["ingester", "rollup", "monitor"] as const;
const CONTRACT_FIELDS = ["roles", "version"];
const ROLE_FIELDS = [
  "database_privileges",
  "direct_privileges",
  "key",
  "name",
  "password_env",
  "required",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return sameStrings(Object.keys(value), expected);
}

function parseContract(text: string, manifestPath: string): RoleContract {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !exactKeys(parsed, CONTRACT_FIELDS)) {
    throw new Error(
      `log-sink role manifest ${manifestPath} must contain only version and roles`,
    );
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.roles)) {
    throw new Error(
      "log-sink role manifest must have version 1 and a roles array",
    );
  }

  const roles = parsed.roles.map((candidate, index): Role => {
    if (!isRecord(candidate) || !exactKeys(candidate, ROLE_FIELDS)) {
      throw new Error(
        `log-sink role manifest role ${index + 1} must contain exactly ${
          ROLE_FIELDS.join(", ")
        }`,
      );
    }
    if (
      typeof candidate.key !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.required !== "boolean" ||
      typeof candidate.password_env !== "string" ||
      typeof candidate.database_privileges !== "string" ||
      typeof candidate.direct_privileges !== "string"
    ) {
      throw new Error(
        `log-sink role manifest role ${index + 1} has an invalid field type`,
      );
    }
    return {
      key: candidate.key,
      name: candidate.name,
      required: candidate.required,
      password_env: candidate.password_env,
      database_privileges: candidate.database_privileges,
      direct_privileges: candidate.direct_privileges,
    };
  });
  return { version: 1, roles };
}

function parseArgs(args: string[]) {
  let root = ".";
  let manifest = "db/log-sink/role-contract.json";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--root" && args[index + 1]) {
      root = args[++index];
    } else if (argument === "--manifest" && args[index + 1]) {
      manifest = args[++index];
    } else {
      throw new Error(
        "usage: check_log_sink_roles.ts [--root PATH] [--manifest PATH]",
      );
    }
  }
  return { root: root.replace(/\/$/, ""), manifest };
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function shellWithoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function sqlWithoutComments(text: string): string {
  return text.replace(/--[^\n]*/g, "");
}

function roleTokens(text: string): string[] {
  return sorted(text.match(ROLE_TOKEN) ?? []);
}

function passwordTokens(text: string): string[] {
  return sorted(text.match(PASSWORD_TOKEN) ?? []);
}

function yamlService(text: string, service: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line === `  ${service}:`);
  if (first < 0) return "";
  let last = lines.length;
  for (let index = first + 1; index < lines.length; index++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      last = index;
      break;
    }
  }
  return lines.slice(first, last).join("\n");
}

function captures(text: string, pattern: RegExp): string[] {
  return sorted([...text.matchAll(pattern)].map((match) => match[1]));
}

export async function validateLogSinkRoles(
  root: string,
  manifestPath: string,
  readText: ReadText = Deno.readTextFile,
): Promise<{ contract: RoleContract; checks: number; errors: string[] }> {
  const errors: string[] = [];
  let checks = 0;
  const resolve = (path: string) =>
    path.startsWith("/") ? path : `${root}/${path}`;
  const read = (path: string) => readText(resolve(path));
  const fail = (label: string, detail: string) => {
    errors.push(`${label}: ${detail}`);
  };

  let contract: RoleContract;
  try {
    contract = parseContract(await read(manifestPath), manifestPath);
  } catch (error) {
    throw new Error(
      `cannot parse log-sink role manifest ${manifestPath}: ${error}`,
    );
  }

  const keys = contract.roles.map((role) => role.key);
  if (
    contract.roles.length !== EXPECTED_KEYS.length ||
    !sameStrings(keys, EXPECTED_KEYS)
  ) {
    fail(
      "manifest keys",
      `expected ${EXPECTED_KEYS.join(", ")}, found ${sorted(keys).join(", ")}`,
    );
  }

  const names = contract.roles.map((role) => role.name);
  const passwordEnvs = contract.roles.map((role) => role.password_env);
  if (new Set(names).size !== names.length) {
    fail("manifest names", "role names must be unique");
  }
  if (new Set(passwordEnvs).size !== passwordEnvs.length) {
    fail("manifest credentials", "password environment names must be unique");
  }
  for (const role of contract.roles) {
    if (!/^[a-z][a-z0-9_]*$/.test(role.name)) {
      fail(`manifest role ${role.key}`, `invalid SQL identifier ${role.name}`);
    }
    if (!/^OPENBRAIN_[A-Z0-9_]+_PASSWORD$/.test(role.password_env)) {
      fail(
        `manifest role ${role.key}`,
        `invalid password environment name ${role.password_env}`,
      );
    }
    if (!role.direct_privileges) {
      fail(`manifest role ${role.key}`, "direct_privileges must not be empty");
    }
    const databasePrivileges = role.database_privileges
      ? role.database_privileges.split(",")
      : [];
    if (
      databasePrivileges.some((privilege) => privilege !== "TEMPORARY") ||
      databasePrivileges.join(",") !== sorted(databasePrivileges).join(",")
    ) {
      fail(
        `manifest role ${role.key}`,
        `database_privileges must be a canonical comma-separated subset of TEMPORARY; found ${role.database_privileges}`,
      );
    }
  }

  const byKey = new Map(contract.roles.map((role) => [role.key, role]));
  const named = (key: string): string => {
    const role = byKey.get(key);
    if (!role) {
      throw new Error(`manifest is missing role key ${key}`);
    }
    return role.name;
  };
  if (byKey.get("ingester")?.required !== true) {
    fail("manifest ingester", "ingester must be required");
  }
  if (byKey.get("rollup")?.required !== true) {
    fail("manifest rollup", "rollup must be required");
  }
  if (byKey.get("monitor")?.required !== false) {
    fail("manifest monitor", "monitor must remain optional");
  }
  for (
    const [key, expected] of [
      ["ingester", ""],
      ["rollup", "TEMPORARY"],
      ["monitor", ""],
    ] as const
  ) {
    if (byKey.get(key)?.database_privileges !== expected) {
      fail(
        `manifest ${key}`,
        `database_privileges must be ${expected || "empty"}`,
      );
    }
  }

  const expectSet = (
    label: string,
    actual: Iterable<string>,
    expected: Iterable<string>,
  ) => {
    checks++;
    if (!sameStrings(actual, expected)) {
      fail(
        label,
        `expected [${sorted(expected).join(", ")}], found [${
          sorted(actual).join(", ")
        }]`,
      );
    }
  };

  const bootstrap = shellWithoutComments(
    await read("db/log-sink/00-log-sink-roles.sh"),
  );
  expectSet(
    "role bootstrap CREATE ROLE identities (db/log-sink/00-log-sink-roles.sh)",
    captures(bootstrap, /\bCREATE ROLE\s+([a-z][a-z0-9_]*)\b/g),
    names,
  );
  expectSet(
    "role bootstrap password environment (db/log-sink/00-log-sink-roles.sh)",
    passwordTokens(bootstrap),
    passwordEnvs,
  );

  const schema = sqlWithoutComments(await read("db/log-sink/01-log-sink.sql"));
  expectSet(
    "sink schema role literals (db/log-sink/01-log-sink.sql)",
    roleTokens(schema),
    names,
  );
  expectSet(
    "sink schema database TEMPORARY grants (db/log-sink/01-log-sink.sql)",
    captures(
      schema,
      /\bGRANT\s+TEMPORARY\s+ON\s+DATABASE\s+%I\s+TO\s+([a-z][a-z0-9_]*)\b/g,
    ),
    contract.roles
      .filter((role) => role.database_privileges === "TEMPORARY")
      .map((role) => role.name),
  );

  const assertion = await read("db/log-sink/02-log-sink-assertion.sql");
  const embedded = assertion.match(
    /-- ROLE_CONTRACT_JSON_BEGIN[\s\S]*?\$role_contract\$([\s\S]*?)\$role_contract\$[\s\S]*?-- ROLE_CONTRACT_JSON_END/,
  );
  checks++;
  if (!embedded) {
    fail(
      "sink assertion contract",
      "db/log-sink/02-log-sink-assertion.sql is missing embedded role-contract JSON markers",
    );
  } else {
    try {
      const embeddedRoles = JSON.parse(embedded[1]) as Role[];
      if (JSON.stringify(embeddedRoles) !== JSON.stringify(contract.roles)) {
        fail(
          "sink assertion contract",
          `db/log-sink/02-log-sink-assertion.sql differs from ${manifestPath}`,
        );
      }
    } catch (error) {
      fail(
        "sink assertion contract",
        `db/log-sink/02-log-sink-assertion.sql has invalid embedded JSON: ${error}`,
      );
    }
  }

  for (
    const [label, path] of [
      ["corpus sink-role exclusion", "db/03-grants-assertion.sql"],
      ["corpus sink-role retirement", "db/09-retire-corpus-funnel.sql"],
    ] as const
  ) {
    const tokens = roleTokens(await read(path)).filter((name) =>
      names.includes(name)
    );
    expectSet(`${label} (${path})`, tokens, names);
  }

  for (
    const [label, path] of [
      [
        "Qubes log-ingester Compose identity",
        "deploy/qubes/ingress-qube/docker-compose.yml",
      ],
      [
        "Pattern-B log-ingester Compose identity",
        "deploy/compose-tailnet/docker-compose.pattern-b.yml",
      ],
    ] as const
  ) {
    const compose = await read(path);
    const ingesterService = shellWithoutComments(
      yamlService(compose, "log-ingester"),
    );
    const sinkService = shellWithoutComments(yamlService(compose, "log-sink"));
    expectSet(
      `${label} (${path})`,
      captures(
        ingesterService,
        /^\s*DB_USER:\s*([a-z][a-z0-9_]*)\s*$/gm,
      ),
      [named("ingester")],
    );
    expectSet(
      `${label} ingester credential (${path})`,
      passwordTokens(ingesterService),
      [byKey.get("ingester")!.password_env],
    );
    expectSet(
      `${label} sink credentials (${path})`,
      passwordTokens(sinkService),
      passwordEnvs,
    );
  }

  const ingester = await read("server/log_ingester.ts");
  expectSet(
    "log-ingester runtime default (server/log_ingester.ts)",
    captures(
      ingester,
      /const DB_USER\s*=\s*optional\("DB_USER",\s*"([^"]+)"\)/g,
    ),
    [named("ingester")],
  );

  const monitor = shellWithoutComments(await read("scripts/funnel_monitor.sh"));
  expectSet(
    "monitor psql identity (scripts/funnel_monitor.sh)",
    captures(monitor, /\s-U\s+([a-z][a-z0-9_]*)\b/g),
    [named("monitor")],
  );
  expectSet(
    "monitor credential (scripts/funnel_monitor.sh)",
    passwordTokens(monitor),
    [byKey.get("monitor")!.password_env],
  );

  const summary = shellWithoutComments(
    await read("scripts/funnel_daily_summary.sh"),
  );
  const sinkTarget = summary.match(/\n\s*sink\)\n([\s\S]*?)\n\s*;;/);
  expectSet(
    "summary sink target identity (scripts/funnel_daily_summary.sh)",
    sinkTarget
      ? captures(sinkTarget[1], /\bTARGET_ROLE=([a-z][a-z0-9_]*)\b/g)
      : [],
    [named("rollup")],
  );
  expectSet(
    "summary sink target credential (scripts/funnel_daily_summary.sh)",
    sinkTarget ? passwordTokens(sinkTarget[1]) : [],
    [byKey.get("rollup")!.password_env],
  );
  expectSet(
    "summary executable sink literals (scripts/funnel_daily_summary.sh)",
    roleTokens(summary).filter((name) => names.includes(name)),
    [named("rollup")],
  );

  const ciConsumers: Array<[string, string, string[], string[]?]> = [
    ["CI shared helpers", "scripts/ci/log_sink_common.sh", ["rollup"]],
    [
      "CI contract smoke",
      "scripts/ci/log_sink_contract_smoke.sh",
      ["ingester", "rollup", "monitor"],
    ],
    [
      "CI lifecycle smoke",
      "scripts/ci/log_sink_lifecycle_smoke.sh",
      ["ingester", "rollup", "monitor"],
    ],
    ["CI rollup smoke", "scripts/ci/log_sink_rollup_smoke.sh", ["ingester"]],
    [
      "CI wrapper smoke",
      "scripts/ci/log_sink_wrapper_smoke.sh",
      ["ingester", "rollup"],
    ],
    [
      "CI log-sink runner",
      "scripts/ci/run_log_sink_smokes.sh",
      ["ingester"],
      ["openbrain_ci_drift", "openbrain_logs"],
    ],
  ];
  for (const [label, path, roleKeys, allowedOther = []] of ciConsumers) {
    expectSet(
      `${label} (${path})`,
      roleTokens(shellWithoutComments(await read(path))),
      [...roleKeys.map(named), ...allowedOther],
    );
  }
  expectSet(
    "CI log-sink runner credentials (scripts/ci/run_log_sink_smokes.sh)",
    passwordTokens(
      shellWithoutComments(await read("scripts/ci/run_log_sink_smokes.sh")),
    ),
    passwordEnvs,
  );

  for (
    const [label, path] of [
      ["CI corpus grants exclusion", "scripts/ci/db_init_grants_smoke.sh"],
      [
        "CI corpus retirement fixture",
        "scripts/ci/db_init_retirement_smoke.sh",
      ],
      ["CI corpus schema exclusion", "scripts/ci/db_init_schema_smoke.sh"],
    ] as const
  ) {
    const tokens = roleTokens(shellWithoutComments(await read(path))).filter(
      (name) => names.includes(name),
    );
    expectSet(`${label} (${path})`, tokens, names);
  }

  expectSet(
    "Pattern-B Compose validator identity (scripts/check_pattern_b_compose.nu)",
    roleTokens(await read("scripts/check_pattern_b_compose.nu")),
    [named("ingester")],
  );

  const docs: Array<[string, string, string[]]> = [
    [
      "ingress runbook role contract",
      "deploy/qubes/ingress-qube/README.md",
      ["ingester", "rollup", "monitor"],
    ],
    [
      "Pattern-B runbook role contract",
      "deploy/compose-tailnet/README.md",
      ["ingester", "rollup", "monitor"],
    ],
    [
      "security-model role contract",
      "docs/security-model.md",
      ["ingester", "rollup", "monitor"],
    ],
  ];
  for (const [label, path, roleKeys] of docs) {
    const tokens = roleTokens(await read(path)).filter((name) =>
      names.includes(name)
    );
    expectSet(`${label} (${path})`, tokens, roleKeys.map(named));
  }

  checks++;
  if (
    !shellWithoutComments(await read("scripts/ci/run_log_sink_smokes.sh"))
      .includes("check_log_sink_roles.ts")
  ) {
    fail(
      "CI role-contract invocation",
      "run_log_sink_smokes.sh preflight does not invoke the validator",
    );
  }

  return { contract, checks, errors };
}

if (import.meta.main) {
  try {
    const { root, manifest } = parseArgs(Deno.args);
    const result = await validateLogSinkRoles(root, manifest);
    if (result.errors.length > 0) {
      console.error("log-sink role contract drift:");
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      Deno.exit(1);
    }
    console.log(
      `Log-sink role contract: ${result.contract.roles.length} roles and ${result.checks} authoritative consumers verified`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}
