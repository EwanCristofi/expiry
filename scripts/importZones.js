import fs from 'node:fs'
import path from 'node:path'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'
import iconv from 'iconv-lite'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) {
  console.error('❌ Erreur: VITE_NEON_DATABASE_URL non trouvée')
  process.exit(1)
}

const sql = neon(dbUrl)

const CSV_FILE_PATH = path.join(process.cwd(), 'zone_geographique.csv')

const HEADER_NAMES = new Set([
  'nom_zone',
  'nom',
  'zone',
  'zone_geographique',
  'zones',
])

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS zones_stockage (
      id SERIAL PRIMARY KEY,
      nom_zone TEXT NOT NULL
    )
  `
}

async function resolveDemoPharmacyId() {
  const rows = await sql`
    SELECT id FROM pharmacies WHERE code_client = 'DEMO' LIMIT 1
  `
  if (!rows[0]?.id) {
    throw new Error(
      'Pharmacie DEMO introuvable. Exécutez d’abord npm run migrate:multitenant',
    )
  }
  return rows[0].id
}

function parseZones(fileContent) {
  const lines = fileContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')

  const zones = []
  const seen = new Set()

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || !raw.trim()) continue

    // Une seule colonne (éventuellement séparée par ; ou ,)
    const firstCol = raw
      .split(/[;,]/)[0]
      .trim()
      .replace(/^["']|["']$/g, '')

    if (!firstCol) continue

    // Ignorer une éventuelle ligne d'en-tête
    if (i === 0 && HEADER_NAMES.has(firstCol.toLowerCase())) continue

    const key = firstCol.toLocaleLowerCase('fr')
    if (seen.has(key)) continue
    seen.add(key)

    zones.push(firstCol)
  }

  return zones
}

async function importZones() {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.error(`❌ Fichier introuvable : ${CSV_FILE_PATH}`)
    process.exit(1)
  }

  console.log('⏳ Lecture de zone_geographique.csv…')
  const buffer = fs.readFileSync(CSV_FILE_PATH)
  // Fichier exporté en ISO-8859-1 (accents : tétines, etc.)
  const fileContent = iconv.decode(buffer, 'latin1')

  const zones = parseZones(fileContent)
  console.log(`✅ ${zones.length} zones valides trouvées dans le fichier`)

  console.log('⏳ Initialisation de la table zones_stockage…')
  await ensureTable()
  const pharmacyId = await resolveDemoPharmacyId()
  console.log(`🏥 Import rattaché à la pharmacie DEMO (${pharmacyId})`)

  console.log('⏳ Insertion dans Neon…')
  const BATCH_SIZE = 100
  let processed = 0

  for (let i = 0; i < zones.length; i += BATCH_SIZE) {
    const batch = zones.slice(i, i + BATCH_SIZE)

    const valuesClause = batch
      .map((_, index) => `($${index + 1}, $${batch.length + 1}::uuid)`)
      .join(', ')
    const query = `
      INSERT INTO zones_stockage (nom_zone, pharmacy_id)
      VALUES ${valuesClause}
      ON CONFLICT (pharmacy_id, nom_zone) DO NOTHING
    `

    await sql.query(query, [...batch, pharmacyId])
    processed += batch.length
    console.log(`   ➔ ${processed} / ${zones.length} traités…`)
  }

  const [, , countRows] = await sql.transaction([
    sql.query('SET LOCAL ROLE expiry_app'),
    sql`SELECT set_config('app.pharmacy_id', ${String(pharmacyId)}, true)`,
    sql`SELECT COUNT(*)::int AS count FROM zones_stockage`,
  ])
  const count = countRows[0].count
  console.log(
    `🎉 Import terminé avec succès — ${count} zone(s) au total dans zones_stockage`,
  )
}

importZones().catch((err) => {
  console.error('❌ Erreur :', err)
  process.exit(1)
})
