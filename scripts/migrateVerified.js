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
  console.log('⏳ Migration statut de vérification…')

  await sql`
    ALTER TABLE scans
    ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE
  `
  console.log('✓ Colonne scans.is_verified (BOOLEAN, défaut FALSE)')

  await sql`
    CREATE INDEX IF NOT EXISTS scans_zone_expiry_verified_idx
    ON scans (zone_id, date_peremption, is_verified)
  `
  console.log('✓ Index scans_zone_expiry_verified_idx')

  const [{ total, unverified }] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_verified = FALSE)::int AS unverified
    FROM scans
  `
  console.log(`📊 Scans : ${total} au total, ${unverified} non vérifiés`)
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
