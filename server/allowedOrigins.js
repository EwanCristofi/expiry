/**
 * Allowlist d’origines pour CORS et CSRF (comparaison exacte d’origin).
 * Jamais de réflexion automatique de l’en-tête Origin, ni de wildcard / sous-domaines.
 */

const DEV_ORIGINS = Object.freeze([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isProductionEnv(env = process.env) {
  return env.NODE_ENV === 'production'
}

/**
 * @param {string} raw
 * @returns {string | null} origin (scheme://host[:port]) ou null
 */
export function originFromUrlString(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

/**
 * Origin de APP_URL en production : HTTPS obligatoire, fail-closed.
 *
 * @param {unknown} raw
 * @returns {string} origin https
 */
export function requireProductionAppOrigin(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    throw new Error(
      'APP_URL manquante en production : définissez l’URL publique HTTPS de l’application (CORS/CSRF)',
    )
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(
      'APP_URL invalide en production : URL absolue HTTPS attendue (CORS/CSRF)',
    )
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      'APP_URL invalide en production : identifiants interdits dans l’URL (CORS/CSRF)',
    )
  }

  if (parsed.protocol.toLowerCase() !== 'https:') {
    throw new Error(
      'APP_URL invalide en production : HTTPS obligatoire (CORS/CSRF)',
    )
  }

  return parsed.origin
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function listAllowedOrigins(env = process.env) {
  /** @type {Set<string>} */
  const origins = new Set()
  const production = isProductionEnv(env)

  if (production) {
    origins.add(requireProductionAppOrigin(env.APP_URL))
  } else {
    const appUrl = env.APP_URL
    if (appUrl != null && String(appUrl).trim() !== '') {
      const fromApp = originFromUrlString(appUrl)
      if (fromApp) origins.add(fromApp)
    }
    for (const origin of DEV_ORIGINS) origins.add(origin)
  }

  const extra = env.CORS_ORIGINS
  if (extra != null && String(extra).trim() !== '') {
    for (const part of String(extra).split(',')) {
      const origin = originFromUrlString(part)
      if (origin) origins.add(origin)
    }
  }

  return [...origins]
}

/**
 * @param {string | null | undefined} origin
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isOriginAllowed(origin, env = process.env) {
  if (!origin) return false
  return listAllowedOrigins(env).includes(String(origin))
}

/**
 * Valeur Access-Control-Allow-Origin pour Hono, ou null (pas d’en-tête).
 * Hono n’écrit ACAO que si la valeur est truthy.
 *
 * @param {string} origin en-tête Origin (peut être '')
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveCorsAllowOrigin(origin, env = process.env) {
  if (!origin) return null
  return isOriginAllowed(origin, env) ? origin : null
}
