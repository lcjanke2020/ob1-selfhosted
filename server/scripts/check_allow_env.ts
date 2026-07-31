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
//      effective `entrypoint` and/or `command` invokes `deno run`, including
//      built-image defaults and the supported base-plus-override stacks.
//   2. Reject unrestricted grants, dynamic/multi-Deno Compose launchers, and
//      executable Deno subcommands outside the supported `run` model.
//   3. Validate the effective Deno config/import map against the checked-in
//      resolution policy, parse each reachable TypeScript module into an AST,
//      and fail closed on non-literal imports or unsupported semantics.
//   4. Find string-literal Deno env reads in the AST, reject Node's process env
//      surface, fail closed on aliases and dynamic keys that cannot be proved
//      safe, add explicit out-of-tree dependency reads, and fail if any
//      required key is absent from the launcher's allowlist.
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

// The production launchers auto-discover server/deno.json. Keeping its import
// policy explicit lets this guard reject arbitrary config/import-map semantics
// without reimplementing Deno's resolver. The one local override is added to
// the audited graph below; the remaining mappings stay external and pinned.
const SUPPORTED_DENO_CONFIG_IMPORTS: Readonly<Record<string, string>> = {
  "@hono/mcp": "npm:@hono/mcp@0.1.1",
  "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.24.3",
  "@std/assert": "jsr:@std/assert@1",
  "@std/path": "jsr:@std/path@^1.0.8",
  "@std/toml": "jsr:@std/toml@1.0.4",
  "@std/yaml": "jsr:@std/yaml@^1.1.2",
  "hono": "npm:hono@4.12.25",
  "jose": "npm:jose@5.9.6",
  "zod": "npm:zod@4.1.13",
  "postgres": "https://deno.land/x/postgres@v0.19.3/mod.ts",
  "https://deno.land/x/postgres@v0.19.3/utils/deferred.ts":
    "./postgres_deferred_patched.ts",
};

export interface CheckTarget {
  source: string;
  entrypoint: string;
  allowEnv: Set<string>;
  requiredEnv?: Set<string>;
  configPath?: string | null;
  importMapPath?: string;
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
  configPath?: string | null;
  importMapPath?: string;
} {
  const defaults = dockerImageDefaults(dockerfilePath);
  const entrypointArgs = defaults.entrypoint ?? [];
  const commandArgs = defaults.command;
  if (!commandArgs) throw new Error(`No CMD line in ${dockerfilePath}`);
  const target = parseDenoRunTarget(
    effectiveDockerArguments(entrypointArgs, commandArgs, dockerfilePath),
    dockerfilePath,
  );
  if (!target) throw new Error(`No deno run launcher in ${dockerfilePath}`);
  return target;
}

interface DockerImageDefaults {
  baseImage: string;
  entrypoint?: string[];
  command?: string[];
}

function dockerImageDefaults(dockerfilePath: string): DockerImageDefaults {
  const content = Deno.readTextFileSync(dockerfilePath);
  const stages = [...content.matchAll(
    /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gmi,
  )];
  const finalStage = stages.at(-1);
  if (!finalStage || finalStage.index === undefined) {
    throw new Error(`No FROM line in ${dockerfilePath}`);
  }
  const finalStageContent = content.slice(finalStage.index);
  return {
    baseImage: finalStage[1],
    entrypoint: dockerInstructionArguments(
      finalStageContent,
      "ENTRYPOINT",
      dockerfilePath,
    ),
    command: dockerInstructionArguments(
      finalStageContent,
      "CMD",
      dockerfilePath,
    ),
  };
}

