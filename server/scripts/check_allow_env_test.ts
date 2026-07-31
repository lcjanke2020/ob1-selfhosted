import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeTarget,
  type CheckTarget,
  DENO_POSTGRES_ALLOW_ENV,
  dependencyEnvForEntrypoint,
  findEnvReads,
  parseComposeTargets,
  parseDockerfile,
  TOKEN_ADMIN_ALLOW_ENV,
} from "./check_allow_env.ts";

function onlyTarget(content: string): CheckTarget {
  const targets = parseComposeTargets(content, "compose.yml");
  assertEquals(targets.length, 1);
  return targets[0];
}

Deno.test("Compose block-list entrypoints produce bounded Deno targets", () => {
  const target = onlyTarget(`
services:
  tool:
    image: example
    entrypoint:
      - deno
      - run
      - --allow-net
      - --allow-env=FOO,BAR
      - /app/tool.ts
`);

  assertEquals(target.source, "compose.yml#tool");
  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv].sort(), ["BAR", "FOO"]);
});

Deno.test("Compose inline-list entrypoints produce bounded Deno targets", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, "--allow-env=FOO,BAR", /app/tool.ts]
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv].sort(), ["BAR", "FOO"]);
});

Deno.test("Compose scalar entrypoints produce bounded Deno targets", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint: "deno run --allow-env=FOO /app/tool.ts"
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose command-only Deno launchers are audited", () => {
  const target = onlyTarget(`
services:
  tool:
    command: [deno, run, --allow-env=FOO, /app/tool.ts]
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose entrypoint and command form one effective launcher", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno]
    command: [run, --allow-env=FOO, /app/tool.ts]
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Deno global options before run remain auditable", () => {
  for (
    const globalOptions of [
      ["--quiet"],
      ["--log-level", "info"],
      ["-L", "debug"],
    ]
  ) {
    const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, ${
      globalOptions.join(", ")
    }, run, --allow-env=FOO, /app/tool.ts]
`);

    assertEquals(target.entrypoint, "tool.ts");
    assertEquals([...target.allowEnv], ["FOO"]);
  }
});

Deno.test("global option operands cannot hide a later unrestricted grant", () => {
  for (const globalOptions of ["--log-level, info", "-L, info"]) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, ${globalOptions}, run, -A, /app/tool.ts]
`),
      Error,
      "-A/--allow-all grants every permission",
    );
  }
});

Deno.test("unknown global option boundaries fail closed after deno is found", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, --future-global, value, run, -A, /app/tool.ts]
`),
    Error,
    "global --future-global has unknown argument boundaries",
  );
});

Deno.test("multiple Deno invocations in one shell launcher fail closed", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint:
      - sh
      - -c
      - "deno run --allow-env=FIRST_ENV /app/first.ts && deno run -A /app/second.ts"
`),
    Error,
    "shell-wrapped Deno launchers cannot be audited",
  );
});

Deno.test("shell control operators are invocation boundaries without spaces", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint:
      - sh
      - -c
      - "deno run --allow-env=FIRST_ENV /app/first.ts arg;deno run -A /app/second.ts"
`),
    Error,
    "shell-wrapped Deno launchers cannot be audited",
  );
});

