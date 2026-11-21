import { isOriginAllowed, originFromUrlString } from './allowedOrigins.js'

/**
 * Preuve d’origine pour mutations authentifiées par cookie de session.
 *
 * Limites documentées :
 * - SameSite=Lax bloque déjà l’envoi du cookie sur la plupart des POST cross-site.
 * - Cette couche ajoute une vérification Origin / Fetch Metadata / Referer
 *   (comparaison d’origin exacte via URL, jamais un préfixe).
 * - Sec-Fetch-Site: none n’est pas une preuve same-origin : on exige alors
 *   un Referer dont l’origin est allowlistée.
 * - Les clients sans cookie (cron, Bearer-only transition) ne passent pas
 *   par cette vérification.
 *
 * @param {{
 *   origin?: string | null,
 *   secFetchSite?: string | null,
 *   referer?: string | null,
 * }} headers
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isTrustedCookieMutation(headers, env = process.env) {
  const origin = headers.origin != null ? String(headers.origin).trim() : ''
  if (origin) {
    return isOriginAllowed(origin, env)
  }

  const fetchSite = String(headers.secFetchSite ?? '')
    .trim()
    .toLowerCase()

  if (fetchSite === 'same-origin') {
    return true
  }
  if (fetchSite === 'cross-site') {
    return false
  }

  // absent | none | same-site | autre → Referer obligatoire (origin exacte).
  const refererOrigin = originFromUrlString(headers.referer)
  if (!refererOrigin) return false
  return isOriginAllowed(refererOrigin, env)
}

/**
 * @param {import('hono').Context} c
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isTrustedCookieMutationRequest(c, env = process.env) {
  return isTrustedCookieMutation(
    {
      origin: c.req.header('Origin'),
      secFetchSite: c.req.header('Sec-Fetch-Site'),
      referer: c.req.header('Referer'),
    },
    env,
  )
}
