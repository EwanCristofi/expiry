import fs from 'node:fs'
import path from 'node:path'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.VITE_NEON_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) {
  console.error('❌ Erreur: VITE_NEON_DATABASE_URL non trouvée')
  process.exit(1)
}

const sql = neon(dbUrl)

const CSV_FILE_PATH = path.join(process.cwd(), 'mon_catalogue_parapharma.csv')

async function importCustomParapharma() {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.error(`❌ Fichier introuvable : ${CSV_FILE_PATH}`)
    process.exit(1)
  }

  console.log('⏳ Lecture de votre fichier de parapharmacie...')
  const fileContent = fs.readFileSync(CSV_FILE_PATH, 'utf-8')
  
  // Normalisation universelle des retours à la ligne (\r\n et \r vers \n)
  const lines = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  const records = []
  const uniqueGtins = new Set()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const cols = line.split(';').map(c => c.trim().replace(/^["']|["']$/g, ''))
    
    const gtin = cols[0]
    const nomProduit = cols[1]

    // Ignorer l'en-tête du fichier (AMM;LIBELLEARTICLE)
    if (gtin === 'AMM' || nomProduit === 'LIBELLEARTICLE') continue

    // Validation des codes-barres (entre 7 et 14 chiffres)
    if (gtin && /^\d{7,14}$/.test(gtin) && nomProduit && !uniqueGtins.has(gtin)) {
      uniqueGtins.add(gtin)
      records.push({ gtin, nomProduit })
    }
  }

  console.log(`✅ ${records.length} produits valides extraits de votre catalogue !`)
  console.log('⏳ Insertion dans la table Neon parapharma_ref...')

  const BATCH_SIZE = 500
  let insertedCount = 0

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    const valuesClause = batch
      .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
      .join(', ')

    const queryParams = batch.flatMap(item => [item.gtin, item.nomProduit])

    const query = `
      INSERT INTO parapharma_ref (gtin, nom_produit)
      VALUES ${valuesClause}
      ON CONFLICT (gtin) 
      DO UPDATE SET nom_produit = EXCLUDED.nom_produit;
    `

    await sql.query(query, queryParams)
    insertedCount += batch.length
    console.log(`   ➔ ${insertedCount} / ${records.length} insérés...`)
  }

  console.log('🎉 Importation de votre catalogue officinal terminée avec succès !')
}

importCustomParapharma().catch(err => {
  console.error('❌ Erreur :', err)
  process.exit(1)
})