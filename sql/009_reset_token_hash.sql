-- Password reset tokens: store SHA-256 digests only (never plaintext).
-- Idempotent. Does NOT modify password_hash or user accounts.
--
-- Impact:
-- - Any pending reset links issued before this migration become invalid.
-- - Users must request a new password reset if they still need one.
-- - No rows are deleted; only reset_token / reset_token_expires are cleared
--   so leftover plaintext values cannot remain in Neon after deploy.

UPDATE users
SET
  reset_token = NULL,
  reset_token_expires = NULL
WHERE reset_token IS NOT NULL
   OR reset_token_expires IS NOT NULL;

COMMENT ON COLUMN users.reset_token IS
  'SHA-256 hex digest of the one-time password-reset token (plaintext never stored)';
