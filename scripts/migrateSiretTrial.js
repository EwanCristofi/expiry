import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL
if (!dbUrl) {
  console.error('❌ DATABASE_URL (ou VITE_NEON_DATABASE_URL) manquante')
  process.exit(1)
}

const sql = neon(dbUrl)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sqlFile = path.join(__dirname, '..', 'sql', '002_pharmacy_siret_trial.sql')

function splitSqlStatements(raw) {
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const statements = []
  let current = ''

  for (const line of withoutBlockComments.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('--')) continue
    current += `${line}\n`
    if (trimmed.endsWith(';')) {
      const stmt = current.trim()
      if (stmt) statements.push(stmt)
      current = ''
    }
  }

  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}

async function migrate() {
  console.log('⏳ Migration SIRET + trial…')
  const raw = fs.readFileSync(sqlFile, 'utf8')
  const statements = splitSqlStatements(raw)
  console.log(`📄 ${statements.length} instructions SQL`)

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]
    try {
      await sql.query(stmt)
      console.log(`✓ [${i + 1}/${statements.length}]`)
    } catch (err) {
      console.error(`❌ Échec instruction ${i + 1}:`, stmt.slice(0, 200))
      throw err
    }
  }

  const rows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'TRIAL')::int AS trial,
      COUNT(*) FILTER (WHERE siret IS NOT NULL)::int AS with_siret
    FROM pharmacies
  `
  console.log(
    `📊 pharmacies : ${rows[0].total} total, ${rows[0].trial} TRIAL, ${rows[0].with_siret} avec SIRET`,
  )
  console.log('✅ Migration SIRET + trial terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
