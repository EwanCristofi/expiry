/**
 * Résolution du jeton de session utilisateur (P1/P2 : cookie prioritaire).
 *
 * Si un cookie est présent (même invalide), on ne bascule jamais sur le Bearer.
 * Le Bearer reste un filet de transition uniquement lorsque le cookie est absent.
 *
 * @param {string | null | undefined} cookieToken
 * @param {string | null | undefined} bearerToken
 * @returns {string | null}
 */
export function resolveSessionToken(cookieToken, bearerToken) {
  const cookie = cookieToken != null ? String(cookieToken) : ''
  if (cookie) return cookie
  const bearer = bearerToken != null ? String(bearerToken) : ''
  return bearer || null
}