Deno.test("shell command substitution fails closed", () => {
  for (
    const command of [
      "`printf deno` run -A /app/tool.ts",
      "$(printf deno) run -A /app/tool.ts",
    ]
  ) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [sh, -c, '${command}']
`),
      Error,
      "shell command substitution cannot be audited",
    );
  }
});

Deno.test("env split-string launchers fail closed", () => {
  for (
    const launcher of [
      '[env, -S, "deno run -A /app/tool.ts"]',
      '[env, --split-string, "deno run -A /app/tool.ts"]',
      '[/usr/bin/env, "--split-string=deno run -A /app/tool.ts"]',
      '[/usr/bin/env, "-Sdeno run -A /app/tool.ts"]',
      '[env, -iS, "deno run -A /app/tool.ts"]',
      '[env, "--s=deno run -A /app/tool.ts"]',
      '[env, -u, deno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
      '[env, --unset, deno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
      '[env, --unset=deno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
      '[env, -a, deno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
      '[env, -udeno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
      '[env, -C, deno, "--split-string=deno run -A /app/evil.ts", run, --allow-env=SAFE, /app/safe.ts]',
    ]
  ) {
    assertThrows(
      () =>
        parseComposeTargets(
          `
services:
  unsafe-tool:
    entrypoint: ${launcher}
`,
          "compose.yml",
        ),
      Error,
      "env -S/--split-string launchers cannot be audited",
    );
  }
});

Deno.test("plain env wrappers preserve literal Deno argv", () => {
  for (
    const prefix of [
      "MODE=production",
      "-i",
      "-u, IGNORED_KEY",
      "-a, -S",
      "-C, /tmp",
    ]
  ) {
    const target = onlyTarget(`
services:
  tool:
    entrypoint: [env, ${prefix}, deno, run, --allow-env=FOO, /app/tool.ts]
`);

    assertEquals(target.entrypoint, "tool.ts");
    assertEquals([...target.allowEnv], ["FOO"]);
  }
});

Deno.test("env split options after the Deno module remain script arguments", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, --allow-env=FOO, /app/tool.ts, env, -S]
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("executable Deno subcommands outside run fail closed", () => {
  for (
    const launcher of [
      '[deno, eval, "console.log(1)"]',
      "[deno, serve, -A, /app/index.ts]",
      "[deno, task, start]",
    ]
  ) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint: ${launcher}
`),
      Error,
      "is not an auditable launcher",
    );
  }
});

Deno.test("Deno run option operands cannot become the audited module", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint:
      - deno
      - run
      - --config
      - /app/config.ts
      - --allow-env=FOO
      - /app/tool.ts
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Deno run log-level operands remain auditable", () => {
  for (const option of ["-L", "--log-level"]) {
    const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, ${option}, info, --allow-env=FOO, /app/tool.ts]
`);

    assertEquals(target.entrypoint, "tool.ts");
    assertEquals([...target.allowEnv], ["FOO"]);
  }
});

Deno.test("self-contained option values ending in .ts do not shift the module", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint:
      - deno
      - run
      - --allow-read=/app/index.ts
      - --allow-env=FOO
      - /app/tool.ts
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Deno paths inside option values are not extra invocations", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint:
      - deno
      - run
      - --allow-run=/usr/bin/deno
      - --allow-env=FOO
      - /app/tool.ts
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose YAML anchors and service merges remain auditable", () => {
  const target = onlyTarget(`
x-tool: &tool
  entrypoint: [deno, run, --allow-env=FOO, /app/tool.ts]
services:
  tool:
    <<: *tool
`);

  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose interpolated entrypoints fail closed", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  dynamic-tool:
    entrypoint: "\${TOOL_ENTRYPOINT}"
`),
    Error,
    "interpolated entrypoint cannot be audited",
  );
});

Deno.test("Compose unbraced interpolation fails closed", () => {
  assertThrows(
    () =>
      parseComposeTargets(
        `
services:
  dynamic-tool:
    command: ["$DENO", run, --allow-env=FOO, /app/tool.ts]
`,
        "compose.yml",
      ),
    Error,
    "interpolated command cannot be audited",
  );
});

Deno.test("Compose Deno entrypoints reject a bare --allow-env", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint:
      - deno
      - run
      - --allow-env
      - /app/tool.ts
`),
    Error,
    "compose.yml#unsafe-tool: bare -E/--allow-env grants the entire environment",
  );
});

Deno.test("Compose Deno entrypoints reject a bare -E", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, run, -E, /app/tool.ts]
`),
    Error,
    "bare -E/--allow-env grants the entire environment",
  );
});

Deno.test("Compose Deno entrypoints accept a bounded -E list", () => {
  const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, "-E=FOO,BAR", /app/tool.ts]
`);

  assertEquals([...target.allowEnv].sort(), ["BAR", "FOO"]);
});

Deno.test("Compose Deno entrypoints reject clustered all-permission flags", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, run, -Aq, /app/tool.ts]
`),
    Error,
    "-A/--allow-all grants every permission",
  );
});

Deno.test("Compose Deno entrypoints reject named permission sets", () => {
  for (const permissionSet of ["-P=wide", "--permission-set=wide"]) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, run, ${permissionSet}, /app/tool.ts]
`),
      Error,
      "-P/--permission-set can grant unaudited environment access",
    );
  }
});

Deno.test("Compose Deno entrypoints reject preload and require modules", () => {
  for (const option of ["--preload", "--require"]) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint:
      - deno
      - run
      - --allow-env=PRELOAD_ENV
      - ${option}
      - /app/preload_env.ts
      - /app/main_env.ts
`),
      Error,
      `${option} executes code outside the audited main-module graph`,
    );
  }
});

