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
//   2. Reject unrestricted Deno grants and dynamic Compose launchers before
//      deciding whether a checked-in command is auditable.
//   3. Walk the relative-import graph from each TypeScript entrypoint,
//      collecting every reachable in-tree .ts file.
//   4. Find string-literal env reads, fail closed when a known wrapper receives
//      a dynamic key, add explicit out-of-tree dependency reads, and fail if
//      any required key is absent from the launcher's allowlist.
//
// Over-permissive entries are generally not flagged. The deno-postgres driver
// reads seven PG* keys outside this source tree, so any reachable import of the
// pinned driver adds that explicit dependency policy.
//
// Run locally: `deno task check-allow-env` (from server/).
// CI: runs as the check-allow-env job in .github/workflows/ci.yml.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

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
  for (const character of value) {
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

const DENO_SUBCOMMANDS = new Set([
  "add",
  "bench",
  "check",
  "clean",
  "compile",
  "coverage",
  "deploy",
  "doc",
  "eval",
  "fmt",
  "info",
  "install",
  "jupyter",
  "lint",
  "repl",
  "serve",
  "task",
  "test",
  "upgrade",
  "watch",
]);

const GLOBAL_OPTIONS_WITH_VALUES = new Set([
  "--cert",
  "--conditions",
  "-c",
  "--config",
  "--location",
  "--v8-flags",
]);

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
  "--minimum-dependency-age",
  "--seed",
]);

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

