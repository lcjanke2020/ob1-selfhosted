#!/usr/bin/env python3
"""Copy stdin to stdout while enforcing byte bounds and optional magic."""

from __future__ import annotations

import sys


def fail(message: str, code: int) -> int:
    print(f"bounded stream: {message}", file=sys.stderr)
    return code


def main() -> int:
    if len(sys.argv) not in (3, 4):
        return fail(
            "usage: ob1-bounded-stream.py MIN_BYTES MAX_BYTES [ASCII_MAGIC]",
            64,
        )

    try:
        minimum = int(sys.argv[1], 10)
        maximum = int(sys.argv[2], 10)
    except ValueError:
        return fail("bounds must be decimal integers", 64)

    if minimum < 0 or maximum < minimum:
        return fail("require 0 <= MIN_BYTES <= MAX_BYTES", 64)

    expected_magic = b""
    if len(sys.argv) == 4:
        try:
            expected_magic = sys.argv[3].encode("ascii")
        except UnicodeEncodeError:
            return fail("magic must contain ASCII bytes only", 64)
        if not expected_magic:
            return fail("magic must not be empty", 64)
        if len(expected_magic) > maximum:
            return fail("magic length must not exceed MAX_BYTES", 64)

    total = 0
    source = sys.stdin.buffer
    destination = sys.stdout.buffer

    try:
        if expected_magic:
            prefix = source.read(len(expected_magic))
            if len(prefix) < len(expected_magic):
                return fail(
                    f"input contained {len(prefix)} bytes, below minimum of {minimum}",
                    66,
                )
            if prefix != expected_magic:
                return fail("input has an unexpected archive signature", 67)
            destination.write(prefix)
            total = len(prefix)

        while True:
            # Once exactly MAX_BYTES have passed, read one more byte. That
            # distinguishes a valid exact-bound stream from a producer that
            # would otherwise be silently truncated by head(1).
            remaining_with_probe = maximum - total + 1
            chunk = source.read(min(64 * 1024, remaining_with_probe))
            if not chunk:
                break
            if total + len(chunk) > maximum:
                return fail(
                    f"input exceeded maximum of {maximum} bytes",
                    65,
                )
            destination.write(chunk)
            total += len(chunk)

        destination.flush()
    except BrokenPipeError:
        # The trusted downstream encryptor failed or closed early. Avoid a
        # traceback; pipefail still rejects the complete backup pipeline.
        return fail("downstream closed before the stream completed", 74)

    if total < minimum:
        return fail(
            f"input contained {total} bytes, below minimum of {minimum}",
            66,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
