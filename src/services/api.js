/** Ancienne clé JWT (P1/P2) — à purger uniquement, ne plus jamais écrire. */
const LEGACY_AUTH_TOKEN_KEY = 'expiry.authToken'

/**
 * Supprime l’ancien JWT localStorage s’il existe.
 * Ne touche pas aux autres clés (zone active, son, etc.).
 */
export function clearLegacyAuthToken() {
  try {
    window.localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY)
  } catch {
    // ignore storage errors
  }
}

/**
 * Fetch JSON vers l’API Expiry (`/api` → proxy Vite en local, Serverless Vercel en prod).
 * Auth session : cookie HttpOnly `expiry_token` (credentials: 'include').
 *
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [options]
 */
export async function apiFetch(path, options = {}) {
  const { json, headers: extraHeaders, ...rest } = options
  const headers = new Headers(extraHeaders || {})

  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, {
    credentials: 'include',
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const message =
      payload?.error || `Erreur API (${response.status})`
    const error = new Error(message)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}
