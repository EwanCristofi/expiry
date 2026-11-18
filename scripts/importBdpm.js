import dotenv from 'dotenv'
import { neon } from '@neondatabase/serverless'
import {
  decodeBdpmBuffer,
  withUtf8ClientEncoding,
} from '../server/encoding.js'

// Charger les variables d'environnement (.env.local puis .env)
dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ Erreur: DATABASE_URL non trouvée dans .env.local')
  process.exit(1)
}

const sql = neon(withUtf8ClientEncoding(dbUrl))

// URLs des fichiers officiels de la Base de Données Publique des Médicaments (BDPM)
const URL_CIS = 'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt'
const URL_CIP = 'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_bdpm.txt'

async function fetchAndDecode(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ExpiryBot/1.0 (pharmacy inventory)' },
  })
  if (!response.ok) {
    throw new Error(`Erreur HTTP ${response.status} lors de la récupération de ${url}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  // CIS = Windows-1252 ; CIP = UTF-8 — détection auto (ne plus forcer Latin-1 partout)
  return decodeBdpmBuffer(arrayBuffer)
}

async function importBdpm() {
  console.log('⏳ 1. Téléchargement et décodage des bases officielles BDPM...')

  // 1. Charger NOMS + titulaires (CIS_bdpm.txt — Latin-1)
  // Col. 0 = CIS, 1 = dénomination, 10 = titulaires (laboratoire)
  const cisText = await fetchAndDecode(URL_CIS)
  const cisToMeta = new Map()

  for (const line of cisText.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    const cisCode = cols[0]?.trim()
    const nomMedicament = cols[1]?.trim() // Nom complet (ex: "DOLIPRANE 1000 mg, comprimé")
    const laboratoire = cols[10]?.trim() || null
    if (cisCode && nomMedicament) {
      cisToMeta.set(cisCode, { nom: nomMedicament, laboratoire })
    }
  }
  console.log(`✅ ${cisToMeta.size} noms de médicaments référencés dans le dictionnaire CIS.`)

  // 2. Charger la table des CIP13 (CIS_CIP_bdpm.txt — UTF-8) et joindre avec le nom
  const cipText = await fetchAndDecode(URL_CIP)
  const records = []
  const uniqueCips = new Set()

  for (const line of cipText.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')

    const cisCode = cols[0]?.trim()
    const cip13 = cols[6]?.trim() // Code CIP13 à 13 chiffres
    const presentation = cols[2]?.trim() // Forme galénique / packaging

    if (cip13 && cip13.length === 13 && !uniqueCips.has(cip13)) {
      const meta = cisToMeta.get(cisCode)
      if (meta) {
        // Ex: "DOLIPRANE 1000 mg, comprimé (plaquette de 8)"
        const nomComplet = presentation
          ? `${meta.nom} (${presentation})`
          : meta.nom

        uniqueCips.add(cip13)
        records.push({
          cip13,
          nom: nomComplet,
          laboratoire: meta.laboratoire,
        })
      }
    }
  }

  console.log(`✅ ${records.length} correspondances CIP13 ➔ Noms créées.`)

  console.log('⏳ 2. Insertion / Mise à jour dans Neon PostgreSQL (UTF-8)...')

  // Garantit la colonne avant upsert (idempotent)
  await sql`
    ALTER TABLE medicaments_ref
    ADD COLUMN IF NOT EXISTS laboratoire TEXT
  `

  const BATCH_SIZE = 500
  let insertedCount = 0

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    const valuesClause = batch
      .map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`)
      .join(', ')

    const queryParams = batch.flatMap((item) => [
      item.cip13,
      item.nom,
      item.laboratoire,
    ])

    const query = `
      INSERT INTO medicaments_ref (cip13, nom_medicament, laboratoire)
      VALUES ${valuesClause}
      ON CONFLICT (cip13)
      DO UPDATE SET
        nom_medicament = EXCLUDED.nom_medicament,
        laboratoire = COALESCE(EXCLUDED.laboratoire, medicaments_ref.laboratoire);
    `

    await sql.query(query, queryParams)
    insertedCount += batch.length
    console.log(`   ➔ ${insertedCount} / ${records.length} insérés...`)
  }

  console.log('🎉 Importation terminée avec succès ! Accents UTF-8 préservés.')
}

importBdpm().catch((err) => {
  console.error("❌ Erreur lors de l'importation :", err)
  process.exit(1)
})
