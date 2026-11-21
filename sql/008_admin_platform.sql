-- Admin plateforme : statuts pharmacie + traçage saisie manuelle.
-- Idempotent.

-- ---------------------------------------------------------------------------
-- Statuts pharmacies : TRIAL | ACTIVE | SUSPENDED
-- ---------------------------------------------------------------------------
UPDATE pharmacies
SET status = 'ACTIVE'
WHERE status IS NULL
   OR status = ''
   OR upper(status) NOT IN ('TRIAL', 'ACTIVE', 'SUSPENDED');

ALTER TABLE pharmacies
  ALTER COLUMN status SET DEFAULT 'TRIAL';

ALTER TABLE pharmacies
  DROP CONSTRAINT IF EXISTS pharmacies_status_chk;

ALTER TABLE pharmacies
  ADD CONSTRAINT pharmacies_status_chk
  CHECK (upper(status) IN ('TRIAL', 'ACTIVE', 'SUSPENDED'));

-- ---------------------------------------------------------------------------
-- Saisie manuelle (nom / date complétés hors scan automatique)
-- ---------------------------------------------------------------------------
ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS scans_date_scan_idx
  ON scans (date_scan DESC);

CREATE INDEX IF NOT EXISTS scans_pharmacy_date_scan_idx
  ON scans (pharmacy_id, date_scan DESC);

CREATE INDEX IF NOT EXISTS scans_date_peremption_idx
  ON scans (date_peremption);
