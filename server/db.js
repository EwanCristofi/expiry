import { neon } from '@neondatabase/serverless'
import { withUtf8ClientEncoding } from './encoding.js'

const QUERY_TIMEOUT_MS = 10_000

/**
 * Client HTTP Neon créé à la demande à partir de `process.env.DATABASE_URL`.
 * Pas de Pool/WebSocket : une requête = un fetch, rien à laisser ouvert.
 * `client_encoding=UTF8` est forcé dans l’URL de connexion.
 */
export function createSql() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL manquante. Définissez-la dans .env.local / variables Vercel.',
    )
  }

  return neon(withUtf8ClientEncoding(databaseUrl), {
    fetchOptions: {
      // Évite un hang silencieux → 504 Gateway Timeout sur Vercel
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    },
  })
}

/**
 * Proxy compatible tagged-template / .query / .transaction.
 * Instancie un client HTTP frais à chaque appel (pas de pool persistant).
 */
export const sql = Object.assign(
  (strings, ...values) => createSql()(strings, ...values),
  {
    query: (queryText, params, opts) =>
      createSql().query(queryText, params, opts),
    transaction: (queries, opts) => createSql().transaction(queries, opts),
  },
)

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

  const client = createSql()

  try {
    // SET LOCAL ROLE is required: the Neon owner role is superuser and bypasses RLS.
    const results = await client.transaction([
      client.query('SET LOCAL ROLE expiry_app'),
      client`SELECT set_config('app.pharmacy_id', ${String(pharmacyId)}, true)`,
      ...queries,
    ])
    return results.slice(2)
  } catch (err) {
    const message =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Timeout Neon (${QUERY_TIMEOUT_MS}ms) : ${err.message}`
        : err?.message || 'Erreur base de données'
    throw new Error(message)
  }
}
