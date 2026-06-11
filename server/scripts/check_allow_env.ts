// Static check that every env var read at runtime is
// declared in the corresponding Dockerfile's --allow-env= list.
//
// Why this exists: `deno task test` runs with unrestricted --allow-env so
// per-PR tests don't notice when a new Deno.env.get("NEW_KEY") is added
// without the matching Dockerfile update. The production container then
// boots and crashes with `NotCapable: Requires env access to "NEW_KEY"`.
// A 2026-05 production deploy hit exactly this slip-through
// for `OBS_AUTH_EVENTS_MAX_IN_FLIGHT`.
//
// Algorithm:
//   1. For each Dockerfile (mcp + ingester), parse the --allow-env=… list
//      and identify the entrypoint .ts file from the CMD line.
//   2. Walk the relative-import graph from that entrypoint, collecting all
//      reachable in-tree .ts files.
//   3. In each reachable file, find every string-literal env read:
//        - `Deno.env.get("KEY")`
//        - `required("KEY")`, `requiredInt("KEY", ...)`, `optionalTrimmed("KEY")`,
//          `optional("KEY", ...)`, `optionalInt("KEY", ...)`
//        (the wrappers are defined in config.ts and log_ingester.ts; they
//        all internally call Deno.env.get with their first arg.)
//   4. Fail if any reachable read is not in the Dockerfile's --allow-env list.
//
// Over-permissive Dockerfile entries (declared but not read) are intentional
// and not flagged — the deno-postgres driver reads the PG* family from the
// environment at Pool construction and would crash on NotCapable for any
// missing entry. Allowing reads we don't perform is the safer default than
// withholding them.
//
// Run locally: `deno task check-allow-env` (from server/).
// CI: runs as the check-allow-env job in .github/workflows/ci.yml.

import {
  dirname,
  fromFileUrl,
  join,
  relative,
  resolve,
} from "jsr:@std/path@^1.0.8";

// Resolve the server directory from this script's location. `fromFileUrl`
// returns a real filesystem path on every platform — using `.pathname`
// directly would leave URL-encoded characters (spaces → `%20`, etc.) in
// the string and break `Deno.readTextFileSync` on any repo path that
// isn't strictly URL-safe.
const SERVER_DIR = fromFileUrl(new URL("..", import.meta.url));

// Hardcoded list of env-reading wrapper functions used in this codebase.
// Each takes the env-var name as its first argument. If a new wrapper is
// added, append it here so the static check covers its call sites.
const WRAPPER_NAMES = [
  "required",
  "requiredInt",
  "optionalTrimmed",
  "optional",
  "optionalInt",
];

interface CheckTarget {
  dockerfile: string;
  entrypoint: string;
  allowEnv: Set<string>;
}

function parseDockerfile(dockerfilePath: string): {
  entrypoint: string;
  allowEnv: Set<string>;
} {
  const content = Deno.readTextFileSync(dockerfilePath);
  const allowMatch = content.match(/--allow-env=([A-Z0-9_,]+)/);
  if (!allowMatch) {
    throw new Error(`No --allow-env= clause in ${dockerfilePath}`);
  }
  const allowEnv = new Set(
    allowMatch[1].split(",").map((s) => s.trim()).filter(Boolean),
  );
  // Entrypoint = last "*.ts" string literal in the CMD line.
  const cmdMatch = content.match(/CMD\s*\[([\s\S]+?)\]/);
  if (!cmdMatch) throw new Error(`No CMD line in ${dockerfilePath}`);
  const tsFiles = [...cmdMatch[1].matchAll(/"([a-zA-Z0-9_.-]+\.ts)"/g)]
    .map((m) => m[1]);
  if (tsFiles.length === 0) {
    throw new Error(`No .ts entrypoint in CMD of ${dockerfilePath}`);
  }
  return { entrypoint: tsFiles[tsFiles.length - 1], allowEnv };
}

function walkImports(entrypoint: string, baseDir: string): Set<string> {
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
    } catch (e) {
      throw new Error(`Failed to read ${full}: ${(e as Error).message}`);
    }
    // Match every `from "..."` regardless of single-line vs multi-line import.
    const fromMatches = content.matchAll(/from\s+["']([^"']+)["']/g);
    for (const m of fromMatches) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue; // skip npm:, jsr:, https:, etc.
      let resolved = spec;
      if (!resolved.endsWith(".ts")) resolved += ".ts";
      const importerDir = dirname(file);
      const target = relative(
        baseDir,
        resolve(join(baseDir, importerDir), resolved),
      ).replaceAll("\\", "/");
      queue.push(target);
    }
  }
  return visited;
}

function findEnvReads(filePath: string): Set<string> {
  const content = Deno.readTextFileSync(filePath);
  const reads = new Set<string>();
  // Direct `Deno.env.get("KEY")` calls.
  for (
    const m of content.matchAll(
      /Deno\.env\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
    )
  ) {
    reads.add(m[1]);
  }
  // Wrapper-function call sites: `wrapperName("KEY", ...)`.
  for (const name of WRAPPER_NAMES) {
    const pattern = new RegExp(
      String.raw`\b${name}\(\s*["']([A-Z][A-Z0-9_]*)["']`,
      "g",
    );
    for (const m of content.matchAll(pattern)) {
      reads.add(m[1]);
    }
  }
  return reads;
}

const targets: CheckTarget[] = [
  {
    dockerfile: "Dockerfile",
    ...parseDockerfile(join(SERVER_DIR, "Dockerfile")),
  },
  {
    dockerfile: "Dockerfile.ingester",
    ...parseDockerfile(join(SERVER_DIR, "Dockerfile.ingester")),
  },
];

let drift = false;
for (const t of targets) {
  const files = walkImports(t.entrypoint, SERVER_DIR);
  const reads = new Set<string>();
  for (const f of files) {
    for (const key of findEnvReads(join(SERVER_DIR, f))) reads.add(key);
  }
  const missing = [...reads].filter((k) => !t.allowEnv.has(k)).sort();
  if (missing.length > 0) {
    drift = true;
    console.error(
      `✗ ${t.dockerfile}: --allow-env missing keys reachable from ${t.entrypoint}:`,
    );
    for (const k of missing) console.error(`    ${k}`);
    console.error(
      `  (${reads.size} static reads in ${files.size} reachable files; ` +
        `${t.allowEnv.size} keys declared in --allow-env)`,
    );
  } else {
    console.log(
      `✓ ${t.dockerfile}: --allow-env covers all ${reads.size} static reads ` +
        `in ${files.size} reachable files (entrypoint ${t.entrypoint}, ` +
        `${t.allowEnv.size} declared keys)`,
    );
  }
}

if (drift) {
  console.error(
    "\nAdd missing keys to the appropriate Dockerfile --allow-env= list, " +
      "or remove the unused Deno.env.get/wrapper call.",
  );
  Deno.exit(1);
}
