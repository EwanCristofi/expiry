-- JWT session revocation counter on users.
-- Idempotent. Safe to re-run.
--
-- Deploy order: run this migration BEFORE deploying app code that SELECTs
-- session_version (otherwise auth fails with a missing-column error).
--
-- Compatibility: DEFAULT 0 matches legacy JWTs that omit the claim
-- (treated as version 0 by resolveAuthSession).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users
  ALTER COLUMN session_version SET DEFAULT 0;

-- Guard if a prior nullable column existed (idempotent).
UPDATE users
SET session_version = 0
WHERE session_version IS NULL;

ALTER TABLE users
  ALTER COLUMN session_version SET NOT NULL;

COMMENT ON COLUMN users.session_version IS
  'Monotonic counter embedded in JWT; mismatch with claim rejects the session (password change / reset bumps it)';
