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
//      explicit `entrypoint` invokes `deno run`.
//   2. Reject a bare Compose `--allow-env` immediately: it grants the entire
//      container environment rather than a bounded list.
//   3. Walk the relative-import graph from each TypeScript entrypoint,
//      collecting every reachable in-tree .ts file.
//   4. Find string-literal env reads, including the small wrapper set below,
//      and fail if any key is absent from the launcher's allowlist.
//
// Over-permissive entries are generally not flagged. The deno-postgres driver
// reads PG* keys outside this source tree, so token-admin additionally carries
// a launcher policy that pins its bounded TLS/service-file compatibility block.
//
// Run locally: `deno task check-allow-env` (from server/).
// CI: runs as the check-allow-env job in .github/workflows/ci.yml.

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));
const REPO_DIR = resolve(SERVER_DIR, "..");
const DEPLOY_DIR = join(REPO_DIR, "deploy");

// The five DB_* keys are source-visible through token_admin.ts's env() helper.
// The PG* keys are the bounded compatibility block used by deno-postgres,
// including optional TLS and service-file configurations.
export const TOKEN_ADMIN_ALLOW_ENV = [
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD",
  "PGAPPNAME",
  "PGDATABASE",
  "PGHOST",
  "PGOPTIONS",
  "PGPASSWORD",
  "PGPORT",
  "PGUSER",
  "PGSSLMODE",
  "PGSSLCERT",
  "PGSSLKEY",
  "PGSSLROOTCERT",
  "PGREQUIRESSL",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGCONNECT_TIMEOUT",
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
      `${source}: bare --allow-env grants the entire environment; ` +
        "use --allow-env=KEY,...",
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
  const allowMatch = content.match(/--allow-env=([A-Z0-9_,]+)/);
  if (!allowMatch) {
    throw new Error(`No --allow-env= clause in ${dockerfilePath}`);
  }
  const allowEnv = parseAllowEnv(allowMatch[1], dockerfilePath);
  // Entrypoint = last "*.ts" string literal in the CMD line.
  const cmdMatch = content.match(/CMD\s*\[([\s\S]+?)\]/);
  if (!cmdMatch) throw new Error(`No CMD line in ${dockerfilePath}`);
  const tsFiles = [...cmdMatch[1].matchAll(/"([a-zA-Z0-9_.-]+\.ts)"/g)]
    .map((match) => match[1]);
  if (tsFiles.length === 0) {
    throw new Error(`No .ts entrypoint in CMD of ${dockerfilePath}`);
  }
  return { entrypoint: tsFiles[tsFiles.length - 1], allowEnv };
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

function entrypointArguments(value: unknown, source: string): string[] {
  let args: string[];
  if (typeof value === "string") {
    args = splitCommand(value, source);
  } else if (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  ) {
    args = value;
  } else {
    throw new Error(
      `${source}: entrypoint must be a literal string or string list`,
    );
  }
  if (args.some((argument) => argument.includes("${"))) {
    throw new Error(
      `${source}: interpolated entrypoints cannot be audited; use literal arguments`,
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

function normalizeComposeEntrypoint(value: string, source: string): string {
  const portable = value.replaceAll("\\", "/");
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
    if (rawService.entrypoint === undefined || rawService.entrypoint === null) {
      continue;
    }
    const invocation = denoInvocation(
      entrypointArguments(rawService.entrypoint, label),
      label,
    );
    if (!invocation) continue;
    if (invocation.includes("-A") || invocation.includes("--allow-all")) {
      throw new Error(
        `${label}: --allow-all grants the entire environment; ` +
          "use --allow-env=KEY,...",
      );
    }
    const allowArguments = invocation.filter((argument) =>
      argument === "--allow-env" || argument.startsWith("--allow-env=")
    );
    if (allowArguments.some((argument) => argument === "--allow-env")) {
      throw new Error(
        `${label}: bare --allow-env grants the entire environment; ` +
          "use --allow-env=KEY,...",
      );
    }
    const allowEnv = new Set<string>();
    for (const argument of allowArguments) {
      for (
        const key of parseAllowEnv(argument.slice("--allow-env=".length), label)
      ) {
        allowEnv.add(key);
      }
    }
    const script = invocation.filter((argument) =>
      !argument.startsWith("-") && /\.ts(?:[?#].*)?$/.test(argument)
    ).at(-1);
    if (!script) {
      throw new Error(`${label}: deno run entrypoint has no .ts module`);
    }
    const entrypoint = normalizeComposeEntrypoint(script, label);
    targets.push({
      source: label,
      entrypoint,
      allowEnv,
      requiredEnv: entrypoint === "token_admin.ts"
        ? new Set(TOKEN_ADMIN_ALLOW_ENV)
        : undefined,
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

export function findEnvReads(filePath: string): Set<string> {
  const content = Deno.readTextFileSync(filePath);
  const reads = new Set<string>();
  for (
    const match of content.matchAll(
      /Deno\.env\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
    )
  ) {
    reads.add(match[1]);
  }
  for (const name of WRAPPER_NAMES) {
    const pattern = new RegExp(
      String.raw`\b${name}\(\s*["']([A-Z][A-Z0-9_]*)["']`,
      "g",
    );
    for (const match of content.matchAll(pattern)) reads.add(match[1]);
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
