import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ VITE_NEON_DATABASE_URL non trouvée dans .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)

async function migrate() {
  console.log('⏳ Migration zones de stockage…')

  await sql`
    CREATE TABLE IF NOT EXISTS zones_stockage (
      id SERIAL PRIMARY KEY,
      nom_zone TEXT NOT NULL
    )
  `
  console.log('✓ Table zones_stockage')

  const pharmacies = await sql`
    SELECT id FROM pharmacies WHERE code_client = 'DEMO' LIMIT 1
  `
  if (!pharmacies[0]?.id) {
    throw new Error(
      'Pharmacie DEMO introuvable. Exécutez d’abord npm run migrate:multitenant',
    )
  }
  const pharmacyId = pharmacies[0].id

  await sql`
    INSERT INTO zones_stockage (nom_zone, pharmacy_id)
    VALUES
      ('Frigo', ${pharmacyId}::uuid),
      ('Réserve', ${pharmacyId}::uuid),
      ('Tiroir bas', ${pharmacyId}::uuid)
    ON CONFLICT (pharmacy_id, nom_zone) DO NOTHING
  `
  console.log('✓ Zones par défaut (DEMO)')

  await sql`
    ALTER TABLE scans
    ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES zones_stockage(id)
  `
  console.log('✓ Colonne scans.zone_id')

  const [, , zones] = await sql.transaction([
    sql.query('SET LOCAL ROLE expiry_app'),
    sql`SELECT set_config('app.pharmacy_id', ${String(pharmacyId)}, true)`,
    sql`SELECT id, nom_zone FROM zones_stockage ORDER BY nom_zone`,
  ])
  console.log('Zones disponibles:', zones)
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
