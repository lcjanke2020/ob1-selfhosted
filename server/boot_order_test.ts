// Startup-order regression test: boots the REAL entrypoint (index.ts) as a
// subprocess against a refused DB port and asserts the fail-fast contract —
//
//   1. exit code 1,
//   2. the operator-facing `[db]` guidance lines are present,
//   3. the HTTP port is never bound (no "listening on" line — the db.ts
//      top-level-awaited probe must gate module evaluation, so index.ts
//      never reaches its posture lines or Deno.serve).
//
// Subprocess-shaped on purpose: db.ts gates boot with a module-load
// top-level await + Deno.exit(1), so no test may value-import it (or
// mcp-server.ts / index.ts) in-process — the import would exit the test
// runner. This is also the guard a future refactor cannot dodge: turning
// the probe back into fire-and-forget makes assertion 3 fail (the port
// binds before the probe settles).
//
// Requires --allow-run=deno in the test task (the only binary spawned is
// Deno). Keep the command name: on package-managed installs Deno.execPath()
// can resolve to a versioned Cellar path that does not match the name-based
// grant. setup-deno CI installs a plain binary, so it cannot catch a revert.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// Nothing listens here — connections are refused immediately.
const REFUSED_DB = { DB_HOST: "127.0.0.1", DB_PORT: "59999" };

Deno.test("boot order: unreachable DB → [db] error + exit 1 before the port binds", async () => {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--frozen",
      "--allow-net",
      "--allow-env",
      "--allow-read=.",
      "index.ts",
    ],
    cwd: import.meta.dirname!,
    env: {
      ...REFUSED_DB,
      DB_NAME: "openbrain",
      DB_USER: "x",
      DB_PASSWORD: "x",
      MCP_ACCESS_KEY: "k".repeat(64),
      PORT: "18797",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  // Kill switch: if a regression makes the server boot and keep serving,
  // fail via the assertions below instead of hanging the suite.
  const killer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, 20_000);
  const { code, stdout, stderr } = await child.output();
  clearTimeout(killer);
  const output = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);

  assertEquals(code, 1, `expected exit 1, got ${code}; output:\n${output}`);
  assertStringIncludes(
    output,
    "[db] Postgres at 127.0.0.1:59999 is unreachable",
  );
  assertStringIncludes(output, "[db] exiting");
  assert(
    !output.toLowerCase().includes("listening on"),
    `port bound before the DB fail-fast; output:\n${output}`,
  );
});
