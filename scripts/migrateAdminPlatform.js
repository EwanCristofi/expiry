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
const sqlFile = path.join(__dirname, '..', 'sql', '008_admin_platform.sql')

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
  console.log('⏳ Migration admin plateforme…')
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

  const [statusRows] = await Promise.all([
    sql`
      SELECT status, COUNT(*)::int AS n
      FROM pharmacies
      GROUP BY status
      ORDER BY status
    `,
  ])
  const manualCol = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'scans'
      AND column_name = 'is_manual'
  `
  console.log('📊 pharmacies par statut:', statusRows)
  console.log(
    manualCol[0]
      ? '✓ scans.is_manual présent'
      : '⚠ scans.is_manual manquant',
  )
  console.log('✅ Migration admin plateforme terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
