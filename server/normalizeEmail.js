/**
 * Normalisation email partagée (auth + rate limiting).
 * Comportement historique : trim + lower-case, sans autre transformation.
 *
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return String(email ?? '')
    .trim()
    .toLowerCase()
}
