-- Soft-disable flag on users (lot A — colonne seule).
-- Idempotent. Safe to re-run.
--
-- Deploy order: run this migration BEFORE deploying app code that SELECTs
-- is_active (otherwise auth fails with a missing-column error).
--
-- Existing rows: DEFAULT true keeps every current account active.
-- This script never deactivates accounts.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE users
  ALTER COLUMN is_active SET DEFAULT true;

-- Guard if a prior nullable column existed (idempotent; no-op when NOT NULL).
UPDATE users
SET is_active = true
WHERE is_active IS NULL;

ALTER TABLE users
  ALTER COLUMN is_active SET NOT NULL;

COMMENT ON COLUMN users.is_active IS
  'Soft-disable account; false rejects login and resolveAuthSession; deactivation bumps session_version (app layer)';
