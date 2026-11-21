-- Jetons de réinitialisation de mot de passe (colonnes sur users).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_reset_token_uidx
  ON users (reset_token)
  WHERE reset_token IS NOT NULL;
