-- Live-catalog smoke for db/08-access-tokens.sql. Run as the database owner.
-- Every mutation is rolled back.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL ROLE openbrain_token_admin;

SELECT id, prefix, label, created_at
FROM native_auth.register_access_token(
  'ob1_AAAAAAAA',
  decode(repeat('11', 32), 'hex'),
  'ci-client'
);

-- SQL and JavaScript both count Unicode code points, so 65 astral characters
-- are within the 128-code-point bound even though JavaScript stores 130 UTF-16
-- code units. Direct registration must also reject the exact whitespace and
-- control cases the runtime rejects.
DO $block$
DECLARE
  astral_label text := repeat(U&'\+01F600', 65);
BEGIN
  PERFORM * FROM native_auth.register_access_token(
    'ob1_UNICODE1',
    decode(repeat('33', 32), 'hex'),
    astral_label
  );
  IF NOT EXISTS (
    SELECT 1
    FROM native_auth.access_token
    WHERE prefix = 'ob1_UNICODE1'
      AND label = astral_label
      AND char_length(label) = 65
  ) THEN
    RAISE EXCEPTION 'database did not preserve a valid astral token label';
  END IF;

  BEGIN
    PERFORM * FROM native_auth.register_access_token(
      'ob1_TOOLONG1',
      decode(repeat('44', 32), 'hex'),
      repeat(U&'\+01F600', 129)
    );
    RAISE EXCEPTION 'database accepted a 129-code-point token label';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM * FROM native_auth.register_access_token(
      'ob1_PADDED01',
      decode(repeat('55', 32), 'hex'),
      U&'\00A0padded\00A0'
    );
    RAISE EXCEPTION 'database accepted an NBSP-padded token label';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM * FROM native_auth.register_access_token(
      'ob1_CONTROL1',
      decode(repeat('66', 32), 'hex'),
      U&'bad\0085label'
    );
    RAISE EXCEPTION 'database accepted a C1 control in a token label';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$block$ LANGUAGE plpgsql;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM native_auth.access_token
    WHERE prefix = 'ob1_AAAAAAAA'
      AND label = 'ci-client'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'token admin could not list registered token metadata';
  END IF;

  BEGIN
    PERFORM token_hash FROM native_auth.access_token
    WHERE prefix = 'ob1_AAAAAAAA';
    RAISE EXCEPTION 'token admin unexpectedly read token_hash';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$block$ LANGUAGE plpgsql;

SELECT id, prefix, label, created_at, revoked_at
FROM native_auth.revoke_access_token('ob1_AAAAAAAA');

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM native_auth.access_token
    WHERE prefix = 'ob1_AAAAAAAA' AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'token revocation did not persist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM native_auth.revoke_access_token('ob1_AAAAAAAA')
  ) THEN
    RAISE EXCEPTION 'repeated revoke unexpectedly returned a row';
  END IF;
END;
$block$ LANGUAGE plpgsql;

RESET ROLE;
SET LOCAL ROLE openbrain_app;

SELECT prefix, token_hash, label, revoked_at
FROM native_auth.access_token
WHERE prefix = 'ob1_AAAAAAAA';

DO $block$
BEGIN
  BEGIN
    INSERT INTO native_auth.access_token (prefix, token_hash, label)
    VALUES ('ob1_BBBBBBBB', decode(repeat('22', 32), 'hex'), 'forbidden');
    RAISE EXCEPTION 'openbrain_app unexpectedly inserted an access token';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    UPDATE native_auth.access_token
    SET revoked_at = now()
    WHERE prefix = 'ob1_AAAAAAAA';
    RAISE EXCEPTION 'openbrain_app unexpectedly revoked an access token';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$block$ LANGUAGE plpgsql;

RESET ROLE;
ROLLBACK;
