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
// reads seven PG* keys outside this source tree, so each entrypoint that builds
// a Pool carries that explicit dependency policy.
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

const POSTGRES_ENTRYPOINTS = new Set([
  "index.ts",
  "log_ingester.ts",
  "token_admin.ts",
]);

export function dependencyEnvForEntrypoint(entrypoint: string): Set<string> {
  const basename = entrypoint.replaceAll("\\", "/").split("/").at(-1) ??
    entrypoint;
  return POSTGRES_ENTRYPOINTS.has(basename)
    ? new Set(DENO_POSTGRES_ALLOW_ENV)
    : new Set();
}

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
  requiredEnv: Set<string>;
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
    [...entrypointArgs, ...commandArgs],
    dockerfilePath,
  );
  if (!target) throw new Error(`No deno run launcher in ${dockerfilePath}`);
  return {
    entrypoint: target.entrypoint,
    allowEnv: target.allowEnv,
    requiredEnv: dependencyEnvForEntrypoint(target.entrypoint),
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

function denoInvocation(
  args: string[],
  source: string,
): string[] | undefined {
  const isDeno = (value: string) => /(^|[\\/])deno(?:\.exe)?$/i.test(value);
  let index = args.findIndex((value, at) =>
    isDeno(value) && args[at + 1] === "run"
  );
  if (index >= 0) return args.slice(index);

  // A shell-form entrypoint may put the entire command in one `sh -c`
  // argument. Flatten only as a fallback so direct list arguments keep their
  // original boundaries.
  const flattened = args.flatMap((value) => splitCommand(value, source));
  index = flattened.findIndex((value, at) =>
    isDeno(value) && flattened[at + 1] === "run"
  );
  return index >= 0 ? flattened.slice(index) : undefined;
}

function parseDenoRunTarget(
  args: string[],
  source: string,
): Pick<CheckTarget, "entrypoint" | "allowEnv"> | undefined {
  const invocation = denoInvocation(args, source);
  if (!invocation) return undefined;

  const firstTypeScript = invocation.findIndex((argument, index) =>
    index >= 2 && /\.ts(?:[?#].*)?$/.test(argument)
  );
  const boundaryCandidate = invocation.indexOf("--", 2);
  const optionBoundary = boundaryCandidate >= 0 &&
      (firstTypeScript < 0 || boundaryCandidate < firstTypeScript)
    ? boundaryCandidate
    : -1;
  const scriptIndex = optionBoundary >= 0
    ? optionBoundary + 1
    : firstTypeScript;
  const script = invocation[scriptIndex];
  if (scriptIndex < 0 || !script || !/\.ts(?:[?#].*)?$/.test(script)) {
    throw new Error(`${source}: deno run launcher has no .ts module`);
  }

  // Deno stops parsing runtime options at `--` or at the module. Permission-
  // looking script arguments after that boundary must not be counted as grants.
  const optionEnd = optionBoundary >= 0 ? optionBoundary : scriptIndex;
  const options = invocation.slice(2, optionEnd);
  for (const argument of options) {
    if (argument === "--allow-all" || argument.startsWith("--allow-all=")) {
      throw new Error(
        `${source}: -A/--allow-all grants every permission; ` +
          "use bounded --allow-* flags",
      );
    }
    if (argument.startsWith("-") && !argument.startsWith("--")) {
      const shortFlags = argument.split("=", 1)[0].slice(1);
      if (shortFlags.includes("A")) {
        throw new Error(
          `${source}: -A/--allow-all grants every permission; ` +
            "use bounded --allow-* flags",
        );
      }
    }
  }

  const allowEnv = new Set<string>();
  for (const argument of options) {
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
      if (!shortFlags.slice(1).includes("E")) continue;
      if (shortFlags !== "-E" || value === undefined) {
        throw new Error(
          `${source}: combined or unbounded -E cannot be audited; ` +
            "use --allow-env=KEY,...",
        );
      }
      for (const key of parseAllowEnv(value, source)) allowEnv.add(key);
    }
  }

  return {
    entrypoint: normalizeComposeEntrypoint(script, source),
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
      requiredEnv: dependencyEnvForEntrypoint(parsed.entrypoint),
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
  const masked = [...content];
  let state: "code" | "line" | "block" | "single" | "double" | "template" =
    "code";
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        masked[index] = masked[index + 1] = " ";
        state = "line";
        index++;
      } else if (character === "/" && next === "*") {
        masked[index] = masked[index + 1] = " ";
        state = "block";
        index++;
      } else if (character === "'") {
        masked[index] = " ";
        state = "single";
      } else if (character === '"') {
        masked[index] = " ";
        state = "double";
      } else if (character === "`") {
        masked[index] = " ";
        state = "template";
      }
      continue;
    }

    if (character !== "\n") masked[index] = " ";
    if (state === "line") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        masked[index + 1] = " ";
        state = "code";
        index++;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`")
    ) {
      state = "code";
    }
  }
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
    const match of code.matchAll(/Deno\s*\.\s*env\s*\.\s*get\s*\(/g)
  ) {
    const openParen = match.index + match[0].lastIndexOf("(");
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
