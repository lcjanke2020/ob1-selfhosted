import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import type { Pool } from "postgres";
import {
  authenticateAccessToken,
  createAccessToken,
  generateAccessToken,
  hashAccessToken,
  listAccessTokens,
  normalizeAccessTokenLabel,
  normalizeAccessTokenPrefix,
  revokeAccessToken,
} from "./access_tokens.ts";
import { makeFakePool } from "./api_test_support.ts";

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

Deno.test("native token generation uses a public prefix and 256-bit secret", () => {
  const { token, prefix } = generateAccessToken(deterministicBytes);
  assertEquals(prefix, "ob1_AAECAwQF");
  assertMatch(token, /^ob1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  assertEquals(token.startsWith(`${prefix}_`), true);
  assertEquals(token.length, 56);
});

Deno.test("native token label and prefix validation are bounded", () => {
  assertEquals(normalizeAccessTokenLabel("  nightly agent  "), "nightly agent");
  assertEquals(
    normalizeAccessTokenLabel("\u00a0nightly agent\u00a0"),
    "nightly agent",
  );
  assertEquals(
    normalizeAccessTokenLabel("😀".repeat(65)),
    "😀".repeat(65),
  );
  assertEquals(normalizeAccessTokenPrefix(" ob1_AAECAwQF "), "ob1_AAECAwQF");
  assertThrows(
    () => normalizeAccessTokenLabel("bad\nlabel"),
    Error,
    "control characters",
  );
  assertThrows(
    () => normalizeAccessTokenLabel("bad\u0085label"),
    Error,
    "control characters",
  );
  assertThrows(
    () => normalizeAccessTokenLabel("bad\ud800label"),
    Error,
    "unpaired UTF-16 surrogates",
  );
  assertThrows(
    () => normalizeAccessTokenLabel("x".repeat(129)),
    Error,
    "1-128",
  );
  assertThrows(
    () => normalizeAccessTokenLabel("😀".repeat(129)),
    Error,
    "1-128",
  );
  assertThrows(
    () => normalizeAccessTokenPrefix("ob1_short"),
    Error,
    "form",
  );
});

Deno.test("create persists only hash + metadata and reveals plaintext after registration", async () => {
  let registeredParams: unknown[] = [];
  const { pool, client } = makeFakePool((sql, params) => {
    assert(sql.includes("native_auth.register_access_token"));
    registeredParams = params;
    return {
      rows: [{
        id: 7n,
        prefix: params[0],
        label: params[2],
        created_at: "2026-07-30T10:00:00.000Z",
      }],
    };
  });

  const result = await createAccessToken(
    pool,
    " nightly agent ",
    deterministicBytes,
  );
  assertEquals(result.id, "7");
  assertEquals(result.prefix, "ob1_AAECAwQF");
  assertEquals(result.label, "nightly agent");
  assertMatch(result.token, /^ob1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
  assertEquals(registeredParams[0], result.prefix);
  assert(registeredParams[1] instanceof Uint8Array);
  assertEquals((registeredParams[1] as Uint8Array).byteLength, 32);
  assertEquals(registeredParams[2], result.label);
  assertNotEquals(registeredParams.includes(result.token), true);
  assertEquals(
    registeredParams[1],
    await hashAccessToken(result.token),
  );
  assertEquals(client.releaseCalls, 1);
});

Deno.test("authenticate performs a fresh prefix lookup and rejects immediately after revoke", async () => {
  const { token, prefix } = generateAccessToken(deterministicBytes);
  const tokenHash = await hashAccessToken(token);
  let revoked = false;
  let lookups = 0;
  const { pool, client } = makeFakePool((sql, params) => {
    assert(sql.includes("FROM native_auth.access_token"));
    assertEquals(params, [prefix]);
    lookups++;
    return {
      rows: [{
        token_hash: tokenHash,
        label: "nightly agent",
        revoked_at: revoked ? "2026-07-30T10:01:00.000Z" : null,
      }],
    };
  });

  assertEquals(await authenticateAccessToken(pool, token), {
    label: "nightly agent",
  });
  revoked = true;
  assertEquals(await authenticateAccessToken(pool, token), null);
  assertEquals(lookups, 2, "no per-request credential result may be cached");
  assertEquals(client.releaseCalls, 2);
});

Deno.test("authenticate rejects malformed, unknown, and hash-mismatched tokens", async () => {
  let connects = 0;
  const malformedPool = {
    connect: () => {
      connects++;
      throw new Error("must not connect");
    },
  } as unknown as Pool;
  assertEquals(
    await authenticateAccessToken(malformedPool, "not-a-token"),
    null,
  );
  assertEquals(connects, 0);

  const { token } = generateAccessToken(deterministicBytes);
  const unknown = makeFakePool(() => ({ rows: [] }));
  assertEquals(await authenticateAccessToken(unknown.pool, token), null);
  assertEquals(unknown.client.releaseCalls, 1);

  const mismatch = makeFakePool(() => ({
    rows: [{
      token_hash: new Uint8Array(32).fill(9),
      label: "other client",
      revoked_at: null,
    }],
  }));
  assertEquals(await authenticateAccessToken(mismatch.pool, token), null);

  const tokenHash = await hashAccessToken(token);
  const malformedLabel = makeFakePool(() => ({
    rows: [{
      token_hash: tokenHash,
      label: "\u00a0padded in storage\u00a0",
      revoked_at: null,
    }],
  }));
  assertEquals(await authenticateAccessToken(malformedLabel.pool, token), null);
});

Deno.test("list never selects hashes and revoke targets one validated prefix", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const { pool, client } = makeFakePool((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("revoke_access_token")) {
      return {
        rows: [{
          id: 9n,
          prefix: "ob1_AAECAwQF",
          label: "nightly agent",
          created_at: "2026-07-30T10:00:00.000Z",
          revoked_at: "2026-07-30T10:02:00.000Z",
        }],
      };
    }
    return {
      rows: [{
        id: 9n,
        prefix: "ob1_AAECAwQF",
        label: "nightly agent",
        created_at: "2026-07-30T10:00:00.000Z",
        revoked_at: null,
      }],
    };
  });

  const listed = await listAccessTokens(pool);
  assertEquals(listed[0].revoked_at, null);
  assertEquals(calls[0].sql.includes("token_hash"), false);

  const revoked = await revokeAccessToken(pool, "ob1_AAECAwQF");
  assertEquals(revoked?.revoked_at, "2026-07-30T10:02:00.000Z");
  assertEquals(calls[1].params, ["ob1_AAECAwQF"]);
  assertEquals(client.releaseCalls, 2);
});
