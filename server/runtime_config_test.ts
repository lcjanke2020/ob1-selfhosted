import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  DEFAULT_AUTH_AUDIT_MAX_IN_FLIGHT,
  DEFAULT_AUTH_BODY_READ_TIMEOUT_MS,
  DEFAULT_DB_PORT,
  MAX_TIMER_DELAY_MS,
  parseAuthAuditRuntimeConfig,
  parseAuthRuntimeConfig,
  parseBooleanSetting,
  parseDbPort,
  parsePositiveIntegerSetting,
} from "./runtime_config.ts";

Deno.test("runtime config: DB_PORT has one complete-decimal 1-65535 contract", () => {
  assertEquals(parseDbPort(undefined), DEFAULT_DB_PORT);
  assertEquals(parseDbPort(""), DEFAULT_DB_PORT);
  assertEquals(parseDbPort(" 6543 "), 6543);
  assertEquals(parseDbPort("65535"), 65_535);

  for (const value of ["5432abc", "1e3", "0", "-1", "65536"]) {
    const error = assertThrows(() => parseDbPort(value), Error);
    assertStringIncludes(error.message, "DB_PORT");
  }
});

Deno.test("runtime config: positive integers are complete, safe, and bounded", () => {
  assertEquals(parsePositiveIntegerSetting("COUNT", undefined, 7), 7);
  assertEquals(parsePositiveIntegerSetting("COUNT", "42", 7, 42), 42);
  assertThrows(
    () => parsePositiveIntegerSetting("COUNT", "42x", 7),
    Error,
    "complete positive decimal integer",
  );
  assertThrows(
    () => parsePositiveIntegerSetting("COUNT", "43", 7, 42),
    Error,
    "no greater than 42",
  );
});

Deno.test("runtime config: booleans accept only true/false with per-process defaults", () => {
  assertEquals(parseBooleanSetting("FLAG", undefined, false), false);
  assertEquals(parseBooleanSetting("FLAG", "", true), true);
  assertEquals(parseBooleanSetting("FLAG", " TRUE ", false), true);
  assertEquals(parseBooleanSetting("FLAG", "false", true), false);
  const error = assertThrows(
    () => parseBooleanSetting("FLAG", "enabled", false),
    Error,
    "FLAG must be true or false",
  );
  assertEquals(error.message.includes("enabled"), false);
});

Deno.test("runtime config: auth and audit typed surfaces retain defaults", () => {
  assertEquals(parseAuthRuntimeConfig({}), {
    bodyReadTimeoutMs: DEFAULT_AUTH_BODY_READ_TIMEOUT_MS,
  });
  assertEquals(
    parseAuthRuntimeConfig({ bodyReadTimeoutMs: String(MAX_TIMER_DELAY_MS) }),
    { bodyReadTimeoutMs: MAX_TIMER_DELAY_MS },
  );
  assertThrows(
    () => parseAuthRuntimeConfig({ bodyReadTimeoutMs: "2000ms" }),
    Error,
    "AUTH_BODY_READ_TIMEOUT_MS",
  );

  assertEquals(parseAuthAuditRuntimeConfig({}), {
    enabled: true,
    maxInFlight: DEFAULT_AUTH_AUDIT_MAX_IN_FLIGHT,
  });
  assertEquals(
    parseAuthAuditRuntimeConfig({ enabled: "false", maxInFlight: "3" }),
    { enabled: false, maxInFlight: 3 },
  );
  assertThrows(
    () => parseAuthAuditRuntimeConfig({ enabled: "sometimes" }),
    Error,
    "OBS_AUTH_EVENTS_ENABLED",
  );
  assertThrows(
    () => parseAuthAuditRuntimeConfig({ maxInFlight: "500events" }),
    Error,
    "OBS_AUTH_EVENTS_MAX_IN_FLIGHT",
  );
});
