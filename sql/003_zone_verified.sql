-- Statut de campagne de contrôle par zone de stockage.
ALTER TABLE zones_stockage
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
