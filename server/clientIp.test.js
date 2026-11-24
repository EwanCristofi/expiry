import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseFirstValidIp,
  resolveClientIp,
  shouldTrustForwardedClientIp,
} from './clientIp.js'

describe('shouldTrustForwardedClientIp', () => {
  it('fait confiance en production / preview Vercel uniquement', () => {
    assert.equal(
      shouldTrustForwardedClientIp({ VERCEL_ENV: 'production' }),
      true,
    )
    assert.equal(
      shouldTrustForwardedClientIp({ VERCEL_ENV: 'preview' }),
      true,
    )
    assert.equal(
      shouldTrustForwardedClientIp({ VERCEL_ENV: 'development' }),
      false,
    )
    assert.equal(shouldTrustForwardedClientIp({}), false)
  })
})

describe('parseFirstValidIp', () => {
  it('accepte IPv4 et IPv6', () => {
    assert.equal(parseFirstValidIp('203.0.113.10'), '203.0.113.10')
    assert.equal(
      parseFirstValidIp('2001:db8::1'),
      '2001:db8::1',
    )
  })

  it('prend la première IP d’une liste CSV', () => {
    assert.equal(
      parseFirstValidIp('198.51.100.1, 10.0.0.1'),
      '198.51.100.1',
    )
  })

  it('rejette unknown, vide et malformé', () => {
    assert.equal(parseFirstValidIp('unknown'), null)
    assert.equal(parseFirstValidIp(''), null)
    assert.equal(parseFirstValidIp('not-an-ip'), null)
    assert.equal(parseFirstValidIp(null), null)
  })

  it('accepte IPv6 entre crochets', () => {
    assert.equal(parseFirstValidIp('[2001:db8::2]'), '2001:db8::2')
  })
})

describe('resolveClientIp', () => {
  function headers(map) {
    return {
      header: (name) => map[name.toLowerCase()],
    }
  }

  it('priorise x-vercel-forwarded-for', () => {
    const result = resolveClientIp(
      headers({
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-forwarded-for': '198.51.100.9',
        'x-real-ip': '192.0.2.9',
      }),
      { trustForwardedHeaders: true },
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.ip, '203.0.113.9')
      assert.equal(result.source, 'x-vercel-forwarded-for')
    }
  })

  it('fallback x-forwarded-for puis x-real-ip', () => {
    const viaXff = resolveClientIp(
      headers({ 'x-forwarded-for': '203.0.113.20' }),
      { trustForwardedHeaders: true },
    )
    assert.equal(viaXff.ok && viaXff.ip, '203.0.113.20')

    const viaReal = resolveClientIp(
      headers({ 'x-real-ip': '203.0.113.21' }),
      { trustForwardedHeaders: true },
    )
    assert.equal(viaReal.ok && viaReal.ip, '203.0.113.21')
  })

  it('refuse les headers en développement (non trust)', () => {
    const result = resolveClientIp(
      headers({ 'x-forwarded-for': '203.0.113.1' }),
      { env: { VERCEL_ENV: 'development' } },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'untrusted_environment')
  })

  it('IP absente en production → missing', () => {
    const result = resolveClientIp(headers({}), {
      trustForwardedHeaders: true,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'missing')
  })

  it('header malformé → invalid', () => {
    const result = resolveClientIp(
      headers({ 'x-forwarded-for': 'unknown' }),
      { trustForwardedHeaders: true },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'invalid')
  })

  it('accepte une IP injectée (tests) sans confiance headers', () => {
    const result = resolveClientIp(headers({}), {
      trustForwardedHeaders: false,
      injectedIp: '203.0.113.50',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.ip, '203.0.113.50')
      assert.equal(result.source, 'injected')
    }
  })
})
