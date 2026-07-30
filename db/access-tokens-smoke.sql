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
