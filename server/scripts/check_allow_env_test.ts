import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeTarget,
  type CheckTarget,
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

Deno.test("known env wrappers fail closed on dynamic keys", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/dynamic.ts`;
    await Deno.writeTextFile(
      path,
      `
function optionalTrimmed(name: string): string { return name; }
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

Deno.test("direct dynamic env reads outside known wrappers fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/dynamic_direct.ts`;
    await Deno.writeTextFile(
      path,
      `export function read(name: string): string | undefined {
  return Deno.env.get(name);
}\n`,
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
