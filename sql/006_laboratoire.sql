-- Ajoute le laboratoire (nullable) aux référentiels produits.
-- Alimente le filtre / la recherche globale et l’export PDF.

ALTER TABLE medicaments_ref
  ADD COLUMN IF NOT EXISTS laboratoire TEXT;

ALTER TABLE parapharma_ref
  ADD COLUMN IF NOT EXISTS laboratoire TEXT;

CREATE INDEX IF NOT EXISTS medicaments_ref_laboratoire_idx
  ON medicaments_ref (laboratoire)
  WHERE laboratoire IS NOT NULL;

CREATE INDEX IF NOT EXISTS parapharma_ref_laboratoire_idx
  ON parapharma_ref (laboratoire)
  WHERE laboratoire IS NOT NULL;
