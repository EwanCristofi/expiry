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
  console.log('⏳ Migration seuils d’alertes Rouge / Orange / Bleu…')

  await sql`
    ALTER TABLE pharmacies
    ADD COLUMN IF NOT EXISTS alert_red_months INTEGER
  `
  await sql`
    ALTER TABLE pharmacies
    ADD COLUMN IF NOT EXISTS alert_orange_months INTEGER
  `
  await sql`
    ALTER TABLE pharmacies
    ADD COLUMN IF NOT EXISTS alert_blue_months INTEGER
  `

  await sql`
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
      )
  `

  await sql`
    UPDATE pharmacies
    SET alert_orange_months = alert_red_months + 1
    WHERE alert_orange_months <= alert_red_months
  `

  await sql`
    UPDATE pharmacies
    SET alert_blue_months = GREATEST(alert_orange_months + 1, 2)
    WHERE alert_blue_months <= alert_orange_months
  `

  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_red_months SET DEFAULT 0
  `
  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_orange_months SET DEFAULT 1
  `
  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_blue_months SET DEFAULT 2
  `

  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_red_months SET NOT NULL
  `
  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_orange_months SET NOT NULL
  `
  await sql`
    ALTER TABLE pharmacies
    ALTER COLUMN alert_blue_months SET NOT NULL
  `

  await sql`
    ALTER TABLE pharmacies
    DROP CONSTRAINT IF EXISTS pharmacies_alert_thresholds_chk
  `

  await sql`
    ALTER TABLE pharmacies
    ADD CONSTRAINT pharmacies_alert_thresholds_chk
    CHECK (
      alert_red_months IN (0, 1)
      AND alert_orange_months BETWEEN 1 AND 6
      AND alert_blue_months BETWEEN 2 AND 12
      AND alert_red_months < alert_orange_months
      AND alert_orange_months < alert_blue_months
    )
  `

  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM pharmacies
  `
  console.log(`✓ alert_red/orange/blue_months (contrainte Rouge < Orange < Bleu)`)
  console.log(`📊 Pharmacies : ${total}`)
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
