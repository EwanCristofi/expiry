import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL
if (!dbUrl) {
  console.error('❌ DATABASE_URL (ou VITE_NEON_DATABASE_URL) manquante')
  process.exit(1)
}

const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@demo.local').toLowerCase()
const seedPassword = process.env.SEED_ADMIN_PASSWORD || 'demo-admin-change-me'
const seedNom = process.env.SEED_ADMIN_NOM || 'Admin Demo'

const sql = neon(dbUrl)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sqlFile = path.join(__dirname, '..', 'sql', '001_multi_tenant.sql')

/**
 * Split SQL file into executable statements.
 * Skips empty chunks and line comments-only blocks.
 */
function splitSqlStatements(raw) {
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const statements = []
  let current = ''
  let inDollar = false

  for (const line of withoutBlockComments.split('\n')) {
    const trimmed = line.trim()
    if (!inDollar && trimmed.startsWith('--')) continue

    // Track simple $$ DO blocks so we don't split on inner semicolons wrongly
    // for our file: DO $$ ... END $$;
    const dollarMatches = line.match(/\$\$/g)
    if (dollarMatches) {
      for (let i = 0; i < dollarMatches.length; i++) inDollar = !inDollar
    }

    current += `${line}\n`

    if (!inDollar && trimmed.endsWith(';')) {
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
  console.log('⏳ Migration multi-tenant…')

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

  console.log('⏳ Seed utilisateur admin DEMO…')
  const pharmacies = await sql`
    SELECT id FROM pharmacies WHERE code_client = 'DEMO' LIMIT 1
  `
  const pharmacyId = pharmacies[0]?.id
  if (!pharmacyId) {
    throw new Error('Pharmacie DEMO introuvable après migration')
  }

  const passwordHash = await bcrypt.hash(seedPassword, 12)
  await sql`
    INSERT INTO users (email, password_hash, pharmacy_id, nom, role)
    VALUES (${seedEmail}, ${passwordHash}, ${pharmacyId}, ${seedNom}, 'admin')
    ON CONFLICT (email) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      pharmacy_id = EXCLUDED.pharmacy_id,
      nom = EXCLUDED.nom,
      role = EXCLUDED.role
  `

  const [, , zoneCount, scanCount] = await sql.transaction([
    sql.query('SET LOCAL ROLE expiry_app'),
    sql`SELECT set_config('app.pharmacy_id', ${String(pharmacyId)}, true)`,
    sql`SELECT COUNT(*)::int AS zones FROM zones_stockage`,
    sql`SELECT COUNT(*)::int AS scans FROM scans`,
  ])

  console.log(
    `📊 DEMO (RLS) — zones_stockage=${zoneCount[0].zones}, scans=${scanCount[0].scans}`,
  )
  console.log(`👤 Admin seed : ${seedEmail} / (SEED_ADMIN_PASSWORD)`)
  console.log('✅ Migration multi-tenant terminée')
}

migrate().catch((err) => {
  console.error('❌ Migration échouée:', err)
  process.exit(1)
})
