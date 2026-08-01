// Native-launcher preflight for the real server entrypoint. Static analysis
// covers every reachable source read plus explicit out-of-tree dependency keys;
// permission queries verify the systemd allowlist without opening a database or
// network socket. Importing config.ts then retains its value-validation checks.
// Run with --allow-read=. and the exact --allow-env= list from ExecStart.

import { analyzeTarget } from "./check_allow_env.ts";

const entrypoint = "index.ts";
const analysis = analyzeTarget({
  source: "native index.ts launcher",
  entrypoint,
  allowEnv: new Set(),
});
if (Deno.permissions.querySync({ name: "env" }).state === "granted") {
  throw new Error(
    "Run this probe with the launcher's bounded --allow-env=KEY,... list, " +
      "not -A or a bare -E/--allow-env grant",
  );
}
const denied = [...analysis.required].filter((key) =>
  Deno.permissions.querySync({ name: "env", variable: key }).state !== "granted"
).sort();

if (denied.length > 0) {
  throw new Error(
    "Native launcher --allow-env is missing keys required by index.ts:\n" +
      denied.map((key) => `  ${key}`).join("\n"),
  );
}

await import("../config.ts");

console.log(
  `CONFIG AND ENTRYPOINT PERMISSIONS OK (${analysis.required.size} env keys)`,
);
