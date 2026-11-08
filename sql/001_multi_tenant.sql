-- Expiry multi-tenant migration
-- Isolates pharmacy-owned data via pharmacy_id + Row Level Security.
-- Shared refs (medicaments_ref, parapharma_ref) remain global.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pharmacies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  code_client TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  nom TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_pharmacy_id_idx ON users (pharmacy_id);

-- ---------------------------------------------------------------------------
-- Seed default pharmacy for existing rows (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO pharmacies (nom, code_client)
VALUES ('Pharmacie Demo', 'DEMO')
ON CONFLICT (code_client) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tenant columns on existing tables
-- ---------------------------------------------------------------------------
ALTER TABLE zones_stockage
  ADD COLUMN IF NOT EXISTS pharmacy_id UUID REFERENCES pharmacies(id);

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS pharmacy_id UUID REFERENCES pharmacies(id);

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing rows onto DEMO pharmacy
UPDATE zones_stockage z
SET pharmacy_id = p.id
FROM pharmacies p
WHERE z.pharmacy_id IS NULL
  AND p.code_client = 'DEMO';

UPDATE scans s
SET pharmacy_id = p.id
FROM pharmacies p
WHERE s.pharmacy_id IS NULL
  AND p.code_client = 'DEMO';

-- Fail loudly if anything remains unassigned
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM zones_stockage WHERE pharmacy_id IS NULL) THEN
    RAISE EXCEPTION 'zones_stockage rows without pharmacy_id remain';
  END IF;
  IF EXISTS (SELECT 1 FROM scans WHERE pharmacy_id IS NULL) THEN
    RAISE EXCEPTION 'scans rows without pharmacy_id remain';
  END IF;
END $$;

ALTER TABLE zones_stockage
  ALTER COLUMN pharmacy_id SET NOT NULL;

ALTER TABLE scans
  ALTER COLUMN pharmacy_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Unique constraints scoped per pharmacy
-- ---------------------------------------------------------------------------
ALTER TABLE zones_stockage DROP CONSTRAINT IF EXISTS zones_stockage_nom_zone_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'zones_stockage_pharmacy_nom_key'
  ) THEN
    ALTER TABLE zones_stockage
      ADD CONSTRAINT zones_stockage_pharmacy_nom_key UNIQUE (pharmacy_id, nom_zone);
  END IF;
END $$;

DROP INDEX IF EXISTS scans_gtin_date_zone_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS scans_pharmacy_gtin_date_zone_uidx
  ON scans (pharmacy_id, code_gtin, date_peremption, zone_id);

CREATE INDEX IF NOT EXISTS scans_pharmacy_zone_expiry_verified_idx
  ON scans (pharmacy_id, zone_id, date_peremption, is_verified);

CREATE INDEX IF NOT EXISTS zones_stockage_pharmacy_id_idx
  ON zones_stockage (pharmacy_id);

CREATE INDEX IF NOT EXISTS scans_pharmacy_id_idx
  ON scans (pharmacy_id);

-- ---------------------------------------------------------------------------
-- App role (non-superuser) — neondb_owner bypasses RLS even with FORCE.
-- The API must SET LOCAL ROLE expiry_app inside tenant transactions.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'expiry_app') THEN
    CREATE ROLE expiry_app NOSUPERUSER NOBYPASSRLS NOINHERIT NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO expiry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON zones_stockage TO expiry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scans TO expiry_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO expiry_app;
GRANT SELECT ON medicaments_ref TO expiry_app;
GRANT SELECT, INSERT, UPDATE ON parapharma_ref TO expiry_app;
GRANT SELECT ON pharmacies TO expiry_app;
GRANT SELECT ON users TO expiry_app;

-- Allow the Neon owner connection to assume expiry_app
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT expiry_app TO %I', current_user);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Row Level Security (FORCE so table owner cannot bypass when not superuser)
-- ---------------------------------------------------------------------------
ALTER TABLE zones_stockage ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones_stockage FORCE ROW LEVEL SECURITY;

ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zones_tenant_isolation ON zones_stockage;
CREATE POLICY zones_tenant_isolation ON zones_stockage
  FOR ALL
  TO expiry_app
  USING (pharmacy_id = NULLIF(current_setting('app.pharmacy_id', true), '')::uuid)
  WITH CHECK (pharmacy_id = NULLIF(current_setting('app.pharmacy_id', true), '')::uuid);

DROP POLICY IF EXISTS scans_tenant_isolation ON scans;
CREATE POLICY scans_tenant_isolation ON scans
  FOR ALL
  TO expiry_app
  USING (pharmacy_id = NULLIF(current_setting('app.pharmacy_id', true), '')::uuid)
  WITH CHECK (pharmacy_id = NULLIF(current_setting('app.pharmacy_id', true), '')::uuid);

-- pharmacies / users / shared refs: no tenant RLS here.
-- Access is mediated by the API (JWT + pharmacy_id injection + SET ROLE).
