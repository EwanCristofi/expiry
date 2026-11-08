import fs from 'node:fs'
import path from 'node:path'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'
import iconv from 'iconv-lite'

// Charger les variables d'environnement (.env.local puis .env)
dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL

if (!dbUrl) {
  console.error('❌ Erreur: VITE_NEON_DATABASE_URL non trouvée dans .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)

// URLs des fichiers officiels de la Base de Données Publique des Médicaments (BDPM)
const URL_CIS = 'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt'
const URL_CIP = 'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_bdpm.txt'

async function fetchAndDecode(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Erreur HTTP ${response.status} lors de la récupération de ${url}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  // Décodage spécifique en ISO-8859-1 (Latin-1) pour préserver tous les accents français
  return iconv.decode(buffer, 'iso-8859-1')
}

async function importBdpm() {
  console.log('⏳ 1. Téléchargement et décodage des bases officielles BDPM...')

  // 1. Charger la table des NOMS (CIS_bdpm.txt)
  const cisText = await fetchAndDecode(URL_CIS)
  const cisToName = new Map()

  for (const line of cisText.split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    const cisCode = cols[0]?.trim()
    const nomMedicament = cols[1]?.trim() // Nom complet (ex: "DOLIPRANE 1000 mg, comprimé")
    if (cisCode && nomMedicament) {
      cisToName.set(cisCode, nomMedicament)
    }
  }
  console.log(`✅ ${cisToName.size} noms de médicaments référencés dans le dictionnaire CIS.`)

  // 2. Charger la table des CIP13 (CIS_CIP_bdpm.txt) et joindre avec le nom
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
      const nomBase = cisToName.get(cisCode)
      if (nomBase) {
        // Ex: "DOLIPRANE 1000 mg, comprimé - plaquette de 8" ou simplement "DOLIPRANE 1000 mg, comprimé"
        const nomComplet = presentation ? `${nomBase} (${presentation})` : nomBase
        
        uniqueCips.add(cip13)
        records.push({ cip13, nom: nomComplet })
      }
    }
  }

  console.log(`✅ ${records.length} correspondances CIP13 ➔ Noms créées.`)

  console.log('⏳ 2. Insertion / Mise à jour dans Neon PostgreSQL...')

  const BATCH_SIZE = 500
  let insertedCount = 0

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    const valuesClause = batch
      .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
      .join(', ')

    const queryParams = batch.flatMap(item => [item.cip13, item.nom])

    const query = `
      INSERT INTO medicaments_ref (cip13, nom_medicament)
      VALUES ${valuesClause}
      ON CONFLICT (cip13) 
      DO UPDATE SET nom_medicament = EXCLUDED.nom_medicament;
    `

    await sql.query(query, queryParams)
    insertedCount += batch.length
    console.log(`   ➔ ${insertedCount} / ${records.length} insérés...`)
  }

  console.log('🎉 Importation terminée avec succès ! Vos médicaments ont maintenant leurs vrais noms et accents !')
}

importBdpm().catch((err) => {
  console.error('❌ Erreur lors de l\'importation :', err)
  process.exit(1)
})