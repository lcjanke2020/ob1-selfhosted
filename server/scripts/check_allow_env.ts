// Static check that every env var read at runtime is declared in the bounded
// --allow-env= list of each checked-in Deno launcher.
//
// Why this exists: `deno task test` runs with unrestricted --allow-env, so
// per-PR tests don't notice when a new Deno.env.get("NEW_KEY") is added
// without the matching launcher update. The production process then boots and
// crashes with `NotCapable: Requires env access to "NEW_KEY"`.
//
// Algorithm:
//   1. Parse the mcp + ingester Dockerfiles and every Compose service whose
//      explicit `entrypoint` and/or `command` invokes `deno run`.
//   2. Reject unrestricted grants, dynamic/multi-Deno Compose launchers, and
//      executable Deno subcommands outside the supported `run` model.
//   3. Parse each reachable TypeScript module into an AST, walk its relative
//      import graph, and fail closed on non-literal dynamic imports.
//   4. Find string-literal env reads in the AST, fail closed on aliases and
//      dynamic keys that cannot be proved safe, add explicit out-of-tree
//      dependency reads, and fail if any required key is absent from the
//      launcher's allowlist.
//
// Over-permissive entries are generally not flagged. The deno-postgres driver
// reads seven PG* keys outside this source tree, so any reachable import of the
// pinned driver adds that explicit dependency policy.
//
// Run locally: `deno task check-allow-env` (from server/).
// CI: runs as the check-allow-env job in .github/workflows/ci.yml.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
// These AST-only dependencies live in scripts/deno.{json,lock}; the root lock
// is copied into production images and deliberately excludes CI tooling.
import { parse as parseTypeScriptModule } from "@babel/parser";
import type * as t from "@babel/types";

const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));
const REPO_DIR = resolve(SERVER_DIR, "..");
const DEPLOY_DIR = join(REPO_DIR, "deploy");

// deno-postgres@v0.19.3's getPgEnv() reads exactly these seven keys at Pool
// construction, even when callers pass explicit connection options.
export const DENO_POSTGRES_ALLOW_ENV = [
  "PGAPPNAME",
  "PGDATABASE",
  "PGHOST",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGPORT",
  "PGUSER",
] as const;

// The five DB_* keys are source-visible through token_admin.ts's env() helper;
// the seven PG* keys are the driver's out-of-tree reads above.
export const TOKEN_ADMIN_ALLOW_ENV = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  ...DENO_POSTGRES_ALLOW_ENV,
] as const;

// Each wrapper takes the env-var name as its first argument. Keep this list in
// sync with source-local helpers; dynamic dependency reads belong in a launcher
// policy such as TOKEN_ADMIN_ALLOW_ENV above.
const WRAPPER_NAMES = [
  "required",
  "requiredInt",
  "optionalTrimmed",
  "optional",
  "optionalInt",
  "env",
];

export interface CheckTarget {
  source: string;
  entrypoint: string;
  allowEnv: Set<string>;
  requiredEnv?: Set<string>;
}

export interface TargetAnalysis {
  files: Set<string>;
  reads: Set<string>;
  required: Set<string>;
  missing: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAllowEnv(value: string, source: string): Set<string> {
  if (value.length === 0) {
    throw new Error(
      `${source}: empty --allow-env= list; specify at least one key`,
    );
  }
  const keys = value.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    throw new Error(`${source}: invalid --allow-env list: ${value}`);
  }
  return new Set(keys);
}

export function parseDockerfile(dockerfilePath: string): {
  entrypoint: string;
  allowEnv: Set<string>;
} {
  const content = Deno.readTextFileSync(dockerfilePath);
  const entrypointArgs = dockerInstructionArguments(
    content,
    "ENTRYPOINT",
    dockerfilePath,
  ) ?? [];
  const commandArgs = dockerInstructionArguments(
    content,
    "CMD",
    dockerfilePath,
  );
  if (!commandArgs) throw new Error(`No CMD line in ${dockerfilePath}`);
  const target = parseDenoRunTarget(
    effectiveDockerArguments(entrypointArgs, commandArgs, dockerfilePath),
    dockerfilePath,
  );
  if (!target) throw new Error(`No deno run launcher in ${dockerfilePath}`);
  return {
    entrypoint: target.entrypoint,
    allowEnv: target.allowEnv,
  };
}

