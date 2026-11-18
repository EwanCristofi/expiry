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
  console.log('⏳ Migration statut de vérification des zones…')

  await sql`
    ALTER TABLE zones_stockage
    ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE
  `
  console.log('✓ Colonne zones_stockage.is_verified (BOOLEAN, défaut FALSE)')

  const [{ total, verified }] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_verified = TRUE)::int AS verified
    FROM zones_stockage
  `
  console.log(`📊 Zones : ${total} au total, ${verified} vérifiée(s)`)
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