Deno.test("permission-looking script arguments are not counted as grants", () => {
  const afterModule = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, /app/tool.ts, --allow-env=NOT_A_GRANT]
`);
  const afterBoundary = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, --, /app/tool.ts, --allow-env=NOT_A_GRANT]
`);
  const scriptBoundary = onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, /app/tool.ts, --, --allow-env=NOT_A_GRANT]
`);

  assertEquals([...afterModule.allowEnv], []);
  assertEquals([...afterBoundary.allowEnv], []);
  assertEquals([...scriptBoundary.allowEnv], []);
});

Deno.test("empty bounded allow-env lists have a precise diagnostic", () => {
  assertThrows(
    () =>
      onlyTarget(`
services:
  tool:
    entrypoint: [deno, run, "--allow-env=", /app/tool.ts]
`),
    Error,
    "empty --allow-env= list",
  );
});

Deno.test("target analysis reports env reads missing from a Compose allowlist", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      `
import { child } from "./child.ts";
export const present = Deno.env.get("PRESENT") ?? child;
`,
    );
    await Deno.writeTextFile(
      `${directory}/child.ts`,
      `export const child = Deno.env.get("CHILD_MISSING") ?? "";\n`,
    );

    const analysis = analyzeTarget(
      {
        source: "compose.yml#tool",
        entrypoint: "main.ts",
        allowEnv: new Set(["PRESENT"]),
      },
      directory,
    );

    assertEquals(analysis.missing, ["CHILD_MISSING"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("static template dynamic imports stay in the audited graph", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      "await import(`./child.ts`);\n",
    );
    await Deno.writeTextFile(
      `${directory}/child.ts`,
      'export const child = Deno.env.get("TEMPLATE_IMPORT_ENV");\n',
    );

    const analysis = analyzeTarget(
      {
        source: "compose.yml#tool",
        entrypoint: "main.ts",
        allowEnv: new Set(),
      },
      directory,
    );

    assertEquals([...analysis.files].sort(), ["child.ts", "main.ts"]);
    assertEquals(analysis.missing, ["TEMPLATE_IMPORT_ENV"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("non-literal dynamic imports fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      'const moduleName = "./child.ts";\nawait import(moduleName);\n',
    );

    assertThrows(
      () =>
        analyzeTarget(
          {
            source: "compose.yml#tool",
            entrypoint: "main.ts",
            allowEnv: new Set(),
          },
          directory,
        ),
      Error,
      "dynamic import specifier must use a string or static template literal",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("derived env wrappers fail closed on dynamic keys", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/dynamic.ts`;
    await Deno.writeTextFile(
      path,
      `
function optionalTrimmed(name: string): string {
  return Deno.env.get(name) ?? "";
}
function indirect(name: string): string { return optionalTrimmed(name); }
export const value = indirect("DYNAMIC_KEY");
`,
    );
    assertThrows(
      () => findEnvReads(path),
      Error,
      "optionalTrimmed() must receive a string-literal env key",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("wrapper suppression requires the unmodified key parameter", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const derivedPath = `${directory}/derived.ts`;
    await Deno.writeTextFile(
      derivedPath,
      `function optional(name: string): string {
  return Deno.env.get(name) ?? Deno.env.get(\`\${name}_FALLBACK\`) ?? "";
}
export const value = optional("MODE");
`,
    );
    assertThrows(
      () => findEnvReads(derivedPath),
      Error,
      "Deno.env.get() must receive a string-literal env key",
    );

    const modifiedPath = `${directory}/modified.ts`;
    await Deno.writeTextFile(
      modifiedPath,
      `function required(name: string): string {
  name += "_FALLBACK";
  return Deno.env.get(name) ?? "";
}
export const value = required("MODE");
`,
    );
    assertThrows(
      () => findEnvReads(modifiedPath),
      Error,
      "cannot modify or shadow its name parameter",
    );

    const shadowedPath = `${directory}/shadowed.ts`;
    await Deno.writeTextFile(
      shadowedPath,
      `function optional(name: string): string {
  {
    const name = "SHADOWED_ENV";
    return Deno.env.get(name) ?? "";
  }
}
export const value = optional("MODE");
`,
    );
    assertThrows(
      () => findEnvReads(shadowedPath),
      Error,
      "cannot modify or shadow its name parameter",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("env wrappers are derived without common-name false positives", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const unrelatedPath = `${directory}/unrelated.ts`;
    await Deno.writeTextFile(
      unrelatedPath,
      `export function required(value: string): string {
  return value.trim();
}
function env(value: number): number { return value * 2; }
export const doubled = env(2);
`,
    );
    assertEquals([...findEnvReads(unrelatedPath)], []);

    const wrapperPath = `${directory}/wrapper.ts`;
    await Deno.writeTextFile(
      wrapperPath,
      `function readSetting(key: string): string {
  return Deno.env.get(key) ?? "";
}
export const value = readSetting("DERIVED_WRAPPER_ENV");
`,
    );
    assertEquals([...findEnvReads(wrapperPath)], ["DERIVED_WRAPPER_ENV"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("known env wrapper aliases and exports fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const aliasPath = `${directory}/alias.ts`;
    await Deno.writeTextFile(
      aliasPath,
      `function required(name: string): string {
  return Deno.env.get(name) ?? "";
}
const readRequired = required;
export const value = readRequired("ALIASED_WRAPPER_ENV");
`,
    );
    assertThrows(
      () => findEnvReads(aliasPath),
      Error,
      "known env wrapper required() cannot be aliased or exported",
    );

    const exportPath = `${directory}/exported.ts`;
    await Deno.writeTextFile(
      exportPath,
      `export function optional(name: string): string {
  return Deno.env.get(name) ?? "";
}
`,
    );
    assertThrows(
      () => findEnvReads(exportPath),
      Error,
      "known env wrapper optional() cannot be exported",
    );

    const reExportPath = `${directory}/re_exported.ts`;
    await Deno.writeTextFile(
      reExportPath,
      `function env(name: string): string {
  return Deno.env.get(name) ?? "";
}
export { env as readEnv };
`,
    );
    assertThrows(
      () => findEnvReads(reExportPath),
      Error,
      "known env wrapper env() cannot be aliased or exported",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("direct dynamic env reads outside known wrappers fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/dynamic_direct.ts`;
    await Deno.writeTextFile(
      path,
      `const name = "DYNAMIC_DIRECT_ENV";
export const value = Deno.env.get(name);\n`,
    );
    assertThrows(
      () => findEnvReads(path),
      Error,
      "Deno.env.get() must receive a string-literal env key",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("env reads survive templates, optional chaining, and regex literals", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/lexical.ts`;
    await Deno.writeTextFile(
      path,
      `
export default /['"]/;
const strip = (value: string) => value.replace(/['"]/g, "");
export const rendered = \`value=\${Deno.env.get("TEMPLATE_ENV")}\`;
export const optional = Deno.env?.get("OPTIONAL_ENV");
export const afterDefaultRegex = Deno.env.get("AFTER_DEFAULT_REGEX");
export const afterRegex = Deno.env.get("AFTER_REGEX");
export const stringFake = 'Deno.env.get("STRING_FAKE")';
export const bracketStringFake = 'Deno["env"].get("BRACKET_STRING_FAKE")';
// Deno.env.get("COMMENT_FAKE");
// Deno["env"].get("BRACKET_COMMENT_FAKE");
`,
    );

    assertEquals([...findEnvReads(path)].sort(), [
      "AFTER_DEFAULT_REGEX",
      "AFTER_REGEX",
      "OPTIONAL_ENV",
      "TEMPLATE_ENV",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("env reads after unbraced control-flow regex literals remain visible", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/control_regex.ts`;
    await Deno.writeTextFile(
      path,
      `if (true) /'/.test(Deno.env.get("CONTROL_REGEX_ENV") ?? "") && /'/.test("");\n`,
    );

    assertEquals([...findEnvReads(path)], ["CONTROL_REGEX_ENV"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("destructured Deno env aliases fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/aliased.ts`;
    await Deno.writeTextFile(
      path,
      `const { env } = Deno;\nexport const value = env.get("ALIASED_ENV");\n`,
    );

    assertThrows(
      () => findEnvReads(path),
      Error,
      "unmodelled Deno binding cannot be audited",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("invalid TypeScript lexical forms fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const invalidSources = [
      "export const value = /unterminated;\n",
      "/* unterminated",
      "export const value = 'unterminated\n",
      "export const value = `unterminated\n",
      'export const value = `value=${Deno.env.get("X")`;\n',
    ];
    for (const [index, content] of invalidSources.entries()) {
      const path = `${directory}/invalid_${index}.ts`;
      await Deno.writeTextFile(path, content);
      assertThrows(
        () => findEnvReads(path),
        Error,
        "TypeScript syntax cannot be audited",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("decorators and auto-accessors remain auditable", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/decorated.ts`;
    await Deno.writeTextFile(
      path,
      `function registered() {}
@registered
class Config {
  accessor value = Deno.env.get("DECORATED_ENV");
}
export const config = new Config();
`,
    );

    assertEquals([...findEnvReads(path)], ["DECORATED_ENV"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("unmodelled Deno.env APIs fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/unmodelled.ts`;
    await Deno.writeTextFile(path, "export const env = Deno.env.toObject();\n");
    assertThrows(
      () => findEnvReads(path),
      Error,
      "unmodelled Deno.env access cannot be audited",
    );

    const bracketPath = `${directory}/bracket.ts`;
    await Deno.writeTextFile(
      bracketPath,
      'export const value = Deno["env"].get("BRACKET_ENV");\n',
    );
    assertThrows(
      () => findEnvReads(bracketPath),
      Error,
      "unmodelled computed Deno property access cannot be audited",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reachable postgres imports derive the external driver policy", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      'import "./worker.ts";\n',
    );
    await Deno.writeTextFile(
      `${directory}/worker.ts`,
      'import { Pool } from "postgres";\nexport { Pool };\n',
    );

    assertEquals(
      [...dependencyEnvForEntrypoint("main.ts", directory)].sort(),
      [...DENO_POSTGRES_ALLOW_ENV].sort(),
    );
    const analysis = analyzeTarget(
      {
        source: "compose.yml#tool",
        entrypoint: "main.ts",
        allowEnv: new Set(),
      },
      directory,
    );
    assertEquals(analysis.missing, [...DENO_POSTGRES_ALLOW_ENV].sort());
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("DEFAULT_WORKSPACE_ID is a visible literal wrapper read", () => {
  const configPath = fromFileUrl(new URL("../config.ts", import.meta.url));
  assertEquals(findEnvReads(configPath).has("DEFAULT_WORKSPACE_ID"), true);
});

Deno.test("Dockerfile parsing shares unrestricted-grant enforcement", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/Dockerfile`;
    await Deno.writeTextFile(
      path,
      `FROM denoland/deno:2.9.4\nCMD ["deno", "run", "-Aq", "tool.ts"]\n`,
    );
    assertThrows(
      () => parseDockerfile(path),
      Error,
      "-A/--allow-all grants every permission",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Docker shell operators expose adjacent Deno invocations", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/Dockerfile`;
    await Deno.writeTextFile(
      path,
      `FROM denoland/deno:2.9.4
ENTRYPOINT ["sh", "-c", "exec deno run --allow-env=FIRST_ENV \\"$@\\";deno run -A second.ts", "sh"]
CMD ["first.ts"]
`,
    );
    assertThrows(
      () => parseDockerfile(path),
      Error,
      "multiple Deno invocations cannot be audited",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("repository token-admin entrypoint carries the exact driver policy", () => {
  const composePath = fromFileUrl(
    new URL("../../deploy/compose-local/docker-compose.yml", import.meta.url),
  );
  const serverDir = fromFileUrl(new URL("..", import.meta.url));
  const targets = parseComposeTargets(
    Deno.readTextFileSync(composePath),
    "deploy/compose-local/docker-compose.yml",
  );
  const target = targets.find((candidate) =>
    candidate.source.endsWith("#token-admin")
  );
  if (!target) throw new Error("token-admin Compose target not found");

  assertEquals(
    [...target.allowEnv].sort(),
    [...TOKEN_ADMIN_ALLOW_ENV].sort(),
  );
  const analysis = analyzeTarget(target, serverDir);
  assertEquals(analysis.missing, []);
  assertEquals(analysis.required.size, TOKEN_ADMIN_ALLOW_ENV.length);
});