function dockerInstructionArguments(
  content: string,
  instruction: "CMD" | "ENTRYPOINT",
  source: string,
): string[] | undefined {
  const matches = [...content.matchAll(
    new RegExp(`^${instruction}\\s+(.+)$`, "gm"),
  )];
  const raw = matches.at(-1)?.[1].trim();
  if (!raw) return undefined;
  if (!raw.startsWith("[")) return splitCommand(raw, source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source}: invalid JSON ${instruction}: ${(error as Error).message}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((argument) => typeof argument === "string")
  ) {
    throw new Error(`${source}: ${instruction} must be a string list`);
  }
  return parsed;
}

function effectiveDockerArguments(
  entrypointArgs: string[],
  commandArgs: string[],
  source: string,
): string[] {
  const shell = entrypointArgs[0]?.replaceAll("\\", "/").split("/").at(-1);
  if (
    (shell === "sh" || shell === "bash") &&
    entrypointArgs[1] === "-c" &&
    entrypointArgs[2] !== undefined
  ) {
    // With an exec-form `sh -c` entrypoint, the next entrypoint argument is
    // $0 and Docker's CMD arguments become $1... / "$@". Expand only that
    // exact shell token; the rest of the script remains literal launcher data.
    return splitCommand(entrypointArgs[2], source).flatMap((argument) =>
      argument === "$@" ? commandArgs : [argument]
    );
  }
  return [...entrypointArgs, ...commandArgs];
}

function splitCommand(value: string, source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote !== "'" && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (!quote) quote = character;
      else current += character;
      continue;
    }
    if (quote !== "'" && character === "`") {
      throw new Error(
        `${source}: shell command substitution cannot be audited; ` +
          "use literal arguments",
      );
    }
    if (quote !== "'" && character === "$" && value[index + 1] === "(") {
      throw new Error(
        `${source}: shell command substitution cannot be audited; ` +
          "use literal arguments",
      );
    }
    if (!quote && ";&|<>()".includes(character)) {
      if (current) tokens.push(current);
      tokens.push(character);
      current = "";
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped || quote) {
    throw new Error(`${source}: unterminated escape or quote in entrypoint`);
  }
  if (current) tokens.push(current);
  return tokens;
}

function literalArguments(
  value: unknown,
  source: string,
  field: "entrypoint" | "command",
): string[] {
  let args: string[];
  if (typeof value === "string") {
    args = splitCommand(value, source);
  } else if (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  ) {
    args = value;
  } else {
    throw new Error(
      `${source}: ${field} must be a literal string or string list`,
    );
  }
  if (
    args.some((argument) => argument.includes("`") || argument.includes("$("))
  ) {
    throw new Error(
      `${source}: shell command substitution cannot be audited; ` +
        "use literal arguments",
    );
  }
  if (args.some((argument) => argument.includes("$"))) {
    throw new Error(
      `${source}: interpolated ${field} cannot be audited; use literal arguments`,
    );
  }
  return args;
}

interface DenoInvocation {
  globalOptions: string[];
  runArguments: string[];
}

const RUN_OPTIONS_WITH_VALUES = new Set([
  "--cert",
  "--conditions",
  "-c",
  "--config",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--ext",
  "--import-map",
  "--location",
  "-L",
  "--log-level",
  "--minimum-dependency-age",
  "--seed",
]);

// Deno exposes the run flags as root/global flags too. This set deliberately
// includes every auditable required-value run option; an unrecognised bare
// global option fails closed below instead of letting its operand masquerade
// as a non-Deno subcommand.
const GLOBAL_OPTIONS_WITH_VALUES = new Set(RUN_OPTIONS_WITH_VALUES);

