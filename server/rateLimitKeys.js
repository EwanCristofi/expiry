import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalizeEmail } from './normalizeEmail.js'
import { hashResetToken } from './resetToken.js'

export { normalizeEmail }

/** Longueur minimale du secret HMAC (octets UTF-8). */
export const RATE_LIMIT_HMAC_SECRET_MIN_BYTES = 32

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function readRateLimitHmacSecret(env = process.env) {
  return String(env.RATE_LIMIT_HMAC_SECRET ?? '')
}

/**
 * @param {unknown} secret
 * @returns {boolean}
 */
export function isValidRateLimitHmacSecret(secret) {
  const value = String(secret ?? '')
  if (!value) return false
  return Buffer.byteLength(value, 'utf8') >= RATE_LIMIT_HMAC_SECRET_MIN_BYTES
}

/**
 * Refuse un secret absent / trop court (Production / Preview).
 * @param {unknown} secret
 * @returns {string}
 */
export function requireRateLimitHmacSecret(secret) {
  const value = String(secret ?? '')
  if (!isValidRateLimitHmacSecret(value)) {
    const err = new Error('RATE_LIMIT_HMAC_SECRET manquant ou trop court (min. 32 octets)')
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  return value
}

/**
 * HMAC-SHA256 hex avec séparation de domaine explicite.
 * Ne jamais journaliser `material` ni le secret.
 *
 * @param {string} secret
 * @param {'ip' | 'email' | 'login-pair' | 'reset-token'} domain
 * @param {string} material valeur déjà normalisée / non PII brute si possible
 * @returns {string}
 */
export function hmacRateLimitId(secret, domain, material) {
  const s = requireRateLimitHmacSecret(secret)
  const prefix =
    domain === 'ip'
      ? 'ip:'
      : domain === 'email'
        ? 'email:'
        : domain === 'login-pair'
          ? 'login-pair:'
          : domain === 'reset-token'
            ? 'reset-token:'
            : null
  if (!prefix) {
    const err = new Error('Domaine rate-limit inconnu')
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  return createHmac('sha256', s)
    .update(prefix, 'utf8')
    .update(String(material ?? ''), 'utf8')
    .digest('hex')
}

/**
 * @param {string} secret
 * @param {string} ip IP déjà validée
 */
export function rateLimitIpKey(secret, ip) {
  return hmacRateLimitId(secret, 'ip', ip)
}

/**
 * @param {string} secret
 * @param {unknown} email
 */
export function rateLimitEmailKey(secret, email) {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    const err = new Error('Email manquant pour clé rate-limit')
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  return hmacRateLimitId(secret, 'email', normalized)
}

/**
 * Couple IP + email (blocage localisé, pas de lockout email global).
 * @param {string} secret
 * @param {string} ip
 * @param {unknown} email
 */
export function rateLimitLoginPairKey(secret, ip, email) {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    const err = new Error('Email manquant pour clé rate-limit login-pair')
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  return hmacRateLimitId(secret, 'login-pair', `${ip}\0${normalized}`)
}

/**
 * Empreinte Redis pour un token de reset : SHA-256(token) puis HMAC.
 * @param {string} secret
 * @param {unknown} rawToken
 */
export function rateLimitResetTokenKey(secret, rawToken) {
  const tokenHash = hashResetToken(String(rawToken ?? '').trim())
  return hmacRateLimitId(secret, 'reset-token', tokenHash)
}

/**
 * Vérifie qu’une chaîne ne contient pas une sous-chaîne sensible (tests).
 * @param {string} haystack
 * @param {string} needle
 */
export function assertNotContainsSensitive(haystack, needle) {
  const h = String(haystack)
  const n = String(needle)
  if (!n) return
  if (h.includes(n)) {
    throw new Error('Fuite d’identifiant sensible dans une clé rate-limit')
  }
}

/**
 * Comparaison constante (tests / utilitaires).
 * @param {string} a
 * @param {string} b
 */
export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
