// Operator-only CLI for native access tokens.
//
// The compose `token-admin` profile runs this module with the dedicated
// openbrain_token_admin credential. It never receives the application or
// database-superuser password. Plaintext is printed only by `create`, after
// the hash-only registration transaction succeeds.

import { Pool } from "postgres";
import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "./access_tokens.ts";

function env(name: string, fallback?: string): string {
  const value = Deno.env.get(name)?.trim() || fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function port(): number {
  const raw = env("DB_PORT", "5432");
  if (!/^[0-9]+$/.test(raw)) throw new Error("DB_PORT must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("DB_PORT must be between 1 and 65535");
  }
  return value;
}

function usage(): string {
  return `Usage:
  token-admin create <label> [--json]
  token-admin list [--json]
  token-admin revoke <prefix> [--json]`;
}

function printHumanCreated(
  result: Awaited<ReturnType<typeof createAccessToken>>,
) {
  console.log("Token created. Copy it now; it will not be shown again.");
  console.log(`Label:   ${result.label}`);
  console.log(`Prefix:  ${result.prefix}`);
  console.log(`Token:   ${result.token}`);
  console.log("Header:  x-brain-key: <token>");
}

function printHumanList(
  rows: Awaited<ReturnType<typeof listAccessTokens>>,
): void {
  if (rows.length === 0) {
    console.log("No native access tokens exist.");
    return;
  }
  console.log("PREFIX\tSTATE\tLABEL\tCREATED_AT\tREVOKED_AT");
  for (const row of rows) {
    console.log(
      `${row.prefix}\t${
        row.revoked_at ? "revoked" : "active"
      }\t${row.label}\t${row.created_at}\t${row.revoked_at ?? "-"}`,
    );
  }
}

export async function runTokenAdmin(
  args: string[],
  pool: Pool,
): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const [command, value, ...extra] = positional;
  if (!command || extra.length > 0) {
    console.error(usage());
    return 2;
  }

  if (command === "create") {
    if (!value) {
      console.error(usage());
      return 2;
    }
    const result = await createAccessToken(pool, value);
    if (json) console.log(JSON.stringify(result));
    else printHumanCreated(result);
    return 0;
  }

  if (command === "list") {
    if (value) {
      console.error(usage());
      return 2;
    }
    const rows = await listAccessTokens(pool);
    if (json) console.log(JSON.stringify(rows));
    else printHumanList(rows);
    return 0;
  }

  if (command === "revoke") {
    if (!value) {
      console.error(usage());
      return 2;
    }
    const result = await revokeAccessToken(pool, value);
    if (!result) {
      console.error(`No active token with prefix ${value}.`);
      return 1;
    }
    if (json) console.log(JSON.stringify(result));
    else console.log(`Token revoked: ${result.prefix} (${result.label})`);
    return 0;
  }

  console.error(usage());
  return 2;
}

async function main(): Promise<number> {
  const pool = new Pool(
    {
      hostname: env("DB_HOST", "127.0.0.1"),
      port: port(),
      database: env("DB_NAME", "openbrain"),
      user: env("DB_USER", "openbrain_token_admin"),
      password: env("DB_PASSWORD"),
    },
    1,
  );
  try {
    return await runTokenAdmin(Deno.args, pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    // Do not interpolate command arguments or generated plaintext into errors.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[token-admin] ${message}`);
    Deno.exit(1);
  }
}
