/**
 * Corrige les libellés déjà corrompus en base (mojibake UTF-8→Latin-1).
 *
 * Exemple : "polyÃ©thylÃ¨ne" → "polyéthylène"
 * (y compris chaînes mixtes : "comprimé … comprimÃ©(s)")
 *
 * Usage : npm run fix:mojibake
 *
 * Alternative / complément : `npm run import:bdpm` réimporte medicaments_ref
 * depuis la BDPM avec détection d’encodage (CIS Latin-1, CIP UTF-8).
 */
import dotenv from 'dotenv'
import { neon } from '@neondatabase/serverless'
import {
  fixMojibake,
  looksLikeMojibake,
  withUtf8ClientEncoding,
} from '../server/encoding.js'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) {
  console.error('❌ DATABASE_URL non trouvée dans .env.local')
  process.exit(1)
}

const sql = neon(withUtf8ClientEncoding(dbUrl))

/** Taille de lot (séquentiel pour éviter de saturer l’API HTTP Neon). */
const BATCH_SIZE = 100
const CONCURRENCY = 10

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 */
async function mapPool(items, concurrency, worker) {
  let index = 0
  async function run() {
    while (index < items.length) {
      const current = index
      index += 1
      await worker(items[current])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  )
}

/**
 * @param {string} table
 * @param {string} idColumn
 * @param {string} textColumn
 */
async function fixTable(table, idColumn, textColumn) {
  console.log(`⏳ Scan de ${table}.${textColumn}…`)

  const rows = await sql.query(
    `
    SELECT ${idColumn} AS id, ${textColumn} AS value
    FROM ${table}
    WHERE ${textColumn} ~ 'Ã.|Â.|â.|ð.'
    `,
  )

  const updates = []
  let skipped = 0

  for (const row of rows) {
    if (!looksLikeMojibake(row.value)) {
      skipped += 1
      continue
    }
    const fixed = fixMojibake(row.value)
    if (typeof fixed !== 'string' || fixed === row.value) {
      skipped += 1
      continue
    }
    updates.push({ id: row.id, value: fixed })
  }

  console.log(
    `   ${rows.length} suspect(s) → ${updates.length} à corriger, ${skipped} ignoré(s)`,
  )

  let updated = 0
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE)
    await mapPool(batch, CONCURRENCY, async (item) => {
      await sql.query(
        `UPDATE ${table} SET ${textColumn} = $1 WHERE ${idColumn} = $2`,
        [item.value, item.id],
      )
    })
    updated += batch.length
    console.log(`   ➔ ${updated} / ${updates.length}`)
  }

  console.log(`✓ ${table} : ${updated} mis à jour`)
  return { candidates: rows.length, updated, skipped }
}

async function main() {
  console.log('🧹 Correction mojibake (connexion UTF-8)…')

  const meds = await fixTable('medicaments_ref', 'cip13', 'nom_medicament')
  const scans = await fixTable('scans', 'id', 'nom_produit')

  const sample = await sql`
    SELECT cip13, nom_medicament
    FROM medicaments_ref
    WHERE cip13 = '3400934065187'
    LIMIT 1
  `
  console.log('📋 Mucomyst après fix:', sample[0]?.nom_medicament)
  console.log('✅ Terminé', { medicaments_ref: meds, scans })
  console.log('💡 Resync source officielle : npm run import:bdpm')
}

main().catch((err) => {
  console.error('❌ Correction échouée:', err)
  process.exit(1)
})
