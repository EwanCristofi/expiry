import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const dbUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL

if (!dbUrl) {
  throw new Error(
    'DATABASE_URL manquante. Définissez-la dans .env.local (côté serveur uniquement).',
  )
}

export const sql = neon(dbUrl)

/**
 * Exécute des requêtes dans une transaction HTTP Neon avec
 * `app.pharmacy_id` injecté (active les politiques RLS).
 *
 * L’API HTTP Neon n’autorise que des transactions non-interactives :
 * passer un tableau de requêtes (le `set_config` est préfixé).
 *
 * @param {string} pharmacyId
 * @param {import('@neondatabase/serverless').NeonQueryPromise[]} queries
 * @returns {Promise<any[]>} résultats des `queries` (sans le set_config)
 */
export async function withPharmacy(pharmacyId, queries) {
  if (!pharmacyId) {
    throw new Error('pharmacy_id manquant pour le contexte RLS')
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('withPharmacy: au moins une requête est requise')
  }

  // SET LOCAL ROLE is required: the Neon owner role is superuser and bypasses RLS.
  const results = await sql.transaction([
    sql.query('SET LOCAL ROLE expiry_app'),
    sql`SELECT set_config('app.pharmacy_id', ${String(pharmacyId)}, true)`,
    ...queries,
  ])
  return results.slice(2)
}