const RUN_STANDALONE_OPTIONS = new Set([
  "--allow-all",
  "--cached-only",
  "--check",
  "--coverage",
  "--cpu-prof",
  "--cpu-prof-flamegraph",
  "--cpu-prof-md",
  "--env-file",
  "--frozen",
  "-h",
  "--help",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--no-check",
  "--no-clear-screen",
  "--no-code-cache",
  "--no-config",
  "--no-lock",
  "--no-npm",
  "--no-prompt",
  "--no-remote",
  "--node-modules-dir",
  "-q",
  "--quiet",
  "-r",
  "--reload",
  "-t",
  "--tunnel",
  "--unstable",
  "--use-env-proxy",
  "--v8-flags",
  "--vendor",
  "--watch",
  "--watch-exclude",
  "--watch-hmr",
]);

const UNAUDITABLE_CODE_OPTIONS = new Set([
  "--allow-scripts",
  "--preload",
  "--require",
]);

function optionName(argument: string): string {
  return argument.split("=", 1)[0];
}

function isDenoExecutable(value: string): boolean {
  return !value.includes("=") && /(^|[\\/])deno(?:\.exe)?$/i.test(value);
}

function isShellExecutable(value: string): boolean {
  if (value.includes("=")) return false;
  const name = (value.replaceAll("\\", "/").split("/").at(-1) ?? "")
    .toLowerCase();
  return /^(?:(?:ba|da|a|k|z)?sh)(?:\.exe)?$/.test(name) ||
    [
      "cmd",
      "cmd.exe",
      "fish",
      "nu",
      "powershell",
      "powershell.exe",
      "pwsh",
      "pwsh.exe",
    ]
      .includes(name);
}

function containsDenoExecutableText(value: string): boolean {
  return /(^|[\\/\s;&|<>()`])deno(?:\.exe)?(?=$|[\s;&|<>()`])/i.test(
    value,
  );
}

function optionHasKnownBoundaries(
  argument: string,
  standaloneOptions: ReadonlySet<string>,
): boolean {
  const name = optionName(argument);
  return argument.includes("=") ||
    standaloneOptions.has(name) ||
    /^--(?:allow|deny|ignore)-(?:env|ffi|import|net|read|run|sys|write)$/
      .test(name) ||
    /^-[A-Za-z]{1,}$/.test(name);
}

