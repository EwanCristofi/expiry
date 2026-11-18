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
  console.log('⏳ Migration colonne laboratoire (médicaments + parapharma)…')

  await sql`
    ALTER TABLE medicaments_ref
    ADD COLUMN IF NOT EXISTS laboratoire TEXT
  `
  await sql`
    ALTER TABLE parapharma_ref
    ADD COLUMN IF NOT EXISTS laboratoire TEXT
  `

  await sql`
    CREATE INDEX IF NOT EXISTS medicaments_ref_laboratoire_idx
    ON medicaments_ref (laboratoire)
    WHERE laboratoire IS NOT NULL
  `
  await sql`
    CREATE INDEX IF NOT EXISTS parapharma_ref_laboratoire_idx
    ON parapharma_ref (laboratoire)
    WHERE laboratoire IS NOT NULL
  `

  const [meds] = await sql`
    SELECT COUNT(*)::int AS total FROM medicaments_ref
  `
  const [paras] = await sql`
    SELECT COUNT(*)::int AS total FROM parapharma_ref
  `

  console.log('✓ medicaments_ref.laboratoire (TEXT, nullable)')
  console.log('✓ parapharma_ref.laboratoire (TEXT, nullable)')
  console.log(`📊 medicaments_ref : ${meds.total} · parapharma_ref : ${paras.total}`)
  console.log('✅ Migration terminée')
  console.log('💡 Pour remplir les labos BDPM : npm run import:bdpm')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