function dockerInstructionArguments(
  content: string,
  instruction: "CMD" | "ENTRYPOINT",
  source: string,
): string[] | undefined {
  const matches = [...content.matchAll(
    new RegExp(`^\\s*${instruction}\\s+(.+)$`, "gmi"),
  )];
  const raw = matches.at(-1)?.[1].trim();
  if (!raw) return undefined;
  if (!raw.startsWith("[")) {
    throw new Error(
      `${source}: shell-form ${instruction} cannot be audited; ` +
        "use a JSON string list",
    );
  }
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
    // With an exec-form `sh -c` entrypoint, the argument after the script is
    // $0. If ENTRYPOINT provides no sentinel, Docker's first CMD argument is
    // consumed as $0 and only the remainder becomes $1... / "$@".
    const hasEntrypointArgv0 = entrypointArgs[3] !== undefined;
    const argv0 = hasEntrypointArgv0 ? entrypointArgs[3] : commandArgs[0];
    const positionals = hasEntrypointArgv0
      ? [...entrypointArgs.slice(4), ...commandArgs]
      : commandArgs.slice(1);
    return splitCommand(entrypointArgs[2], source).flatMap((argument) =>
      argument === "$@"
        ? positionals
        : argument === "$0" && argv0 !== undefined
        ? [argv0]
        : [argument]
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
  resolution: DenoResolutionOptions;
  runArguments: string[];
}

interface DenoResolutionOptions {
  configPath?: string | null;
  importMapPath?: string;
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

// These are the operand-free short aliases exposed by the pinned Deno CLI
// that are not already listed above. Unknown single-letter flags fail closed:
// a future flag may consume an operand and shift the apparent module boundary.
const KNOWN_PERMISSION_SHORT_OPTIONS = new Set([
  "-A",
  "-E",
  "-I",
  "-N",
  "-R",
  "-S",
  "-W",
]);

const UNAUDITABLE_CODE_OPTIONS = new Set([
  "--allow-scripts",
  "--preload",
  "--require",
]);

function optionName(argument: string): string {
  return argument.split("=", 1)[0];
}

function recordResolutionOption(
  resolution: DenoResolutionOptions,
  argument: string,
  separateValue: string | undefined,
  source: string,
): void {
  const name = optionName(argument);
  const attachedValue = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : undefined;
  if (name === "-c" || name === "--config") {
    const value = attachedValue ?? separateValue;
    if (!value) throw new Error(`${source}: ${name} is missing its value`);
    if (resolution.configPath !== undefined) {
      throw new Error(
        `${source}: multiple Deno config options cannot be audited`,
      );
    }
    resolution.configPath = value;
  } else if (name === "--no-config") {
    if (resolution.configPath !== undefined) {
      throw new Error(
        `${source}: conflicting Deno config options cannot be audited`,
      );
    }
    resolution.configPath = null;
  } else if (name === "--import-map") {
    const value = attachedValue ?? separateValue;
    if (!value) throw new Error(`${source}: ${name} is missing its value`);
    if (resolution.importMapPath !== undefined) {
      throw new Error(`${source}: multiple Deno import maps cannot be audited`);
    }
    resolution.importMapPath = value;
  }
}

function mergeResolutionOptions(
  source: string,
  ...parts: DenoResolutionOptions[]
): DenoResolutionOptions {
  const merged: DenoResolutionOptions = {};
  for (const part of parts) {
    if (part.configPath !== undefined) {
      if (merged.configPath !== undefined) {
        throw new Error(
          `${source}: multiple Deno config options cannot be audited`,
        );
      }
      merged.configPath = part.configPath;
    }
    if (part.importMapPath !== undefined) {
      if (merged.importMapPath !== undefined) {
        throw new Error(
          `${source}: multiple Deno import maps cannot be audited`,
        );
      }
      merged.importMapPath = part.importMapPath;
    }
  }
  return merged;
}

function isDenoExecutable(value: string): boolean {
  return !value.includes("=") && /(^|[\\/])deno(?:\.exe)?$/i.test(value);
}

function isEnvExecutable(value: string): boolean {
  return !value.includes("=") && /(^|[\\/])env(?:\.exe)?$/i.test(value);
}

const ENV_LONG_OPTIONS = new Map<string, "none" | "required" | "optional">([
  ["argv0", "required"],
  ["ignore-environment", "none"],
  ["null", "none"],
  ["unset", "required"],
  ["chdir", "required"],
  ["split-string", "required"],
  ["block-signal", "optional"],
  ["default-signal", "optional"],
  ["ignore-signal", "optional"],
  ["list-signal-handling", "none"],
  ["debug", "none"],
  ["help", "none"],
  ["version", "none"],
]);

function resolvedEnvLongOption(value: string):
  | { name: string; arity: "none" | "required" | "optional" }
  | undefined {
  const requested = value.slice(2).split("=", 1)[0];
  if (!requested) return undefined;
  const matches = [...ENV_LONG_OPTIONS].filter(([name]) =>
    name.startsWith(requested)
  );
  if (matches.length !== 1) return undefined;
  const [name, arity] = matches[0];
  return { name, arity };
}

function scanEnvOptions(
  args: string[],
  envIndex: number,
  source: string,
): void {
  for (let index = envIndex + 1; index < args.length;) {
    const argument = args[index];
    if (argument === "--") return;
    if (argument === "-") {
      index++;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (argument.includes("=")) {
        index++;
        continue;
      }
      return;
    }

    if (argument.startsWith("--")) {
      const option = resolvedEnvLongOption(argument);
      if (!option) {
        throw new Error(
          `${source}: ${argument} has unknown env option boundaries; ` +
            "use a literal Deno argv list",
        );
      }
      if (option.name === "split-string") {
        throw new Error(
          `${source}: env -S/--split-string launchers cannot be audited; ` +
            "use a literal Deno argv list",
        );
      }
      const hasAttachedValue = argument.includes("=");
      if (option.arity === "none" && hasAttachedValue) {
        throw new Error(
          `${source}: ${argument} has an unexpected env option value`,
        );
      }
      if (option.arity === "required" && !hasAttachedValue) {
        if (index + 1 >= args.length) {
          throw new Error(
            `${source}: --${option.name} is missing its env option value`,
          );
        }
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    let consumesNext = false;
    for (let offset = 1; offset < argument.length; offset++) {
      const option = argument[offset];
      if (option === "S") {
        throw new Error(
          `${source}: env -S/--split-string launchers cannot be audited; ` +
            "use a literal Deno argv list",
        );
      }
      if (["a", "u", "C"].includes(option)) {
        consumesNext = offset === argument.length - 1;
        break;
      }
      if (!["i", "0", "v"].includes(option)) {
        throw new Error(
          `${source}: -${option} has unknown env option boundaries; ` +
            "use a literal Deno argv list",
        );
      }
    }
    if (consumesNext) {
      if (index + 1 >= args.length) {
        throw new Error(
          `${source}: ${argument} is missing its env option value`,
        );
      }
      index += 2;
    } else {
      index++;
    }
  }
}

function rejectArgumentExpandingLaunchers(
  args: string[],
  source: string,
): void {
  // `env -S` re-tokenizes one argv element into a new executable plus options.
  // Parse preceding env option arity so an operand named `deno` cannot look
  // like the command boundary and hide a later split-string option.
  const denoIndex = args.findIndex(isDenoExecutable);
  const launcherEnd = denoIndex < 0 ? args.length : denoIndex;
  for (let index = 0; index < launcherEnd; index++) {
    if (isEnvExecutable(args[index])) scanEnvOptions(args, index, source);
  }
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
    KNOWN_PERMISSION_SHORT_OPTIONS.has(name) ||
    /^--(?:allow|deny|ignore)-(?:env|ffi|import|net|read|run|sys|write)$/
      .test(name);
}

function invocationFromArguments(
  args: string[],
  source: string,
): DenoInvocation | undefined {
  const denoIndex = args.findIndex(isDenoExecutable);
  if (denoIndex < 0) return undefined;

  const globalOptions: string[] = [];
  const resolution: DenoResolutionOptions = {};
  for (let index = denoIndex + 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "run") {
      return { globalOptions, resolution, runArguments: args.slice(index + 1) };
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
    let separateValue: string | undefined;
    if (GLOBAL_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
      if (index + 1 >= args.length) {
        throw new Error(`${source}: ${name} is missing its value`);
      }
      separateValue = args[index + 1];
      index++;
    }
    recordResolutionOption(resolution, argument, separateValue, source);
    if (separateValue !== undefined) continue;
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
  const shortFlags = name.startsWith("-") && !name.startsWith("--")
    ? name.slice(1)
    : "";
  if (
    name === "--permission-set" ||
    shortFlags.includes("P")
  ) {
    throw new Error(
      `${source}: -P/--permission-set can grant unaudited environment access; ` +
        "use explicit --allow-env=KEY,... permissions",
    );
  }
  if (shortFlags.length > 1) {
    if (shortFlags.includes("A")) {
      throw new Error(
        `${source}: -A/--allow-all grants every permission; ` +
          "use bounded --allow-* flags",
      );
    }
    if (shortFlags.includes("E")) {
      throw new Error(
        `${source}: combined or unbounded -E cannot be audited; ` +
          "use --allow-env=KEY,...",
      );
    }
    throw new Error(
      `${source}: combined short options cannot be audited; ` +
        "spell each option separately",
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
): { options: string[]; resolution: DenoResolutionOptions; script: string } {
  const options: string[] = [];
  const resolution: DenoResolutionOptions = {};
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
    let separateValue: string | undefined;
    if (RUN_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
      if (index + 1 >= args.length) {
        throw new Error(`${source}: ${name} is missing its value`);
      }
      separateValue = args[index + 1];
      index++;
    }
    recordResolutionOption(resolution, argument, separateValue, source);
    if (separateValue !== undefined) continue;
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
  return { options, resolution, script };
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
):
  | Pick<
    CheckTarget,
    "entrypoint" | "allowEnv" | "configPath" | "importMapPath"
  >
  | undefined {
  rejectArgumentExpandingLaunchers(args, source);
  const invocation = denoInvocation(args, source);
  if (!invocation) return undefined;
  const parsed = parseRunArguments(invocation.runArguments, source);
  const allowEnv = collectAllowEnv(
    [...invocation.globalOptions, ...parsed.options],
    source,
  );
  const resolution = mergeResolutionOptions(
    source,
    invocation.resolution,
    parsed.resolution,
  );

  return {
    entrypoint: normalizeComposeEntrypoint(parsed.script, source),
    allowEnv,
    ...resolution,
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

// Compose merge-tag keys the audit is allowed to erase: !reset / !override
// only change how a later layer merges the tagged field, and none of these
// reviewed fields can influence which launcher runs. A tag on any other
// position — build, image, entrypoint, command, a whole service, a sequence
// item — would make the audited merge diverge from Compose's, so it fails
// closed until the key is reviewed here.
const COMPOSE_MERGE_TAG_KEYS = new Set(["depends_on", "devices", "ports"]);

function composeDocument(content: string, source: string): UnknownRecord {
  // Compose's !reset / !override tags are merge directives rather than data
  // types. Removing only the tag token preserves the value that std/yaml then
  // validates, but is sound only where the audit never reads the merged
  // result: tags attached to a COMPOSE_MERGE_TAG_KEYS field are stripped,
  // occurrences inside YAML comments are left for the parser to discard, and
  // every other position fails closed. Any other unknown tag still fails
  // closed at parse time.
  const standardYaml = content.replace(
    /(^|[\s:[{,])!(?:reset|override)(?=\s)/gm,
    (match, prefix: string, offset: number) => {
      const lineStart = content.lastIndexOf("\n", offset) + 1;
      const linePrefix = content.slice(lineStart, offset + prefix.length);
      if (/(^|\s)#/.test(linePrefix)) return match;
      const attachedKey = linePrefix.match(/([^\s:{,[\]]+):\s*$/)?.[1];
      if (
        attachedKey !== undefined && COMPOSE_MERGE_TAG_KEYS.has(attachedKey)
      ) {
        return prefix;
      }
      throw new Error(
        `${source}: Compose merge tag on ${
          attachedKey ?? "an unrecognised position"
        } cannot be audited; !reset/!override are supported only on reviewed ` +
          `launcher-irrelevant fields (${
            [...COMPOSE_MERGE_TAG_KEYS].join(", ")
          })`,
      );
    },
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
  if (document.include !== undefined) {
    throw new Error(
      `${source}: Compose include cannot be audited; classify the files as an explicit stack`,
    );
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
  return parseComposeServiceTargets(
    document.services,
    source,
    dirname(resolve(REPO_DIR, source)),
  );
}

function literalComposeBuildPath(
  value: unknown,
  source: string,
  field: "context" | "dockerfile",
): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("$") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("git@")
  ) {
    throw new Error(
      `${source}: build ${field} must be a literal local path`,
    );
  }
  return value;
}

function composeBuildDockerfile(
  rawService: UnknownRecord,
  source: string,
  composeBaseDirectory: string,
): string | undefined {
  const build = rawService.build;
  if (build === undefined || build === null) return undefined;

  let context = ".";
  let dockerfile = "Dockerfile";
  if (typeof build === "string") {
    context = literalComposeBuildPath(build, source, "context");
  } else if (isRecord(build)) {
    if (build.dockerfile_inline !== undefined || build.target !== undefined) {
      throw new Error(
        `${source}: inline or target-specific Docker builds cannot be audited`,
      );
    }
    if (build.context !== undefined) {
      context = literalComposeBuildPath(build.context, source, "context");
    }
    if (build.dockerfile !== undefined) {
      dockerfile = literalComposeBuildPath(
        build.dockerfile,
        source,
        "dockerfile",
      );
    }
  } else {
    throw new Error(`${source}: build must be a path or mapping`);
  }

  const path = resolve(composeBaseDirectory, context, dockerfile);
  try {
    if (!Deno.statSync(path).isFile) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    throw new Error(
      `${source}: build Dockerfile cannot be resolved at ${path}: ${
        (error as Error).message
      }`,
    );
  }
  return path;
}

function defaultsContainDeno(defaults: DockerImageDefaults): boolean {
  return [...defaults.entrypoint ?? [], ...defaults.command ?? []].some(
    (argument) =>
      isDenoExecutable(argument) || containsDenoExecutableText(argument),
  );
}

const KNOWN_NON_DENO_BASE_IMAGES = new Set([
  // This checked-in derivative deliberately inherits Caddy's pinned launcher;
  // it contains no Deno runtime and has no Compose command override.
  "caddy:2.11.3-alpine",
  "scratch",
]);

const KNOWN_NON_DENO_IMAGES = new Set([
  // Reviewed image-only Compose services: these exact pins ship no Deno
  // runtime, so their unresolvable launcher defaults cannot start a Deno
  // process. Any other image-only service fails closed until its pin is
  // reviewed and added here.
  "ollama/ollama:0.24.0",
  "pgvector/pgvector:pg16",
]);

function effectiveComposeArguments(
  rawService: UnknownRecord,
  source: string,
  composeBaseDirectory: string,
): string[] | undefined {
  const overridesEntrypoint = Object.hasOwn(rawService, "entrypoint") &&
    rawService.entrypoint !== null;
  const overridesCommand = Object.hasOwn(rawService, "command") &&
    rawService.command !== null;
  const explicitEntrypoint = overridesEntrypoint
    ? literalArguments(rawService.entrypoint, source, "entrypoint")
    : undefined;
  const explicitCommand = overridesCommand
    ? literalArguments(rawService.command, source, "command")
    : undefined;

  // A non-null Compose entrypoint replaces the image entrypoint and suppresses
  // its default CMD. Only an explicit Compose command is appended.
  if (explicitEntrypoint !== undefined) {
    return [...explicitEntrypoint, ...explicitCommand ?? []];
  }

  const dockerfile = composeBuildDockerfile(
    rawService,
    source,
    composeBaseDirectory,
  );
  if (dockerfile === undefined) {
    if (rawService.image !== undefined) {
      if (explicitCommand !== undefined) {
        throw new Error(
          `${source}: command overrides an image whose ENTRYPOINT cannot be resolved; ` +
            "use a checked-in build or an explicit entrypoint",
        );
      }
      // Without a checked-in build, the launcher lives in the image and
      // cannot be resolved from the repository. Only reviewed non-Deno pins
      // may run on their unresolved defaults.
      const image = rawService.image;
      if (typeof image !== "string" || image.includes("$")) {
        throw new Error(
          `${source}: image must be a literal string to be audited`,
        );
      }
      if (!KNOWN_NON_DENO_IMAGES.has(image)) {
        throw new Error(
          `${source}: image launcher defaults for ${image} cannot be resolved; ` +
            "use a checked-in build, an explicit entrypoint, or review the " +
            "pin into KNOWN_NON_DENO_IMAGES",
        );
      }
      return undefined;
    }
    if (explicitCommand === undefined) return undefined;
    // Parser fixtures without image metadata model an image with no ENTRYPOINT.
    return explicitCommand;
  }

  const defaults = dockerImageDefaults(dockerfile);
  if (defaults.entrypoint === undefined) {
    if (explicitCommand !== undefined || defaultsContainDeno(defaults)) {
      throw new Error(
        `${source}: built image ENTRYPOINT cannot be resolved from ${dockerfile}; ` +
          "declare it explicitly before overriding or auditing CMD",
      );
    }
    if (!KNOWN_NON_DENO_BASE_IMAGES.has(defaults.baseImage)) {
      throw new Error(
        `${source}: built image launcher defaults inherited from ${defaults.baseImage} ` +
          `cannot be resolved from ${dockerfile}`,
      );
    }
    return undefined;
  }
  const command = explicitCommand ?? defaults.command;
  if (command === undefined) {
    if (defaultsContainDeno(defaults)) {
      throw new Error(
        `${source}: built image CMD cannot be resolved from ${dockerfile}`,
      );
    }
    if (!KNOWN_NON_DENO_BASE_IMAGES.has(defaults.baseImage)) {
      throw new Error(
        `${source}: built image launcher defaults inherited from ${defaults.baseImage} ` +
          `cannot be resolved from ${dockerfile}`,
      );
    }
    return undefined;
  }
  return effectiveDockerArguments(defaults.entrypoint, command, source);
}

function parseComposeServiceTargets(
  services: UnknownRecord,
  source: string,
  composeBaseDirectory: string,
): CheckTarget[] {
  const targets: CheckTarget[] = [];
  for (const [serviceName, rawService] of Object.entries(services)) {
    const label = `${source}#${serviceName}`;
    if (rawService === null) continue;
    if (!isRecord(rawService)) {
      throw new Error(`${label}: service definition must be a mapping`);
    }
    if (rawService.extends !== undefined) {
      throw new Error(
        `${label}: Compose extends cannot be audited; use an explicit checked-in stack`,
      );
    }
    const launcherArgs = effectiveComposeArguments(
      rawService,
      label,
      composeBaseDirectory,
    );
    if (!launcherArgs || launcherArgs.length === 0) continue;
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

export function parseComposeStackTargets(
  layers: readonly { content: string; source: string }[],
): CheckTarget[] {
  if (layers.length === 0) {
    throw new Error("Compose stack must contain at least one file");
  }
  const effectiveServices: UnknownRecord = {};
  for (const layer of layers) {
    const document = composeDocument(layer.content, layer.source);
    if (document.services === undefined) continue;
    if (!isRecord(document.services)) {
      throw new Error(`${layer.source}: services must be a mapping`);
    }
    for (const [serviceName, rawService] of Object.entries(document.services)) {
      const label = `${layer.source}#${serviceName}`;
      if (rawService === null) {
        effectiveServices[serviceName] = null;
        continue;
      }
      if (!isRecord(rawService)) {
        throw new Error(`${label}: service definition must be a mapping`);
      }
      if (rawService.extends !== undefined) {
        throw new Error(
          `${label}: Compose extends cannot be audited; use an explicit checked-in stack`,
        );
      }
      const current = isRecord(effectiveServices[serviceName])
        ? { ...effectiveServices[serviceName] }
        : {};
      for (
        const field of ["build", "image", "entrypoint", "command"] as const
      ) {
        if (Object.hasOwn(rawService, field)) {
          current[field] = field === "build" &&
              isRecord(current.build) && isRecord(rawService.build)
            ? { ...current.build, ...rawService.build }
            : rawService[field];
        }
      }
      effectiveServices[serviceName] = current;
    }
  }
  return parseComposeServiceTargets(
    effectiveServices,
    layers.map((layer) => layer.source).join(" + "),
    dirname(resolve(REPO_DIR, layers[0].source)),
  );
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
      plugins: [
        "typescript",
        ["decorators", {}],
        "decoratorAutoAccessors",
        ...(source.toLowerCase().endsWith(".tsx") ? ["jsx"] as const : []),
      ],
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

interface ModuleResolutionInput {
  source?: string;
  configPath?: string | null;
  importMapPath?: string;
}

function relativeAuditPath(
  absolutePath: string,
  baseDir: string,
  source: string,
  description: string,
): string {
  const path = relative(baseDir, absolutePath).replaceAll("\\", "/");
  if (path === ".." || path.startsWith("../")) {
    throw new Error(
      `${source}: ${description} must resolve inside /app: ${absolutePath}`,
    );
  }
  return path;
}

function localAuditPath(
  value: string,
  baseDir: string,
  relativeTo: string,
  source: string,
  description: string,
): string {
  const portable = value.replace(/[?#].*$/, "").replaceAll("\\", "/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(portable)) {
    throw new Error(
      `${source}: remote ${description} cannot be audited: ${value}`,
    );
  }
  const absolutePath = portable.startsWith("/app/")
    ? resolve(baseDir, portable.slice("/app/".length))
    : resolve(relativeTo, portable);
  return relativeAuditPath(absolutePath, baseDir, source, description);
}

function readJsonDocument(path: string, description: string): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(path));
  } catch (error) {
    throw new Error(
      `${description} must be strict JSON that can be audited: ${
        (error as Error).message
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${description} must contain a JSON object`);
  }
  return parsed;
}

function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function resolutionLocalFiles(
  baseDir: string,
  input: ModuleResolutionInput,
): Set<string> {
  const source = input.source ?? "Deno launcher";
  if (input.importMapPath !== undefined) {
    throw new Error(
      `${source}: custom Deno import maps cannot be audited; ` +
        "use the checked-in server/deno.json policy",
    );
  }
  let configPath: string | undefined;
  if (input.configPath !== null) {
    if (input.configPath !== undefined) {
      const path = localAuditPath(
        input.configPath,
        baseDir,
        baseDir,
        source,
        "Deno config",
      );
      configPath = join(baseDir, path);
    } else {
      for (const name of ["deno.json", "deno.jsonc"]) {
        const candidate = join(baseDir, name);
        if (fileExists(candidate)) {
          configPath = candidate;
          break;
        }
      }
    }
  }
  if (configPath === undefined) return new Set();
  const expectedPath = join(baseDir, "deno.json");
  if (resolve(configPath) !== resolve(expectedPath)) {
    throw new Error(
      `${source}: custom Deno configs cannot be audited; ` +
        "use the checked-in server/deno.json policy",
    );
  }
  const config = readJsonDocument(
    configPath,
    `${source}: Deno config ${configPath}`,
  );
  const unsupportedKeys = Object.keys(config).filter((key) =>
    key !== "imports" && key !== "tasks"
  );
  if (unsupportedKeys.length > 0 || !isRecord(config.imports)) {
    throw new Error(
      `${source}: Deno config contains unsupported resolution semantics`,
    );
  }
  const actualImports = Object.entries(config.imports).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const expectedImports = Object.entries(SUPPORTED_DENO_CONFIG_IMPORTS).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (
    actualImports.length !== expectedImports.length ||
    actualImports.some(([key, value], index) => {
      const expected = expectedImports[index];
      return typeof value !== "string" || key !== expected[0] ||
        value !== expected[1];
    })
  ) {
    throw new Error(
      `${source}: Deno config imports differ from the checked-in audited policy`,
    );
  }
  return new Set(["postgres_deferred_patched.ts"]);
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

export function walkImports(
  entrypoint: string,
  baseDir: string,
  resolution: ModuleResolutionInput = {},
): Set<string> {
  const configFiles = resolutionLocalFiles(baseDir, resolution);
  const visited = new Set<string>();
  const queue: string[] = [entrypoint, ...configFiles];
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
      const specifierPath = specifier.replace(/[?#].*$/, "");
      const withExtension = /\.tsx?$/i.test(specifierPath)
        ? specifierPath
        : `${specifierPath}.ts`;
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

function isNodeProcessModuleReference(node: t.Node): boolean {
  const isProcessSpecifier = (value: t.Node | null | undefined): boolean => {
    const specifier = staticStringValue(value);
    return specifier === "node:process" || specifier === "process";
  };
  if (node.type === "ImportDeclaration") {
    return isProcessSpecifier(node.source);
  }
  if (
    (node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") && node.source
  ) {
    return isProcessSpecifier(node.source);
  }
  if (node.type === "ImportExpression") {
    return isProcessSpecifier(node.source);
  }
  if (node.type === "TSImportType") {
    return isProcessSpecifier(node.argument);
  }
  return isCallExpression(node) &&
    (node.callee.type === "Import" ||
      node.callee.type === "Identifier" && node.callee.name === "require") &&
    isProcessSpecifier(node.arguments[0]);
}

function innermostFunction(ancestors: readonly t.Node[]): t.Node | undefined {
  return ancestors.findLast((node) =>
    [
      "ArrowFunctionExpression",
      "ClassMethod",
      "ClassPrivateMethod",
      "FunctionDeclaration",
      "FunctionExpression",
      "ObjectMethod",
    ].includes(node.type)
  );
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
      (parent.id === node || parent.params.includes(node)) ||
    (parent.type === "ArrowFunctionExpression" ||
        parent.type === "ObjectMethod" || parent.type === "ClassMethod" ||
        parent.type === "ClassPrivateMethod") &&
      parent.params.includes(node);
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
  if (
    (parent.type === "ObjectMethod" || parent.type === "ClassMethod" ||
      parent.type === "ClassProperty" ||
      parent.type === "ClassAccessorProperty") &&
    parent.key === node && !parent.computed
  ) return true;
  return [
    "ImportDefaultSpecifier",
    "ImportNamespaceSpecifier",
    "ImportSpecifier",
    "LabeledStatement",
  ].includes(parent.type);
}

interface EnvWrapperDeclaration {
  declaration: t.FunctionDeclaration;
  parameter: t.Identifier;
}

function passThroughWrapperCandidate(
  node: CallExpression,
  ancestors: readonly t.Node[],
): EnvWrapperDeclaration | undefined {
  const fn = innermostFunction(ancestors);
  const argument = node.arguments[0];
  if (
    fn?.type !== "FunctionDeclaration" || !fn.id ||
    fn.params[0]?.type !== "Identifier" ||
    argument?.type !== "Identifier" || argument.name !== fn.params[0].name
  ) return undefined;
  return { declaration: fn, parameter: fn.params[0] };
}

function patternBindsName(
  node: t.Node | null | undefined,
  name: string,
): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "RestElement") {
    return patternBindsName(node.argument, name);
  }
  if (node.type === "AssignmentPattern") {
    return patternBindsName(node.left, name);
  }
  if (node.type === "ArrayPattern") {
    return node.elements.some((element) => patternBindsName(element, name));
  }
  if (node.type === "ObjectPattern") {
    return node.properties.some((property) =>
      property.type === "RestElement"
        ? patternBindsName(property.argument, name)
        : patternBindsName(property.value, name)
    );
  }
  if (node.type === "TSParameterProperty") {
    return patternBindsName(node.parameter, name);
  }
  return false;
}

function assertWrapperParameterUnmodified(
  wrapper: EnvWrapperDeclaration,
  filePath: string,
): void {
  const name = wrapper.parameter.name;
  let modified = false;
  walkAst(wrapper.declaration.body, (node) => {
    if (modified) return;
    if (
      node.type === "VariableDeclarator" && patternBindsName(node.id, name) ||
      node.type === "CatchClause" && patternBindsName(node.param, name) ||
      node.type === "FunctionDeclaration" && node.id?.name === name ||
      node.type === "ClassDeclaration" && node.id?.name === name ||
      node.type === "AssignmentExpression" &&
        patternBindsName(node.left, name) ||
      node.type === "UpdateExpression" &&
        patternBindsName(node.argument, name) ||
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
        node.left.type !== "VariableDeclaration" &&
        patternBindsName(node.left, name)
    ) modified = true;
  });
  if (modified) {
    throw new Error(
      `${filePath}: known env wrapper ${wrapper.declaration.id!.name}() ` +
        `cannot modify or shadow its ${name} parameter`,
    );
  }
}

function knownWrapperDeclarations(
  sourceFile: t.File,
  filePath: string,
): Map<string, EnvWrapperDeclaration> {
  // Derive wrappers from a direct Deno.env.get(firstParameter) read. A dynamic
  // read is safe to suppress only for that exact, unmodified parameter while
  // the wrapper remains source-local and every use is a direct audited call.
  const declarations = new Map<string, EnvWrapperDeclaration>();
  walkAst(sourceFile, (node, ancestors) => {
    if (!isDirectDenoEnvGetCall(node)) return;
    const wrapper = passThroughWrapperCandidate(node, ancestors);
    if (!wrapper) return;
    const name = wrapper.declaration.id!.name;
    const existing = declarations.get(name);
    if (existing && existing.declaration !== wrapper.declaration) {
      throw new Error(
        `${filePath}: known env wrapper ${name}() is redeclared and cannot be audited`,
      );
    }
    declarations.set(name, wrapper);
  });

  walkAst(sourceFile, (node, ancestors) => {
    if (node.type !== "FunctionDeclaration" || !node.id) return;
    const wrapper = declarations.get(node.id.name);
    if (!wrapper) return;
    if (wrapper.declaration !== node) {
      throw new Error(
        `${filePath}: known env wrapper ${node.id.name}() is redeclared and cannot be audited`,
      );
    }
    const parent = ancestors.at(-1);
    if (
      parent?.type === "ExportNamedDeclaration" ||
      parent?.type === "ExportDefaultDeclaration"
    ) {
      throw new Error(
        `${filePath}: known env wrapper ${node.id.name}() cannot be exported; ` +
          "keep it source-local with direct literal call sites",
      );
    }
  });
  for (const wrapper of declarations.values()) {
    assertWrapperParameterUnmodified(wrapper, filePath);
  }
  return declarations;
}

function isPassThroughWrapperRead(
  node: CallExpression,
  ancestors: readonly t.Node[],
  declarations: ReadonlyMap<string, EnvWrapperDeclaration>,
): boolean {
  const fn = innermostFunction(ancestors);
  if (fn?.type !== "FunctionDeclaration" || !fn.id) return false;
  const wrapper = declarations.get(fn.id.name);
  const argument = node.arguments[0];
  return wrapper?.declaration === fn && argument?.type === "Identifier" &&
    argument.name === wrapper.parameter.name;
}

export function findEnvReads(filePath: string): Set<string> {
  const sourceFile = parseTypeScript(Deno.readTextFileSync(filePath), filePath);
  const wrapperDeclarations = knownWrapperDeclarations(sourceFile, filePath);
  const reads = new Set<string>();

  walkAst(sourceFile, (node, ancestors) => {
    if (isNodeProcessModuleReference(node)) {
      throw new Error(
        `${filePath}: node:process environment API cannot be audited; ` +
          'use Deno.env.get("LITERAL_KEY")',
      );
    }
    if (
      isMemberExpression(node) && memberName(node) === "process" &&
      node.object.type === "Identifier" &&
      ["global", "globalThis", "self", "window"].includes(node.object.name)
    ) {
      throw new Error(
        `${filePath}: node:process environment API cannot be audited; ` +
          'use Deno.env.get("LITERAL_KEY")',
      );
    }
    if (node.type === "Identifier" && node.name === "process") {
      const parent = ancestors.at(-1);
      const isNamedProperty = isMemberExpression(parent) &&
        parent.property === node && !parent.computed;
      if (
        parent && !isNamedProperty && !isNonValueIdentifier(node, parent)
      ) {
        throw new Error(
          `${filePath}: node:process environment API cannot be audited; ` +
            'use Deno.env.get("LITERAL_KEY")',
        );
      }
    }
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
          !isPassThroughWrapperRead(node, ancestors, wrapperDeclarations)
        ) throw error;
      }
    }
    if (
      isCallExpression(node) && node.callee.type === "Identifier" &&
      wrapperDeclarations.has(node.callee.name)
    ) {
      reads.add(
        literalEnvKey(
          node.arguments[0],
          `${filePath}: ${node.callee.name}()`,
        ),
      );
    }

    if (node.type === "Identifier" && wrapperDeclarations.has(node.name)) {
      const declaration = wrapperDeclarations.get(node.name)!.declaration;
      const parent = ancestors.at(-1);
      const isDeclaration = parent === declaration && declaration.id === node;
      const isDirectCall = isCallExpression(parent) && parent.callee === node;
      const isNamedProperty = isMemberExpression(parent) &&
        parent.property === node && !parent.computed;
      if (
        parent && !isDeclaration && !isDirectCall && !isNamedProperty &&
        !isNonValueIdentifier(node, parent)
      ) {
        throw new Error(
          `${filePath}: known env wrapper ${node.name}() cannot be aliased or exported; ` +
            "use direct calls with literal env keys",
        );
      }
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
  const files = walkImports(target.entrypoint, baseDir, target);
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

function uniqueTargets(targets: CheckTarget[]): CheckTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const signature = JSON.stringify({
      entrypoint: target.entrypoint,
      allowEnv: [...target.allowEnv].sort(),
      requiredEnv: [...target.requiredEnv ?? []].sort(),
      configPath: target.configPath === undefined
        ? "<auto>"
        : target.configPath,
      importMapPath: target.importMapPath ?? "<none>",
    });
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
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
  const composeLayers = new Map(
    composeFiles(DEPLOY_DIR).map((path) => [
      path,
      {
        content: Deno.readTextFileSync(path),
        source: relative(REPO_DIR, path).replaceAll("\\", "/"),
      },
    ]),
  );
  const basePath = join(DEPLOY_DIR, "compose-local", "docker-compose.yml");
  const overlayPaths = [
    join(DEPLOY_DIR, "compose-tailnet", "docker-compose.pattern-b.yml"),
    join(DEPLOY_DIR, "qubes", "docker-compose.external-db.yml"),
    join(DEPLOY_DIR, "qubes", "docker-compose.cpu-ollama.yml"),
  ];
  const standalonePaths = [
    join(DEPLOY_DIR, "qubes", "app-qube", "docker-compose.yml"),
    join(DEPLOY_DIR, "qubes", "ingress-qube", "docker-compose.yml"),
  ];
  const classifiedPaths = new Set([
    basePath,
    ...overlayPaths,
    ...standalonePaths,
  ]);
  for (const path of composeLayers.keys()) {
    if (!classifiedPaths.has(path)) {
      throw new Error(
        `Compose file is not classified as standalone or a supported override: ${path}`,
      );
    }
  }
  for (const layer of composeLayers.values()) {
    targets.push(...parseComposeTargets(layer.content, layer.source));
  }

  // These three override files are documented as optional layers on the
  // compose-local base. Audit every supported subset in its documented order
  // so an override command is combined with an inherited Deno entrypoint.
  const baseLayer = composeLayers.get(basePath);
  if (!baseLayer) {
    throw new Error(`Missing supported Compose base: ${basePath}`);
  }
  for (let mask = 1; mask < 1 << overlayPaths.length; mask++) {
    const stack = [baseLayer];
    for (const [index, path] of overlayPaths.entries()) {
      if ((mask & (1 << index)) === 0) continue;
      const layer = composeLayers.get(path);
      if (!layer) {
        throw new Error(`Missing supported Compose override: ${path}`);
      }
      stack.push(layer);
    }
    targets.push(...parseComposeStackTargets(stack));
  }
  return uniqueTargets(targets);
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
