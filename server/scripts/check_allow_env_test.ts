import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeTarget,
  type CheckTarget,
  parseComposeTargets,
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
    "interpolated entrypoints cannot be audited",
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
    "compose.yml#unsafe-tool: bare --allow-env grants the entire environment",
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

Deno.test("repository token-admin entrypoint carries the full bounded PG policy", () => {
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
  assertEquals(analyzeTarget(target, serverDir).missing, []);
});
