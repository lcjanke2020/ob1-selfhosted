// One length-safe wrapper around the platform constant-time primitive. Callers
// use strings for the static key and bytes for fixed-length token digests.

import { timingSafeEqual } from "node:crypto";

export function constantTimeEqual(
  provided: string,
  expected: string,
): boolean;
export function constantTimeEqual(
  provided: Uint8Array,
  expected: Uint8Array,
): boolean;
export function constantTimeEqual(
  provided: string | Uint8Array,
  expected: string | Uint8Array,
): boolean {
  if (typeof provided === "string" && typeof expected === "string") {
    const sameLength = provided.length === expected.length;
    const supplied = utf16Bytes(provided, expected.length);
    const wanted = utf16Bytes(expected, expected.length);
    const matches = timingSafeEqual(supplied, wanted);
    return (Number(matches) & Number(sameLength)) === 1;
  }

  if (provided instanceof Uint8Array && expected instanceof Uint8Array) {
    // timingSafeEqual requires equal byte lengths. Copy only the expected
    // number of bytes in a fixed-length loop, padding a short value with zeroes
    // and truncating a long one. Do not let TypedArray#set reintroduce work
    // proportional to a short provided length before the platform comparison.
    const sameLength = provided.byteLength === expected.byteLength;
    const supplied = new Uint8Array(expected.byteLength);
    for (let i = 0; i < expected.byteLength; i++) {
      supplied[i] = provided[i] ?? 0;
    }
    const matches = timingSafeEqual(supplied, expected);
    return (Number(matches) & Number(sameLength)) === 1;
  }

  throw new TypeError(
    "constantTimeEqual inputs must use the same representation",
  );
}

// Preserve exact JavaScript-string equality, including unpaired UTF-16
// surrogates. TextEncoder would replace those with U+FFFD and could make two
// distinct strings encode identically.
function utf16Bytes(value: string, codeUnits: number): Uint8Array {
  const bytes = new Uint8Array(codeUnits * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < codeUnits; i++) {
    view.setUint16(i * 2, value.charCodeAt(i) || 0, false);
  }
  return bytes;
}
