-- Horizon d'anticipation (alerte bleue) par pharmacie.
-- Valeurs autorisées : 2 à 12 mois (défaut 2).

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS anticipation_months INTEGER;

UPDATE pharmacies
SET anticipation_months = 2
WHERE anticipation_months IS NULL;

ALTER TABLE pharmacies
  ALTER COLUMN anticipation_months SET DEFAULT 2;

ALTER TABLE pharmacies
  ALTER COLUMN anticipation_months SET NOT NULL;

ALTER TABLE pharmacies
  DROP CONSTRAINT IF EXISTS pharmacies_anticipation_months_chk;

ALTER TABLE pharmacies
  ADD CONSTRAINT pharmacies_anticipation_months_chk
  CHECK (anticipation_months >= 2 AND anticipation_months <= 12);
