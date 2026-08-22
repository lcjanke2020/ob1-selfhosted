import { assertEquals } from "@std/assert";
import { constantTimeEqual } from "./constant_time.ts";

Deno.test("constantTimeEqual: strings are exact and length-safe", () => {
  assertEquals(constantTimeEqual("correct horse", "correct horse"), true);
  assertEquals(constantTimeEqual("correct horsf", "correct horse"), false);
  assertEquals(constantTimeEqual("correct", "correct horse"), false);
  assertEquals(
    constantTimeEqual("correct horse extra", "correct horse"),
    false,
  );
  assertEquals(constantTimeEqual("\ud800", "\ud800"), true);
  assertEquals(constantTimeEqual("\ud801", "\ud800"), false);
});

Deno.test("constantTimeEqual: byte digests share the same contract", () => {
  assertEquals(
    constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    true,
  );
  assertEquals(
    constantTimeEqual(new Uint8Array([1, 2, 4]), new Uint8Array([1, 2, 3])),
    false,
  );
  assertEquals(
    constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])),
    false,
  );
  assertEquals(
    constantTimeEqual(new Uint8Array([1, 2, 3, 0]), new Uint8Array([1, 2, 3])),
    false,
  );
});
