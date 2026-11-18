-- Pharmacy SIRET + trial period (idempotent)

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS siret VARCHAR(14);

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS status VARCHAR(20);

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

-- Backfill existing tenants before NOT NULL constraints.
UPDATE pharmacies
SET siret = COALESCE(NULLIF(siret, ''), '00000000000000')
WHERE siret IS NULL OR siret = '';

UPDATE pharmacies
SET status = COALESCE(NULLIF(status, ''), 'TRIAL')
WHERE status IS NULL OR status = '';

UPDATE pharmacies
SET trial_ends_at = COALESCE(trial_ends_at, NOW() + INTERVAL '7 days')
WHERE trial_ends_at IS NULL;

ALTER TABLE pharmacies
  ALTER COLUMN siret SET NOT NULL;

ALTER TABLE pharmacies
  ALTER COLUMN status SET DEFAULT 'TRIAL';

ALTER TABLE pharmacies
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE pharmacies
  ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '7 days');

ALTER TABLE pharmacies
  ALTER COLUMN trial_ends_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pharmacies_siret_uidx
  ON pharmacies (siret)
  WHERE siret <> '00000000000000';