function invocationFromArguments(
  args: string[],
  source: string,
): DenoInvocation | undefined {
  const denoIndex = args.findIndex(isDenoExecutable);
  if (denoIndex < 0) return undefined;

  const globalOptions: string[] = [];
  for (let index = denoIndex + 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "run") {
      return { globalOptions, runArguments: args.slice(index + 1) };
    }
    if (!argument.startsWith("-")) {
      if (/\.tsx?(?:[?#].*)?$/.test(argument)) {
        throw new Error(
          `${source}: implicit Deno execution cannot be audited; ` +
            "spell the launcher as deno run ...",
        );
      }
      throw new Error(
        `${source}: deno ${argument} is not an auditable launcher; ` +
          "use one explicit deno run ... command",
      );
    }

    rejectUnauditableOption(argument, source);
    globalOptions.push(argument);
    const name = optionName(argument);
    if (GLOBAL_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
      if (index + 1 >= args.length) {
        throw new Error(`${source}: ${name} is missing its value`);
      }
      index++;
      continue;
    }
    if (!optionHasKnownBoundaries(argument, RUN_STANDALONE_OPTIONS)) {
      throw new Error(
        `${source}: global ${argument} has unknown argument boundaries; ` +
          "use a self-contained --option=value form",
      );
    }
  }

  throw new Error(
    `${source}: Deno launcher has no explicit run subcommand`,
  );
}

function denoInvocation(
  args: string[],
  source: string,
): DenoInvocation | undefined {
  const directCount = args.filter(isDenoExecutable).length;
  if (directCount > 1) {
    throw new Error(
      `${source}: multiple Deno invocations cannot be audited; ` +
        "use one launcher per service",
    );
  }
  return directCount === 1 ? invocationFromArguments(args, source) : undefined;
}

function rejectUnauditableOption(argument: string, source: string): void {
  const name = optionName(argument);
  if (
    name === "--permission-set" ||
    (argument.startsWith("-") && !argument.startsWith("--") &&
      name.slice(1).includes("P"))
  ) {
    throw new Error(
      `${source}: -P/--permission-set can grant unaudited environment access; ` +
        "use explicit --allow-env=KEY,... permissions",
    );
  }
  if (UNAUDITABLE_CODE_OPTIONS.has(name)) {
    throw new Error(
      `${source}: ${name} executes code outside the audited main-module graph`,
    );
  }
}

function parseRunArguments(
  args: string[],
  source: string,
): { options: string[]; script: string } {
  const options: string[] = [];
  let script: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      script = args[index + 1];
      break;
    }
    if (!argument.startsWith("-") || argument === "-") {
      script = argument;
      break;
    }

    rejectUnauditableOption(argument, source);
    options.push(argument);
    const name = optionName(argument);
    if (RUN_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
      if (index + 1 >= args.length) {
        throw new Error(`${source}: ${name} is missing its value`);
      }
      index++;
      continue;
    }
    if (
      !optionHasKnownBoundaries(argument, RUN_STANDALONE_OPTIONS)
    ) {
      throw new Error(
        `${source}: ${argument} has unknown argument boundaries; ` +
          "use a self-contained --option=value form",
      );
    }
  }

  if (!script || !/\.tsx?(?:[?#].*)?$/.test(script)) {
    throw new Error(`${source}: deno run launcher has no .ts module`);
  }
  return { options, script };
}

function collectAllowEnv(
  options: Iterable<string>,
  source: string,
): Set<string> {
  const allowEnv = new Set<string>();
  for (const argument of options) {
    rejectUnauditableOption(argument, source);
    if (argument === "--allow-all" || argument.startsWith("--allow-all=")) {
      throw new Error(
        `${source}: -A/--allow-all grants every permission; ` +
          "use bounded --allow-* flags",
      );
    }
    if (argument === "--allow-env" || argument === "-E") {
      throw new Error(
        `${source}: bare -E/--allow-env grants the entire environment; ` +
          "use --allow-env=KEY,...",
      );
    }
    if (argument.startsWith("--allow-env=")) {
      for (
        const key of parseAllowEnv(
          argument.slice("--allow-env=".length),
          source,
        )
      ) allowEnv.add(key);
      continue;
    }
    if (argument.startsWith("-") && !argument.startsWith("--")) {
      const [shortFlags, value] = argument.split("=", 2);
      const flags = shortFlags.slice(1);
      if (flags.includes("A")) {
        throw new Error(
          `${source}: -A/--allow-all grants every permission; ` +
            "use bounded --allow-* flags",
        );
      }
      if (!flags.includes("E")) continue;
      if (shortFlags !== "-E" || value === undefined) {
        throw new Error(
          `${source}: combined or unbounded -E cannot be audited; ` +
            "use --allow-env=KEY,...",
        );
      }
      for (const key of parseAllowEnv(value, source)) allowEnv.add(key);
    }
  }
  return allowEnv;
}

function parseDenoRunTarget(
  args: string[],
  source: string,
): Pick<CheckTarget, "entrypoint" | "allowEnv"> | undefined {
  const invocation = denoInvocation(args, source);
  if (!invocation) return undefined;
  const parsed = parseRunArguments(invocation.runArguments, source);
  const allowEnv = collectAllowEnv(
    [...invocation.globalOptions, ...parsed.options],
    source,
  );

  return {
    entrypoint: normalizeComposeEntrypoint(parsed.script, source),
    allowEnv,
  };
}

function normalizeComposeEntrypoint(value: string, source: string): string {
  const portable = value.replace(/[?#].*$/, "").replaceAll("\\", "/");
  const candidate = portable.startsWith("/app/")
    ? portable.slice("/app/".length)
    : portable.replace(/^\.\//, "");
  const normalized = relative(SERVER_DIR, resolve(SERVER_DIR, candidate))
    .replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `${source}: TypeScript entrypoint must resolve inside /app: ${value}`,
    );
  }
  return normalized;
}

function composeDocument(content: string, source: string): UnknownRecord {
  // Compose's !reset / !override tags are merge directives rather than data
  // types. Removing only the tag token preserves the value that std/yaml then
  // validates; any other unknown YAML tag still fails closed.
  const standardYaml = content.replace(
    /(^|[\s:[{,])!(?:reset|override)(?=\s)/gm,
    "$1",
  );
  let document: unknown;
  try {
    document = parseYaml(standardYaml);
  } catch (error) {
    throw new Error(
      `${source}: invalid Compose YAML: ${(error as Error).message}`,
    );
  }
  if (!isRecord(document)) {
    throw new Error(`${source}: Compose document must be a mapping`);
  }
  return document;
}

export function parseComposeTargets(
  content: string,
  source: string,
): CheckTarget[] {
  const document = composeDocument(content, source);
  if (document.services === undefined) return [];
  if (!isRecord(document.services)) {
    throw new Error(`${source}: services must be a mapping`);
  }

  const targets: CheckTarget[] = [];
  for (const [serviceName, rawService] of Object.entries(document.services)) {
    const label = `${source}#${serviceName}`;
    if (rawService === null) continue;
    if (!isRecord(rawService)) {
      throw new Error(`${label}: service definition must be a mapping`);
    }
    const entrypointArgs = rawService.entrypoint === undefined ||
        rawService.entrypoint === null
      ? []
      : literalArguments(rawService.entrypoint, label, "entrypoint");
    const commandArgs = rawService.command === undefined ||
        rawService.command === null
      ? []
      : literalArguments(rawService.command, label, "command");
    if (entrypointArgs.length === 0 && commandArgs.length === 0) continue;
    const launcherArgs = [...entrypointArgs, ...commandArgs];
    const shellIndex = launcherArgs.findIndex(isShellExecutable);
    if (
      shellIndex >= 0 &&
      launcherArgs.slice(shellIndex + 1).some(containsDenoExecutableText)
    ) {
      throw new Error(
        `${label}: shell-wrapped Deno launchers cannot be audited; ` +
          "use a literal Deno argv list",
      );
    }
    const parsed = parseDenoRunTarget(launcherArgs, label);
    if (!parsed) continue;
    targets.push({
      source: label,
      ...parsed,
    });
  }
  return targets;
}

function composeFiles(directory: string): string[] {
  const matches: string[] = [];
  for (const entry of Deno.readDirSync(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) matches.push(...composeFiles(path));
    else if (
      entry.isFile &&
      /^(?:docker-)?compose(?:[.-].*)?\.ya?ml$/i.test(entry.name)
    ) {
      matches.push(path);
    }
  }
  return matches.sort();
}

function parseTypeScript(content: string, source: string): t.File {
  try {
    return parseTypeScriptModule(content, {
      sourceType: "module",
      sourceFilename: source,
      createImportExpressions: true,
      plugins: source.toLowerCase().endsWith(".tsx")
        ? ["typescript", "jsx"]
        : ["typescript"],
    });
  } catch (error) {
    const syntaxError = error as SyntaxError & {
      loc?: { line: number; column: number };
    };
    const location = syntaxError.loc
      ? `:${syntaxError.loc.line}:${syntaxError.loc.column + 1}`
      : "";
    throw new Error(
      `${source}${location}: TypeScript syntax cannot be audited: ${syntaxError.message}`,
    );
  }
}

function staticStringValue(
  node: t.Node | null | undefined,
): string | undefined {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function isAstNode(value: unknown): value is t.Node {
  return typeof value === "object" && value !== null &&
    "type" in value && typeof value.type === "string";
}

function walkAst(
  node: t.Node,
  visitor: (node: t.Node, ancestors: readonly t.Node[]) => void,
  ancestors: t.Node[] = [],
): void {
  visitor(node, ancestors);
  ancestors.push(node);
  try {
    for (const [key, value] of Object.entries(node)) {
      if (["comments", "errors", "extra", "loc", "tokens"].includes(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) walkAst(child, visitor, ancestors);
        }
      } else if (isAstNode(value)) {
        walkAst(value, visitor, ancestors);
      }
    }
  } finally {
    ancestors.pop();
  }
}

function importSpecifiers(content: string, source: string): Set<string> {
  const sourceFile = parseTypeScript(content, source);
  const specifiers = new Set<string>();

  const addSpecifier = (
    node: t.Node | null | undefined,
    description: string,
  ): void => {
    const value = staticStringValue(node);
    if (value === undefined) {
      throw new Error(
        `${source}: ${description} must use a string or static template literal; ` +
          "dynamic imports cannot be audited",
      );
    }
    specifiers.add(value);
  };

  walkAst(sourceFile, (node) => {
    if (node.type === "ImportDeclaration") {
      addSpecifier(node.source, "import specifier");
    } else if (
      (node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") && node.source
    ) {
      addSpecifier(node.source, "export specifier");
    } else if (node.type === "ImportExpression") {
      addSpecifier(node.source, "dynamic import specifier");
    } else if (node.type === "TSImportType") {
      addSpecifier(node.argument, "import type specifier");
    } else if (
      node.type === "CallExpression" && node.callee.type === "Import"
    ) {
      addSpecifier(node.arguments[0], "dynamic import specifier");
    }
  });
  return specifiers;
}

function dependencyEnvForFiles(
  files: Iterable<string>,
  baseDir: string,
): Set<string> {
  for (const file of files) {
    const path = join(baseDir, file);
    const specifiers = importSpecifiers(Deno.readTextFileSync(path), path);
    if (
      specifiers.has("postgres") ||
      [...specifiers].some((specifier) =>
        specifier.startsWith("https://deno.land/x/postgres@v0.19.3/")
      )
    ) {
      return new Set(DENO_POSTGRES_ALLOW_ENV);
    }
  }
  return new Set();
}

export function dependencyEnvForEntrypoint(
  entrypoint: string,
  baseDir = SERVER_DIR,
): Set<string> {
  return dependencyEnvForFiles(walkImports(entrypoint, baseDir), baseDir);
}

export function walkImports(entrypoint: string, baseDir: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [entrypoint];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const full = join(baseDir, file);
    let content: string;
    try {
      content = Deno.readTextFileSync(full);
    } catch (error) {
      throw new Error(
        `Failed to read ${full}: ${(error as Error).message}`,
      );
    }
    for (const specifier of importSpecifiers(content, full)) {
      if (!specifier.startsWith(".")) continue;
      const withExtension = specifier.endsWith(".ts")
        ? specifier
        : `${specifier}.ts`;
      const importerDir = dirname(file);
      const target = relative(
        baseDir,
        resolve(join(baseDir, importerDir), withExtension),
      ).replaceAll("\\", "/");
      queue.push(target);
    }
  }
  return visited;
}

const WRAPPER_NAME_SET = new Set(WRAPPER_NAMES);

type MemberExpression = t.MemberExpression | t.OptionalMemberExpression;
type CallExpression = t.CallExpression | t.OptionalCallExpression;

function isMemberExpression(
  node: t.Node | null | undefined,
): node is MemberExpression {
  return node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression";
}

function isCallExpression(
  node: t.Node | null | undefined,
): node is CallExpression {
  return node?.type === "CallExpression" ||
    node?.type === "OptionalCallExpression";
}

function memberName(node: MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return staticStringValue(node.property);
}

function isDirectDenoEnvAccess(node: t.Node): node is MemberExpression {
  return isMemberExpression(node) && !node.computed &&
    memberName(node) === "env" && node.object.type === "Identifier" &&
    node.object.name === "Deno";
}

function isDirectDenoEnvGetCall(node: t.Node): node is CallExpression {
  return isCallExpression(node) && isMemberExpression(node.callee) &&
    !node.callee.computed && memberName(node.callee) === "get" &&
    isDirectDenoEnvAccess(node.callee.object);
}

function isInsideKnownWrapper(ancestors: readonly t.Node[]): boolean {
  const fn = ancestors.findLast((node) =>
    [
      "ArrowFunctionExpression",
      "ClassMethod",
      "ClassPrivateMethod",
      "FunctionDeclaration",
      "FunctionExpression",
      "ObjectMethod",
    ].includes(node.type)
  );
  return fn?.type === "FunctionDeclaration" && !!fn.id &&
    WRAPPER_NAME_SET.has(fn.id.name);
}

function literalEnvKey(
  node: t.Node | null | undefined,
  description: string,
): string {
  const key = staticStringValue(node);
  if (key === undefined) {
    throw new Error(
      `${description} must receive a string-literal env key; ` +
        "dynamic env reads cannot be audited",
    );
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`${description} has an invalid env key: ${key}`);
  }
  return key;
}

function isAuditedEnvAccess(
  node: MemberExpression,
  ancestors: readonly t.Node[],
): boolean {
  const getter = ancestors.at(-1);
  const call = ancestors.at(-2);
  return isMemberExpression(getter) && getter.object === node &&
    !getter.computed && memberName(getter) === "get" &&
    isCallExpression(call) && call.callee === getter;
}

function isNonValueIdentifier(node: t.Identifier, parent: t.Node): boolean {
  if (
    parent.type.startsWith("TS") &&
    ![
      "TSAsExpression",
      "TSInstantiationExpression",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
    ].includes(parent.type)
  ) return true;
  const isFunctionBinding = (parent.type === "FunctionDeclaration" ||
    parent.type === "FunctionExpression") &&
    (parent.id === node || parent.params.includes(node));
  const isClassName = (parent.type === "ClassDeclaration" ||
    parent.type === "ClassExpression") && parent.id === node;
  if (
    parent.type === "VariableDeclarator" && parent.id === node ||
    isFunctionBinding || isClassName
  ) return true;
  if (
    parent.type === "ObjectProperty" && parent.key === node &&
    !parent.computed && !parent.shorthand
  ) return true;
  return [
    "ImportDefaultSpecifier",
    "ImportNamespaceSpecifier",
    "ImportSpecifier",
    "LabeledStatement",
  ].includes(parent.type);
}

export function findEnvReads(filePath: string): Set<string> {
  const sourceFile = parseTypeScript(Deno.readTextFileSync(filePath), filePath);
  const reads = new Set<string>();

  walkAst(sourceFile, (node, ancestors) => {
    if (isDirectDenoEnvGetCall(node)) {
      try {
        reads.add(
          literalEnvKey(node.arguments[0], `${filePath}: Deno.env.get()`),
        );
      } catch (error) {
        // Source-local wrappers intentionally receive the name dynamically and
        // are covered at their call sites below. Any other dynamic direct read
        // fails closed rather than disappearing from launcher requirements.
        if (
          !(error as Error).message.includes("dynamic env reads") ||
          !isInsideKnownWrapper(ancestors)
        ) throw error;
      }
    }
    if (
      isCallExpression(node) && node.callee.type === "Identifier" &&
      WRAPPER_NAME_SET.has(node.callee.name)
    ) {
      reads.add(
        literalEnvKey(
          node.arguments[0],
          `${filePath}: ${node.callee.name}()`,
        ),
      );
    }

    if (
      isDirectDenoEnvAccess(node) && !isAuditedEnvAccess(node, ancestors)
    ) {
      throw new Error(
        `${filePath}: unmodelled Deno.env access cannot be audited; ` +
          'use Deno.env.get("LITERAL_KEY")',
      );
    }
    if (
      isMemberExpression(node) && node.computed &&
      node.object.type === "Identifier" && node.object.name === "Deno"
    ) {
      throw new Error(
        `${filePath}: unmodelled computed Deno property access cannot be audited; ` +
          "use a direct Deno property",
      );
    }
    if (
      isMemberExpression(node) && memberName(node) === "Deno" &&
      node.object.type === "Identifier" &&
      ["globalThis", "self", "window"].includes(node.object.name)
    ) {
      throw new Error(
        `${filePath}: unmodelled Deno global access cannot be audited; ` +
          "use direct Deno properties",
      );
    }
    if (node.type === "Identifier" && node.name === "Deno") {
      const parent = ancestors.at(-1);
      const isDirectProperty = isMemberExpression(parent) &&
        parent.object === node;
      const isTypeof = parent?.type === "UnaryExpression" &&
        parent.operator === "typeof";
      if (
        parent && !isDirectProperty && !isTypeof &&
        !isNonValueIdentifier(node, parent)
      ) {
        throw new Error(
          `${filePath}: unmodelled Deno binding cannot be audited; ` +
            "use direct Deno properties",
        );
      }
    }
  });
  return reads;
}

export function analyzeTarget(
  target: CheckTarget,
  baseDir = SERVER_DIR,
): TargetAnalysis {
  const files = walkImports(target.entrypoint, baseDir);
  const reads = new Set<string>();
  for (const file of files) {
    for (const key of findEnvReads(join(baseDir, file))) reads.add(key);
  }
  const required = new Set(reads);
  for (const key of dependencyEnvForFiles(files, baseDir)) required.add(key);
  for (const key of target.requiredEnv ?? []) required.add(key);
  const missing = [...required].filter((key) => !target.allowEnv.has(key))
    .sort();
  return { files, reads, required, missing };
}

export function repositoryTargets(): CheckTarget[] {
  // Deliberate Dockerfile inventory: add every server image whose effective
  // launcher is `deno run`; Compose discovery below is recursive and dynamic.
  const targets: CheckTarget[] = [
    {
      source: "server/Dockerfile",
      ...parseDockerfile(join(SERVER_DIR, "Dockerfile")),
    },
    {
      source: "server/Dockerfile.ingester",
      ...parseDockerfile(join(SERVER_DIR, "Dockerfile.ingester")),
    },
  ];
  for (const path of composeFiles(DEPLOY_DIR)) {
    const source = relative(REPO_DIR, path).replaceAll("\\", "/");
    targets.push(...parseComposeTargets(Deno.readTextFileSync(path), source));
  }
  return targets;
}

export function reportTargets(targets: CheckTarget[]): boolean {
  let drift = false;
  for (const target of targets) {
    const analysis = analyzeTarget(target);
    if (analysis.missing.length > 0) {
      drift = true;
      console.error(
        `✗ ${target.source}: --allow-env missing keys required by ${target.entrypoint}:`,
      );
      for (const key of analysis.missing) console.error(`    ${key}`);
      console.error(
        `  (${analysis.reads.size} static reads in ${analysis.files.size} reachable files; ` +
          `${analysis.required.size} total required; ` +
          `${target.allowEnv.size} keys declared in --allow-env)`,
      );
    } else {
      console.log(
        `✓ ${target.source}: --allow-env covers all ${analysis.required.size} required keys ` +
          `in ${analysis.files.size} reachable files (entrypoint ${target.entrypoint}, ` +
          `${target.allowEnv.size} declared keys)`,
      );
    }
  }
  return !drift;
}

function main(): number {
  let targets: CheckTarget[];
  try {
    targets = repositoryTargets();
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }
  if (reportTargets(targets)) return 0;
  console.error(
    "\nAdd missing keys to the launcher's bounded --allow-env= list, " +
      "or remove the unused env read.",
  );
  return 1;
}

if (import.meta.main) Deno.exit(main());