function invocationFromArguments(
  args: string[],
  source: string,
): DenoInvocation | undefined {
  const isDeno = (value: string) => /(^|[\\/])deno(?:\.exe)?$/i.test(value);
  for (let denoIndex = 0; denoIndex < args.length; denoIndex++) {
    if (!isDeno(args[denoIndex])) continue;
    const globalOptions: string[] = [];
    for (let index = denoIndex + 1; index < args.length; index++) {
      const argument = args[index];
      if (argument === "run") {
        return { globalOptions, runArguments: args.slice(index + 1) };
      }
      if (DENO_SUBCOMMANDS.has(argument)) break;
      if (!argument.startsWith("-")) {
        if (/\.tsx?(?:[?#].*)?$/.test(argument)) {
          throw new Error(
            `${source}: implicit Deno execution cannot be audited; ` +
              "spell the launcher as deno run ...",
          );
        }
        break;
      }
      globalOptions.push(argument);
      const name = optionName(argument);
      if (GLOBAL_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
        if (index + 1 >= args.length) {
          throw new Error(`${source}: ${name} is missing its value`);
        }
        index++;
      }
    }
  }
  return undefined;
}

function denoInvocation(
  args: string[],
  source: string,
): DenoInvocation | undefined {
  const direct = invocationFromArguments(args, source);
  if (direct) return direct;

  // A shell-form entrypoint may put the entire command in one `sh -c`
  // argument. Flatten only as a fallback so direct list arguments keep their
  // original boundaries.
  const flattened = args.flatMap((value) => splitCommand(value, source));
  return invocationFromArguments(flattened, source);
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
      !argument.includes("=") &&
      !RUN_STANDALONE_OPTIONS.has(name) &&
      !/^--(?:allow|deny|ignore)-(?:env|ffi|import|net|read|run|sys|write)$/
        .test(
          name,
        ) &&
      !/^-[AEINPRSW]$/.test(name) &&
      !/^-[A-Za-z]{2,}$/.test(name)
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
    const parsed = parseDenoRunTarget(
      [...entrypointArgs, ...commandArgs],
      label,
    );
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

function importSpecifiers(content: string): Set<string> {
  const specifiers = new Set<string>();
  const patterns = [
    /from\s+["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function dependencyEnvForFiles(
  files: Iterable<string>,
  baseDir: string,
): Set<string> {
  for (const file of files) {
    const specifiers = importSpecifiers(
      Deno.readTextFileSync(join(baseDir, file)),
    );
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
    for (const specifier of importSpecifiers(content)) {
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

function maskNonCode(content: string): string {
  // Keep indexes aligned with the original UTF-16 string so regex match
  // offsets can be used to read literal arguments from `content`.
  const masked = Array<string>(content.length).fill(" ");
  let index = 0;

  const maskOne = (): void => {
    if (content[index] === "\n") masked[index] = "\n";
    index++;
  };

  const regexCanStart = (at: number): boolean => {
    let previous = at - 1;
    while (previous >= 0 && /\s/.test(masked[previous])) previous--;
    if (previous < 0) return true;
    if ("=(,:[!&|?{};+-*%~^<>".includes(masked[previous])) return true;
    const prefix = masked.slice(0, at).join("").trimEnd();
    return /(?:^|[^A-Za-z0-9_$])(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/
      .test(
        prefix,
      );
  };

  const skipLineComment = (): void => {
    while (index < content.length && content[index] !== "\n") maskOne();
  };

  const skipBlockComment = (): void => {
    maskOne();
    maskOne();
    while (index < content.length) {
      if (content[index] === "*" && content[index + 1] === "/") {
        maskOne();
        maskOne();
        return;
      }
      maskOne();
    }
  };

  const skipQuoted = (quote: "'" | '"'): void => {
    maskOne();
    while (index < content.length) {
      if (content[index] === "\\") {
        maskOne();
        if (index < content.length) maskOne();
      } else if (content[index] === quote) {
        maskOne();
        return;
      } else {
        maskOne();
      }
    }
  };

  const skipRegex = (): void => {
    maskOne();
    let inCharacterClass = false;
    while (index < content.length) {
      const character = content[index];
      if (character === "\n") return;
      if (character === "\\") {
        maskOne();
        if (index < content.length) maskOne();
      } else if (character === "[") {
        inCharacterClass = true;
        maskOne();
      } else if (character === "]") {
        inCharacterClass = false;
        maskOne();
      } else if (character === "/" && !inCharacterClass) {
        maskOne();
        while (/[A-Za-z]/.test(content[index] ?? "")) maskOne();
        return;
      } else {
        maskOne();
      }
    }
  };

  function skipTemplate(): void {
    maskOne();
    while (index < content.length) {
      if (content[index] === "\\") {
        maskOne();
        if (index < content.length) maskOne();
      } else if (content[index] === "`") {
        maskOne();
        return;
      } else if (content[index] === "$" && content[index + 1] === "{") {
        maskOne();
        masked[index] = "{";
        index++;
        scanCode(true);
      } else {
        maskOne();
      }
    }
  }

  function scanCode(stopAtTemplateBrace: boolean): void {
    let braceDepth = 0;
    while (index < content.length) {
      const character = content[index];
      const next = content[index + 1];
      if (stopAtTemplateBrace && character === "}" && braceDepth === 0) {
        masked[index] = character;
        index++;
        return;
      }
      if (character === "/" && next === "/") {
        skipLineComment();
      } else if (character === "/" && next === "*") {
        skipBlockComment();
      } else if (character === "'") {
        skipQuoted("'");
      } else if (character === '"') {
        skipQuoted('"');
      } else if (character === "`") {
        skipTemplate();
      } else if (character === "/" && regexCanStart(index)) {
        skipRegex();
      } else {
        masked[index] = character;
        if (stopAtTemplateBrace && character === "{") braceDepth++;
        else if (stopAtTemplateBrace && character === "}") braceDepth--;
        index++;
      }
    }
  }

  scanCode(false);
  return masked.join("");
}

function literalEnvArgument(
  content: string,
  openParen: number,
  description: string,
): string {
  let index = openParen + 1;
  while (/\s/.test(content[index] ?? "")) index++;
  const quote = content[index];
  if (quote !== '"' && quote !== "'") {
    throw new Error(
      `${description} must receive a string-literal env key; ` +
        "dynamic env reads cannot be audited",
    );
  }
  const start = ++index;
  while (index < content.length && content[index] !== quote) {
    if (content[index] === "\\" || content[index] === "\n") {
      throw new Error(
        `${description} must use an unescaped string-literal env key`,
      );
    }
    index++;
  }
  if (index >= content.length) {
    throw new Error(`${description} has an unterminated env-key literal`);
  }
  const key = content.slice(start, index);
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`${description} has an invalid env key: ${key}`);
  }
  return key;
}

function wrapperFunctionRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const name of WRAPPER_NAMES) {
    const declaration = new RegExp(
      String.raw`\bfunction\s+${name}\s*\([^)]*\)[^{]*\{`,
      "g",
    );
    for (const match of code.matchAll(declaration)) {
      const openBrace = match.index + match[0].lastIndexOf("{");
      let depth = 1;
      let end = openBrace + 1;
      while (end < code.length && depth > 0) {
        if (code[end] === "{") depth++;
        else if (code[end] === "}") depth--;
        end++;
      }
      ranges.push([openBrace, end]);
    }
  }
  return ranges;
}

export function findEnvReads(filePath: string): Set<string> {
  const content = Deno.readTextFileSync(filePath);
  const code = maskNonCode(content);
  const wrapperRanges = wrapperFunctionRanges(code);
  const reads = new Set<string>();
  for (
    const match of code.matchAll(/\bDeno\s*(?:\?\.|\.)\s*env\b/g)
  ) {
    const tail = code.slice(match.index + match[0].length);
    const getter = tail.match(/^\s*(?:\?\.|\.)\s*get\s*\(/);
    if (!getter) {
      throw new Error(
        `${filePath}: unmodelled Deno.env access cannot be audited; ` +
          'use Deno.env.get("LITERAL_KEY")',
      );
    }
    const openParen = match.index + match[0].length +
      getter[0].lastIndexOf("(");
    try {
      reads.add(
        literalEnvArgument(content, openParen, `${filePath}: Deno.env.get()`),
      );
    } catch (error) {
      // Source-local wrappers intentionally receive the name dynamically and
      // are covered at their call sites below. Any other dynamic direct read
      // fails closed rather than disappearing from the launcher's requirements.
      const insideWrapper = wrapperRanges.some(([start, end]) =>
        match.index >= start && match.index < end
      );
      if (
        !(error as Error).message.includes("dynamic env reads") ||
        !insideWrapper
      ) throw error;
    }
  }
  for (const name of WRAPPER_NAMES) {
    const pattern = new RegExp(String.raw`\b${name}\s*\(`, "g");
    for (const match of code.matchAll(pattern)) {
      const previous = code[match.index - 1];
      if (
        previous !== undefined &&
        (previous === "." || previous === "$" || /[A-Za-z0-9_]/.test(previous))
      ) {
        continue;
      }
      if (/\bfunction\s*$/.test(code.slice(0, match.index))) continue;
      const openParen = match.index + match[0].lastIndexOf("(");
      reads.add(
        literalEnvArgument(content, openParen, `${filePath}: ${name}()`),
      );
    }
  }
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
