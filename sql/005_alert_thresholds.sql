-- Seuils d'alerte Rouge / Orange / Bleu par pharmacie.
-- Contrainte métier : Rouge < Orange < Bleu.

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS alert_red_months INTEGER;

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS alert_orange_months INTEGER;

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS alert_blue_months INTEGER;

-- Reprise de l'ancien horizon bleu si présent.
UPDATE pharmacies
SET
  alert_red_months = COALESCE(alert_red_months, 0),
  alert_orange_months = COALESCE(alert_orange_months, 1),
  alert_blue_months = COALESCE(
    alert_blue_months,
    CASE
      WHEN anticipation_months BETWEEN 2 AND 12 THEN anticipation_months
      ELSE 2
    END
  );

-- Cohérence Rouge < Orange < Bleu.
UPDATE pharmacies
SET alert_orange_months = alert_red_months + 1
WHERE alert_orange_months <= alert_red_months;

UPDATE pharmacies
SET alert_blue_months = alert_orange_months + 1
WHERE alert_blue_months <= alert_orange_months;

ALTER TABLE pharmacies
  ALTER COLUMN alert_red_months SET DEFAULT 0;
ALTER TABLE pharmacies
  ALTER COLUMN alert_orange_months SET DEFAULT 1;
ALTER TABLE pharmacies
  ALTER COLUMN alert_blue_months SET DEFAULT 2;

ALTER TABLE pharmacies
  ALTER COLUMN alert_red_months SET NOT NULL;
ALTER TABLE pharmacies
  ALTER COLUMN alert_orange_months SET NOT NULL;
ALTER TABLE pharmacies
  ALTER COLUMN alert_blue_months SET NOT NULL;

ALTER TABLE pharmacies
  DROP CONSTRAINT IF EXISTS pharmacies_alert_thresholds_chk;

ALTER TABLE pharmacies
  ADD CONSTRAINT pharmacies_alert_thresholds_chk
  CHECK (
    alert_red_months IN (0, 1)
    AND alert_orange_months BETWEEN 1 AND 6
    AND alert_blue_months BETWEEN 2 AND 12
    AND alert_red_months < alert_orange_months
    AND alert_orange_months < alert_blue_months
  );
