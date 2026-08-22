import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { validateLogSinkRoles } from "./check_log_sink_roles.ts";

const REPO_ROOT = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
).replace(/\/$/, "");
const MANIFEST = "db/log-sink/role-contract.json";

async function validateWithMutation(
  target: string,
  mutate: (text: string) => string,
) {
  const targetPath = `${REPO_ROOT}/${target}`;
  return await validateLogSinkRoles(
    REPO_ROOT,
    MANIFEST,
    async (path) => {
      const original = await Deno.readTextFile(path);
      if (path !== targetPath) return original;
      const mutated = mutate(original);
      assertNotEquals(mutated, original, `mutation did not match ${target}`);
      return mutated;
    },
  );
}

Deno.test("log-sink role validator accepts the repository contract", async () => {
  const result = await validateLogSinkRoles(REPO_ROOT, MANIFEST);
  assertEquals(result.errors, []);
});

Deno.test("log-sink role validator rejects swapped bootstrap secrets", async () => {
  const result = await validateWithMutation(
    "db/log-sink/00-log-sink-roles.sh",
    (text) =>
      text
        .replace(
          '--set=ingester_password="$OPENBRAIN_INGESTER_PASSWORD"',
          '--set=ingester_password="$OPENBRAIN_LOGS_ROLLUP_PASSWORD"',
        )
        .replace(
          '--set=rollup_password="$OPENBRAIN_LOGS_ROLLUP_PASSWORD"',
          '--set=rollup_password="$OPENBRAIN_INGESTER_PASSWORD"',
        ),
  );
  assertStringIncludes(
    result.errors.join("\n"),
    "role bootstrap credential bindings",
  );
});

Deno.test("log-sink role validator rejects a role bound to the wrong psql variable", async () => {
  const result = await validateWithMutation(
    "db/log-sink/00-log-sink-roles.sh",
    (text) =>
      text.replace(
        "PASSWORD :'ingester_password';",
        "PASSWORD :'rollup_password';",
      ),
  );
  assertStringIncludes(
    result.errors.join("\n"),
    "role bootstrap credential bindings",
  );
});

Deno.test("log-sink role validator rejects a miswired Compose secret", async () => {
  const result = await validateWithMutation(
    "deploy/qubes/ingress-qube/docker-compose.yml",
    (text) =>
      text.replace(
        "OPENBRAIN_INGESTER_PASSWORD: ${OPENBRAIN_INGESTER_PASSWORD:",
        "OPENBRAIN_INGESTER_PASSWORD: ${OPENBRAIN_LOGS_ROLLUP_PASSWORD:",
      ),
  );
  assertStringIncludes(
    result.errors.join("\n"),
    "Qubes log-ingester Compose identity sink credential bindings",
  );
});
