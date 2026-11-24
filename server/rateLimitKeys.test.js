import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeEmail as authNormalizeEmail } from './auth.js'
import {
  RATE_LIMIT_HMAC_SECRET_MIN_BYTES,
  assertNotContainsSensitive,
  hmacRateLimitId,
  isValidRateLimitHmacSecret,
  normalizeEmail,
  rateLimitEmailKey,
  rateLimitIpKey,
  rateLimitLoginPairKey,
  rateLimitResetTokenKey,
  requireRateLimitHmacSecret,
  safeEqualHex,
} from './rateLimitKeys.js'
import { hashResetToken } from './resetToken.js'

const SECRET = 'a'.repeat(RATE_LIMIT_HMAC_SECRET_MIN_BYTES)

describe('normalizeEmail (partagé auth)', () => {
  it('identique à auth.js', () => {
    assert.equal(normalizeEmail('  Admin@X.COM '), 'admin@x.com')
    assert.equal(
      normalizeEmail('  Admin@X.COM '),
      authNormalizeEmail('  Admin@X.COM '),
    )
  })
})

describe('HMAC secret', () => {
  it('refuse secret absent ou trop court', () => {
    assert.equal(isValidRateLimitHmacSecret(''), false)
    assert.equal(isValidRateLimitHmacSecret('short'), false)
    assert.equal(isValidRateLimitHmacSecret(SECRET), true)
    assert.throws(() => requireRateLimitHmacSecret('x'), /RATE_LIMIT_HMAC/)
  })
})

describe('rateLimit keys', () => {
  it('même email (casse/espaces) → même clé ; email absent de la clé', () => {
    const a = rateLimitEmailKey(SECRET, '  User@Example.COM ')
    const b = rateLimitEmailKey(SECRET, 'user@example.com')
    assert.equal(a, b)
    assertNotContainsSensitive(a, 'user@example.com')
    assertNotContainsSensitive(a, 'User@Example.COM')
  })

  it('IP jamais en clair dans la clé', () => {
    const ip = '203.0.113.77'
    const key = rateLimitIpKey(SECRET, ip)
    assertNotContainsSensitive(key, ip)
    assert.match(key, /^[0-9a-f]{64}$/)
  })

  it('token clair absent ; domaine reset-token distinct', () => {
    const token = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
    const key = rateLimitResetTokenKey(SECRET, token)
    assertNotContainsSensitive(key, token)
    const tokenHash = hashResetToken(token)
    assertNotContainsSensitive(key, tokenHash)
    const emailKey = rateLimitEmailKey(SECRET, 'a@b.c')
    assert.notEqual(key, emailKey)
  })

  it('domain separation ip / email / login-pair', () => {
    const ip = '198.51.100.2'
    const email = 'pair@example.com'
    const ipKey = rateLimitIpKey(SECRET, ip)
    const emailKey = rateLimitEmailKey(SECRET, email)
    const pairKey = rateLimitLoginPairKey(SECRET, ip, email)
    assert.notEqual(ipKey, emailKey)
    assert.notEqual(ipKey, pairKey)
    assert.notEqual(emailKey, pairKey)
    assertNotContainsSensitive(pairKey, email)
    assertNotContainsSensitive(pairKey, ip)
  })

  it('login-pair indépendant par IP pour un même email', () => {
    const email = 'pharma@example.com'
    const a = rateLimitLoginPairKey(SECRET, '203.0.113.1', email)
    const b = rateLimitLoginPairKey(SECRET, '203.0.113.2', email)
    assert.notEqual(a, b)
  })

  it('hmacRateLimitId refuse un domaine inconnu', () => {
    assert.throws(
      () =>
        hmacRateLimitId(SECRET, /** @type {any} */ ('nope'), 'x'),
      /Domaine/,
    )
  })

  it('safeEqualHex', () => {
    assert.equal(safeEqualHex('ab', 'ab'), true)
    assert.equal(safeEqualHex('ab', 'ac'), false)
  })
})
