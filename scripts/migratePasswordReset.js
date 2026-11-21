import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL

if (!dbUrl) {
  console.error('❌ DATABASE_URL non trouvée dans .env.local / .env')
  process.exit(1)
}

const sql = neon(dbUrl)

async function migrate() {
  console.log('⏳ Migration colonnes reset_token / reset_token_expires…')

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_token TEXT
  `
  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_reset_token_uidx
    ON users (reset_token)
    WHERE reset_token IS NOT NULL
  `

  console.log('✓ users.reset_token (TEXT, nullable)')
  console.log('✓ users.reset_token_expires (TIMESTAMPTZ, nullable)')
  console.log('✓ index unique partiel users_reset_token_uidx')
  console.log('✅ Migration terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
