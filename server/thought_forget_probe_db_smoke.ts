// Called only by the disposable DB-init grants smoke. Runs the real boot probe
// as openbrain_app against a catalog the smoke has just drifted ("refuse") or
// converged ("ready"): every forget/restore drift the grants assertion
// rejects must also stop the server from booting.
import { assertRejects, assertStringIncludes } from "@std/assert";
import { Pool } from "postgres";
import { probeDbAtBoot } from "./db_boot_probe.ts";
const host = Deno.env.get("DB_SMOKE_HOST") ?? "127.0.0.1";
const port = Number(Deno.env.get("DB_SMOKE_PORT") ?? "55439");
const pool = new Pool({
  hostname: host,
  port,
  database: "openbrain",
  user: "openbrain_app",
  password: Deno.env.get("OPENBRAIN_APP_PASSWORD")!,
}, 1);
try {
  if (Deno.args[0] === "ready") await probeDbAtBoot(pool, "forget-drift");
  else {
    const error = await assertRejects(
      () => probeDbAtBoot(pool, "forget-drift"),
      Error,
    );
    assertStringIncludes(error.message, "forget/restore schema");
    assertStringIncludes(error.message, "db/17-forget-thoughts.sql");
  }
} finally {
  await pool.end();
}
