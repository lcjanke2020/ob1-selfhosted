import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  analyzeTarget,
  type CheckTarget,
  DENO_POSTGRES_ALLOW_ENV,
  dependencyEnvForEntrypoint,
  findEnvReads,
  parseComposeStackTargets,
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

Deno.test("Compose override stacks audit inherited Deno launchers", () => {
  const base = `
services:
  tool:
    entrypoint: [deno]
    command: [run, --allow-env=SAFE, /app/tool.ts]
`;
  const bounded = parseComposeStackTargets([
    { content: base, source: "base.yml" },
    {
      content: `
services:
  tool:
    command: [run, --allow-env=OVERRIDE, /app/tool.ts]
`,
      source: "override.yml",
    },
  ]);
  assertEquals(bounded.length, 1);
  assertEquals([...bounded[0].allowEnv], ["OVERRIDE"]);

  assertThrows(
    () =>
      parseComposeStackTargets([
        { content: base, source: "base.yml" },
        {
          content: `
services:
  tool:
    command: [run, --allow-env, /app/tool.ts]
`,
          source: "override.yml",
        },
      ]),
    Error,
    "bare -E/--allow-env grants the entire environment",
  );
});

Deno.test("Compose command overrides inherit built image launchers", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/Dockerfile`,
      `FROM denoland/deno:2.9.4
ENTRYPOINT ["deno", "run", "--no-config", "--allow-env=SAFE"]
CMD ["safe.ts"]
`,
    );
    await Deno.writeTextFile(
      `${directory}/actual.ts`,
      'export const value = Deno.env.get("IMAGE_DEFAULT_ONLY");\n',
    );

    const targets = parseComposeStackTargets([
      {
        content: `services:\n  tool:\n    build:\n      context: .\n`,
        source: `${directory}/compose.yml`,
      },
      {
        content: `services:\n  tool:\n    command: [actual.ts]\n`,
        source: `${directory}/override.yml`,
      },
    ]);

    assertEquals(targets.length, 1);
    assertEquals(targets[0].entrypoint, "actual.ts");
    assertEquals([...targets[0].allowEnv], ["SAFE"]);
    assertEquals(analyzeTarget(targets[0], directory).missing, [
      "IMAGE_DEFAULT_ONLY",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Compose command overrides fail closed for unresolved images", () => {
  assertThrows(
    () =>
      parseComposeTargets(
        `services:\n  tool:\n    image: example.invalid/tool:1\n    command: [actual.ts]\n`,
        "compose.yml",
      ),
    Error,
    "command overrides an image whose ENTRYPOINT cannot be resolved",
  );
});

Deno.test("image-only Compose services fail closed on unresolved launchers", () => {
  assertThrows(
    () =>
      parseComposeTargets(
        `services:\n  bypass:\n    image: example.invalid/tool:1\n`,
        "compose.yml",
      ),
    Error,
    "image launcher defaults for example.invalid/tool:1 cannot be resolved",
  );
  assertThrows(
    () =>
      parseComposeStackTargets([
        {
          content: `services:\n  bypass:\n    image: example.invalid/tool:1\n`,
          source: "base.yml",
        },
        {
          content: `services:\n  bypass:\n    restart: always\n`,
          source: "override.yml",
        },
      ]),
    Error,
    "image launcher defaults for example.invalid/tool:1 cannot be resolved",
  );
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  bypass:\n    image: ${REGISTRY}/tool:1\n",
        "compose.yml",
      ),
    Error,
    "image must be a literal string",
  );
});

Deno.test("reviewed non-Deno images pass only on their unmodified defaults", () => {
  for (const image of ["pgvector/pgvector:pg16", "ollama/ollama:0.24.0"]) {
    assertEquals(
      parseComposeTargets(
        `services:\n  svc:\n    image: ${image}\n`,
        "compose.yml",
      ),
      [],
    );
  }
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  svc:\n    image: pgvector/pgvector:pg16\n" +
          "    command: [postgres, -c, jit=off]\n",
        "compose.yml",
      ),
    Error,
    "command overrides an image whose ENTRYPOINT cannot be resolved",
  );
});

Deno.test("Compose merge tags on launcher-relevant fields fail closed", () => {
  assertThrows(
    () =>
      parseComposeStackTargets([
        {
          content: "services:\n  tool:\n    build:\n      context: ./actual\n" +
            "      dockerfile: Dockerfile.safe\n",
          source: "base.yml",
        },
        {
          content:
            "services:\n  tool:\n    build: !override\n      context: ./actual\n",
          source: "override.yml",
        },
      ]),
    Error,
    "Compose merge tag on build cannot be audited",
  );

  const rejected: [string, string][] = [
    [
      "entrypoint: !override [deno, run, --allow-env=FOO, /app/tool.ts]",
      "entrypoint",
    ],
    ["command: !reset null", "command"],
    ["image: !override example.invalid/tool:1", "image"],
  ];
  for (const [line, field] of rejected) {
    assertThrows(
      () =>
        parseComposeTargets(`services:\n  tool:\n    ${line}\n`, "compose.yml"),
      Error,
      `Compose merge tag on ${field} cannot be audited`,
    );
  }
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  tool:\n    build:\n      dockerfile: !override Dockerfile.evil\n",
        "compose.yml",
      ),
    Error,
    "Compose merge tag on dockerfile cannot be audited",
  );
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  tool: !override\n    image: example.invalid/tool:1\n",
        "compose.yml",
      ),
    Error,
    "Compose merge tag on tool cannot be audited",
  );
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  tool:\n    entrypoint:\n      - !reset deno\n",
        "compose.yml",
      ),
    Error,
    "Compose merge tag on an unrecognised position cannot be audited",
  );
});

Deno.test("Compose null overrides follow field-dependent merge semantics", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/Dockerfile`,
      `FROM denoland/deno:2.9.4
ENTRYPOINT ["deno", "run", "--no-config", "--allow-env=SAFE"]
CMD ["actual.ts"]
`,
    );
    const base = {
      content: "services:\n  tool:\n    build:\n      context: .\n",
      source: `${directory}/base.yml`,
    };
    // A null service override (including the bare `tool:` stub) and null
    // build/image retain the accumulated launcher, matching rendered Compose.
    for (
      const override of [
        "services:\n  tool: null\n",
        "services:\n  tool:\n",
        "services:\n  tool:\n    build: null\n",
        "services:\n  tool:\n    image: null\n",
      ]
    ) {
      const targets = parseComposeStackTargets([
        base,
        { content: override, source: `${directory}/override.yml` },
      ]);
      assertEquals(targets.length, 1);
      assertEquals(targets[0].entrypoint, "actual.ts");
      assertEquals([...targets[0].allowEnv], ["SAFE"]);
    }
    // Null entrypoint/command reset instead of retaining: the base launcher
    // is dropped and the override command is audited on its own.
    const reset = parseComposeStackTargets([
      {
        content: "services:\n  tool:\n    entrypoint: " +
          '[deno, run, "--allow-env=BASE_ONLY", /app/base.ts]\n',
        source: `${directory}/base.yml`,
      },
      {
        content: "services:\n  tool:\n    entrypoint: null\n    command: " +
          '[deno, run, "--allow-env=FOO", /app/tool.ts]\n',
        source: `${directory}/override.yml`,
      },
    ]);
    assertEquals(reset.length, 1);
    assertEquals(reset[0].entrypoint, "tool.ts");
    assertEquals([...reset[0].allowEnv], ["FOO"]);
    // image: null is "unset" in a single file too: a command-only service
    // with a null image audits its command instead of failing the
    // literal-image check.
    const single = parseComposeTargets(
      "services:\n  tool:\n    image: null\n    command: " +
        '[deno, run, "--allow-env=FOO", /app/tool.ts]\n',
      "compose.yml",
    );
    assertEquals(single.length, 1);
    assertEquals([...single[0].allowEnv], ["FOO"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("tagged anchored Compose nodes fail closed", () => {
  assertThrows(
    () =>
      parseComposeStackTargets([
        {
          content: "services:\n  tool:\n    build:\n      context: .\n" +
            "      dockerfile: Dockerfile.safe\n",
          source: "base.yml",
        },
        {
          content: "services:\n  tool:\n    ports: !override &replacement\n" +
            "      context: .\n    build: *replacement\n",
          source: "override.yml",
        },
      ]),
    Error,
    "carries a YAML anchor",
  );
  // Anchor-before-tag is already rejected as an unrecognised position.
  assertThrows(
    () =>
      parseComposeTargets(
        "services:\n  tool:\n    ports: &replacement !override null\n",
        "compose.yml",
      ),
    Error,
    "Compose merge tag on an unrecognised position cannot be audited",
  );
  // Plain untagged anchor reuse remains auditable.
  const target = onlyTarget(`
x-launcher: &launcher [deno, run, "--allow-env=FOO", /app/tool.ts]
services:
  tool:
    entrypoint: *launcher
`);
  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose merge tags on reviewed non-launcher fields stay auditable", () => {
  const target = onlyTarget(`
services:
  tool:
    # comments may mention the tag, like pattern-b's ports: !reset
    ports: !reset null
    depends_on: !reset null
    deploy:
      resources:
        reservations:
          devices: !reset []
    entrypoint: [deno, run, "--allow-env=FOO", /app/tool.ts]
`);
  assertEquals(target.entrypoint, "tool.ts");
  assertEquals([...target.allowEnv], ["FOO"]);
});

Deno.test("Compose builds fail closed on unresolved launcher defaults", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/Dockerfile`,
      "FROM denoland/deno:2.9.4\n",
    );
    assertThrows(
      () =>
        parseComposeTargets(
          `services:\n  tool:\n    build: .\n`,
          `${directory}/compose.yml`,
        ),
      Error,
      "built image launcher defaults inherited from denoland/deno:2.9.4 cannot be resolved",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Compose build defaults come only from the final Docker stage", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/Dockerfile`,
      `FROM denoland/deno:2.9.4 AS builder
ENTRYPOINT ["deno", "run", "--allow-env=EARLIER_STAGE"]
CMD ["earlier.ts"]
FROM caddy:2.11.3-alpine
`,
    );
    assertEquals(
      parseComposeTargets(
        `services:\n  perimeter:\n    build: .\n`,
        `${directory}/compose.yml`,
      ),
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
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

Deno.test("unknown single-letter Deno options fail closed", () => {
  for (
    const launcher of [
      "[deno, -Z, value, run, --allow-env=SAFE, /app/tool.ts]",
      "[deno, run, -Z, /app/config.ts, -A, /app/tool.ts]",
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
      "unknown argument boundaries",
    );
  }
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
  for (const option of ["-c", "--config"]) {
    const target = onlyTarget(`
services:
  tool:
    entrypoint:
      - deno
      - run
      - ${option}
      - /app/config.ts
      - --allow-env=FOO
      - /app/tool.ts
`);

    assertEquals(target.entrypoint, "tool.ts");
    assertEquals([...target.allowEnv], ["FOO"]);
  }
});

Deno.test("combined Deno short options fail closed before operands", () => {
  for (const cluster of ["-qc", "-qL"]) {
    assertThrows(
      () =>
        onlyTarget(`
services:
  unsafe-tool:
    entrypoint: [deno, run, ${cluster}, /app/config.ts, -A, /app/tool.ts]
`),
      Error,
      "combined short options cannot be audited",
    );
  }
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

Deno.test("external Compose inheritance mechanisms fail closed", () => {
  for (
    const content of [
      `include: [other.yml]\nservices: {}\n`,
      `services:\n  tool:\n    extends:\n      file: other.yml\n      service: tool\n`,
    ]
  ) {
    assertThrows(
      () => parseComposeTargets(content, "compose.yml"),
      Error,
      "cannot be audited",
    );
  }
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

Deno.test("Node process environment access fails closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      `import process from "node:process";
export const value = process.env.PROCESS_ENV_ONLY;
`,
    );

    assertThrows(
      () =>
        analyzeTarget(
          {
            source: "compose.yml#tool",
            entrypoint: "main.ts",
            allowEnv: new Set(["SAFE"]),
            configPath: null,
          },
          directory,
        ),
      Error,
      "node:process environment API cannot be audited",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("global and aliased Node process bindings fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const sources = [
      "export const value = process.env.GLOBAL_PROCESS_ENV;\n",
      "export const value = globalThis.process.env.GLOBAL_PROCESS_ENV;\n",
      `import { env as nodeEnv } from "node:process";
export const value = nodeEnv.ALIASED_PROCESS_ENV;
`,
    ];
    for (const [index, content] of sources.entries()) {
      const path = `${directory}/process_${index}.ts`;
      await Deno.writeTextFile(path, content);
      assertThrows(
        () => findEnvReads(path),
        Error,
        "node:process environment API cannot be audited",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("binding positions named process or Deno stay auditable", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/mod.ts`;
    await Deno.writeTextFile(
      path,
      `export const helper = (value: string, process: number): number =>
  value.length;
export class Queue {
  process = 0;
  accessor Deno = "runtime";
  drain(process: number): void {}
}
export const worker = {
  process(input: string): string {
    return input.trim();
  },
};
export const key = Deno.env.get("PROCESS_PARAM_CONTROL");
`,
    );
    assertEquals([...findEnvReads(path)], ["PROCESS_PARAM_CONTROL"]);
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

Deno.test("relative TSX imports stay in the audited graph", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${directory}/main.ts`,
      'import "./view.tsx?component";\n',
    );
    await Deno.writeTextFile(
      `${directory}/view.tsx`,
      'export const view = <div>{Deno.env.get("TSX_ENV")}</div>;\n',
    );

    const analysis = analyzeTarget(
      {
        source: "compose.yml#tool",
        entrypoint: "main.ts",
        allowEnv: new Set(),
      },
      directory,
    );

    assertEquals([...analysis.files].sort(), ["main.ts", "view.tsx"]);
    assertEquals(analysis.missing, ["TSX_ENV"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("unsupported Deno import maps fail closed before source analysis", async () => {
  for (
    const variant of [
      {
        name: "explicit import map",
        configName: "import_map.json",
        globalOptions: [],
        runOptions: ["--import-map=/app/import_map.json"],
        expectedError: "custom Deno import maps cannot be audited",
      },
      {
        name: "explicit global config",
        configName: "deno.json",
        globalOptions: ["-c", "/app/deno.json"],
        runOptions: [],
        expectedError:
          "Deno config imports differ from the checked-in audited policy",
      },
      {
        name: "auto-discovered config",
        configName: "deno.json",
        globalOptions: [],
        runOptions: [],
        expectedError:
          "Deno config imports differ from the checked-in audited policy",
      },
    ]
  ) {
    const directory = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        `${directory}/main.ts`,
        'import "./selected.ts";\n',
      );
      await Deno.writeTextFile(
        `${directory}/selected.ts`,
        'export const selected = "not executed";\n',
      );
      await Deno.writeTextFile(
        `${directory}/actual.ts`,
        'export const actual = Deno.env.get("IMPORT_MAP_ONLY");\n',
      );
      await Deno.writeTextFile(
        `${directory}/${variant.configName}`,
        JSON.stringify({ imports: { "./selected.ts": "./actual.ts" } }),
      );

      const globalOptions = variant.globalOptions.length > 0
        ? `${variant.globalOptions.join(", ")}, `
        : "";
      const runOptions = variant.runOptions.length > 0
        ? `${variant.runOptions.join(", ")}, `
        : "";
      const target = onlyTarget(`
services:
  tool:
    entrypoint: [deno, ${globalOptions}run, ${runOptions}--allow-env=SAFE, /app/main.ts]
`);
      assertThrows(
        () => analyzeTarget(target, directory),
        Error,
        variant.expectedError,
        variant.name,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
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

Deno.test("Docker shell-form launchers fail closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/Dockerfile`;
    await Deno.writeTextFile(
      path,
      `FROM denoland/deno:2.9.4
ENTRYPOINT []
CMD deno run --allow-env=SAFE tool.ts
`,
    );
    assertThrows(
      () => parseDockerfile(path),
      Error,
      "shell-form CMD cannot be audited",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Dockerfile parsing rejects env argument expansion", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/Dockerfile`;
    await Deno.writeTextFile(
      path,
      `FROM denoland/deno:2.9.4
CMD ["env", "-u", "deno", "--split-string=deno run -A /app/evil.ts", "run", "--allow-env=SAFE", "/app/safe.ts"]
`,
    );
    assertThrows(
      () => parseDockerfile(path),
      Error,
      "env -S/--split-string launchers cannot be audited",
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

Deno.test("Docker shell entrypoints model sh -c argv0 consumption", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/Dockerfile`;
    await Deno.writeTextFile(
      path,
      `FROM denoland/deno:2.9.4
ENTRYPOINT ["sh", "-c", "exec deno run --no-config --allow-env=SAFE \\"$@\\""]
CMD ["safe.ts", "actual.ts"]
`,
    );
    await Deno.writeTextFile(
      `${directory}/actual.ts`,
      'export const value = Deno.env.get("SHELL_POSITIONAL_ONLY");\n',
    );

    const target = parseDockerfile(path);
    assertEquals(target.entrypoint, "actual.ts");
    assertEquals(
      analyzeTarget({ source: path, ...target }, directory).missing,
      [
        "SHELL_POSITIONAL_ONLY",
      ],
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
  assertEquals(analysis.files.has("postgres_deferred_patched.ts"), true);
});
