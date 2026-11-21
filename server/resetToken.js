import { createHash, randomBytes } from 'node:crypto'

/**
 * Empreinte SHA-256 hex du jeton de reset (ce qui est stocké en base).
 * @param {string} rawToken
 * @returns {string}
 */
export function hashResetToken(rawToken) {
  return createHash('sha256')
    .update(String(rawToken ?? ''), 'utf8')
    .digest('hex')
}

/**
 * Génère un jeton aléatoire (clair, pour l’e-mail) + son empreinte (pour la DB).
 * @returns {{ token: string, tokenHash: string }}
 */
export function generateResetTokenPair() {
  const token = randomBytes(32).toString('hex')
  return {
    token,
    tokenHash: hashResetToken(token),
  }
}
