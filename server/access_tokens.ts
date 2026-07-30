// Native access-token lifecycle for deployments without an OIDC issuer.
//
// Plaintext tokens exist only in the caller that creates them. PostgreSQL
// stores a fixed-length SHA-256 digest plus a short public prefix and label.
// Authentication uses the prefix for one bounded lookup, then compares the
// presented digest with the stored digest in constant time. Unknown prefixes
// still perform the same digest comparison against a fixed dummy value.

import { timingSafeEqual } from "node:crypto";
import type { Pool } from "postgres";
import {
  isNativeTokenLabel,
  MAX_NATIVE_TOKEN_LABEL_LENGTH,
} from "./auth_context.ts";
import { getClient } from "./db_pool.ts";

const TOKEN_PREFIX_RANDOM_BYTES = 6;
const TOKEN_SECRET_RANDOM_BYTES = 32;
const TOKEN_PREFIX_BODY_LENGTH = 8;
const TOKEN_SECRET_LENGTH = 43;
const TOKEN_PREFIX_PATTERN = /^ob1_[A-Za-z0-9_-]{8}$/;
const TOKEN_PATTERN = /^ob1_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;
const TOKEN_HASH_BYTES = 32;

// A fixed 32-byte value keeps the comparison path intact when the public
// prefix is unknown. It need not be secret; it only prevents the lookup miss
// from skipping the constant-time digest comparison entirely.
const UNKNOWN_TOKEN_HASH = new Uint8Array(TOKEN_HASH_BYTES);

export type NativeTokenIdentity = {
  label: string;
};

export type AccessTokenMetadata = {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
};

export type CreatedAccessToken = Omit<AccessTokenMetadata, "revoked_at"> & {
  token: string;
};

type RandomBytes = (length: number) => Uint8Array;

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function normalizeAccessTokenLabel(value: string): string {
  const label = value.trim();
  if (!label || [...label].length > MAX_NATIVE_TOKEN_LABEL_LENGTH) {
    throw new Error(
      `token label must contain 1-${MAX_NATIVE_TOKEN_LABEL_LENGTH} Unicode code points after trimming`,
    );
  }
  if (!isNativeTokenLabel(label)) {
    throw new Error(
      "token label must not contain control characters or unpaired UTF-16 surrogates",
    );
  }
  return label;
}

function accessTokenLabelFromStore(value: unknown): string {
  if (!isNativeTokenLabel(value)) {
    throw new Error("token store returned an invalid label");
  }
  return value;
}

export function normalizeAccessTokenPrefix(value: string): string {
  const prefix = value.trim();
  if (!TOKEN_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `token prefix must have the form ob1_${
        "x".repeat(TOKEN_PREFIX_BODY_LENGTH)
      }`,
    );
  }
  return prefix;
}

export function generateAccessToken(
  randomBytes: RandomBytes = secureRandomBytes,
): { token: string; prefix: string } {
  const prefixBody = base64Url(randomBytes(TOKEN_PREFIX_RANDOM_BYTES));
  const secret = base64Url(randomBytes(TOKEN_SECRET_RANDOM_BYTES));
  if (
    prefixBody.length !== TOKEN_PREFIX_BODY_LENGTH ||
    secret.length !== TOKEN_SECRET_LENGTH
  ) {
    throw new Error("secure random source returned an invalid byte count");
  }
  const prefix = `ob1_${prefixBody}`;
  return { prefix, token: `${prefix}_${secret}` };
}

export async function hashAccessToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

function tokenPrefix(token: string): string | null {
  const match = TOKEN_PATTERN.exec(token);
  return match ? `ob1_${match[1]}` : null;
}

function isStoredHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === TOKEN_HASH_BYTES;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new Error("token store returned an invalid timestamp");
}

type AuthenticationRow = {
  token_hash: Uint8Array;
  label: string;
  revoked_at: Date | string | null;
};

export async function authenticateAccessToken(
  pool: Pool,
  token: string,
): Promise<NativeTokenIdentity | null> {
  const prefix = tokenPrefix(token);
  if (!prefix) return null;

  // Hash before the lookup so known and unknown prefixes both pay the fixed
  // digest cost. The only early rejection is the public token-format check.
  const presentedHash = await hashAccessToken(token);
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<AuthenticationRow>(
      `SELECT token_hash, label, revoked_at
       FROM native_auth.access_token
       WHERE prefix = $1`,
      [prefix],
    );
    const row = result.rows[0];
    const expectedHash = row && isStoredHash(row.token_hash)
      ? row.token_hash
      : UNKNOWN_TOKEN_HASH;
    const matches = timingSafeEqual(presentedHash, expectedHash);
    if (!matches || !row || row.revoked_at !== null) return null;

    try {
      return { label: accessTokenLabelFromStore(row.label) };
    } catch {
      // A malformed label means the database invariant drifted. Never let it
      // enter durable provenance; authentication fails closed.
      return null;
    }
  } finally {
    client.release();
  }
}

type TokenMetadataRow = {
  id: bigint | number | string;
  prefix: string;
  label: string;
  created_at: Date | string;
  revoked_at?: Date | string | null;
};

function metadataFromRow(row: TokenMetadataRow): AccessTokenMetadata {
  return {
    id: String(row.id),
    prefix: normalizeAccessTokenPrefix(row.prefix),
    label: accessTokenLabelFromStore(row.label),
    created_at: timestamp(row.created_at),
    revoked_at: row.revoked_at == null ? null : timestamp(row.revoked_at),
  };
}

export async function createAccessToken(
  pool: Pool,
  rawLabel: string,
  randomBytes: RandomBytes = secureRandomBytes,
): Promise<CreatedAccessToken> {
  const label = normalizeAccessTokenLabel(rawLabel);
  const { token, prefix } = generateAccessToken(randomBytes);
  const tokenHash = await hashAccessToken(token);
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<TokenMetadataRow>(
      `SELECT id, prefix, label, created_at
       FROM native_auth.register_access_token($1, $2, $3)`,
      [prefix, tokenHash, label],
    );
    const row = result.rows[0];
    if (!row) throw new Error("token registration returned no row");
    const metadata = metadataFromRow({ ...row, revoked_at: null });
    return {
      id: metadata.id,
      prefix: metadata.prefix,
      label: metadata.label,
      created_at: metadata.created_at,
      token,
    };
  } finally {
    client.release();
  }
}

export async function listAccessTokens(
  pool: Pool,
): Promise<AccessTokenMetadata[]> {
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<TokenMetadataRow>(
      `SELECT id, prefix, label, created_at, revoked_at
       FROM native_auth.access_token
       ORDER BY created_at DESC, id DESC`,
    );
    return result.rows.map(metadataFromRow);
  } finally {
    client.release();
  }
}

export async function revokeAccessToken(
  pool: Pool,
  rawPrefix: string,
): Promise<AccessTokenMetadata | null> {
  const prefix = normalizeAccessTokenPrefix(rawPrefix);
  const client = await getClient(pool);
  try {
    const result = await client.queryObject<TokenMetadataRow>(
      `SELECT id, prefix, label, created_at, revoked_at
       FROM native_auth.revoke_access_token($1)`,
      [prefix],
    );
    const row = result.rows[0];
    return row ? metadataFromRow(row) : null;
  } finally {
    client.release();
  }
}
