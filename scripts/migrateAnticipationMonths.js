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
  console.log('⏳ Migration anticipation_months (2–12)…')

  await sql`
    ALTER TABLE pharmacies
    ADD COLUMN IF NOT EXISTS anticipation_months INTEGER
  `

  await sql`
    UPDATE pharmacies
    SET anticipation_months = 2
    WHERE anticipation_months IS NULL
       OR anticipation_months < 2
       OR anticipation_months > 12
  `

  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN anticipation_months SET DEFAULT 2
  `

  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN anticipation_months SET NOT NULL
  `

  await sql`
    ALTER TABLE pharmacies
    DROP CONSTRAINT IF EXISTS pharmacies_anticipation_months_chk
  `

  await sql`
    ALTER TABLE pharmacies
    ADD CONSTRAINT pharmacies_anticipation_months_chk
    CHECK (anticipation_months >= 2 AND anticipation_months <= 12)
  `

  const [{ total, avg }] = await sql`
    SELECT
      COUNT(*)::int AS total,
      ROUND(AVG(anticipation_months)::numeric, 1) AS avg
    FROM pharmacies
  `
  console.log(`✓ pharmacies.anticipation_months (2–12, défaut 2)`)
  console.log(`📊 Pharmacies : ${total} · moyenne horizon = ${avg}`)
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
