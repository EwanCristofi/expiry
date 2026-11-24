import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  RATE_LIMIT_HMAC_SECRET_MIN_BYTES,
} from './rateLimitKeys.js'
import {
  RateLimitExceededError,
  RateLimitUnavailableError,
  assertAuthRateLimit,
  assertRateLimitEnvConfigured,
  createMemoryRateLimiters,
  enforceAuthRateLimit,
  isRateLimitConfigRequired,
  isValidUpstashRestUrl,
  maySkipRateLimitWhenUnconfigured,
  rateLimitKeyPrefix,
  resetRateLimitTestState,
  resolveRateLimitDeployEnv,
  retryAfterSecondsFromReset,
  setAssertAuthRateLimitOverridesForTests,
  setRateLimitRuntimeForTests,
} from './rateLimit.js'
import {
  RATE_LIMIT_PUBLIC_MESSAGE,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
} from './rateLimit.policies.js'
import { classifyHttpError, PUBLIC_HTTP_STATUSES } from './httpError.js'

const HMAC = 'b'.repeat(RATE_LIMIT_HMAC_SECRET_MIN_BYTES)
const IP_A = '203.0.113.10'
const IP_B = '198.51.100.20'

/** Valeurs fictives uniquement — jamais de secrets réels. */
const FAKE_UPSTASH_URL = 'https://fake-upstash-example.invalid'
const FAKE_UPSTASH_TOKEN = 'upstash-token-fake-value-do-not-leak'
const FAKE_HMAC_32 = 'h'.repeat(RATE_LIMIT_HMAC_SECRET_MIN_BYTES)
const FAKE_HMAC_SHORT = 'h'.repeat(RATE_LIMIT_HMAC_SECRET_MIN_BYTES - 1)

/**
 * @param {Map<string, number[]>} [state]
 * @param {object} [extra]
 */
function testRuntime(state = new Map(), extra = {}) {
  return {
    deployEnv: /** @type {const} */ ('test'),
    hmacSecret: HMAC,
    limiters: createMemoryRateLimiters({ state, ...extra }),
    now: extra.now,
  }
}

describe('rateLimit env / prefix', () => {
  it('VERCEL_ENV isole production / preview', () => {
    assert.equal(
      resolveRateLimitDeployEnv({ VERCEL_ENV: 'production', NODE_ENV: 'production' }),
      'production',
    )
    assert.equal(
      resolveRateLimitDeployEnv({ VERCEL_ENV: 'preview', NODE_ENV: 'production' }),
      'preview',
    )
    assert.equal(resolveRateLimitDeployEnv({ NODE_ENV: 'test' }), 'test')
    assert.equal(resolveRateLimitDeployEnv({ NODE_ENV: 'development' }), 'development')
  })

  it('VERCEL=1 sans VERCEL_ENV → erreur config', () => {
    assert.throws(
      () => resolveRateLimitDeployEnv({ VERCEL: '1', NODE_ENV: 'production' }),
      /VERCEL_ENV/,
    )
  })

  it('préfixe versionné distinct par env', () => {
    assert.equal(rateLimitKeyPrefix('production'), 'expiry:rl:v1:production')
    assert.equal(rateLimitKeyPrefix('preview'), 'expiry:rl:v1:preview')
    assert.notEqual(
      rateLimitKeyPrefix('production'),
      rateLimitKeyPrefix('preview'),
    )
  })

  it('config obligatoire seulement prod/preview', () => {
    assert.equal(isRateLimitConfigRequired('production'), true)
    assert.equal(isRateLimitConfigRequired('preview'), true)
    assert.equal(isRateLimitConfigRequired('development'), false)
    assert.equal(maySkipRateLimitWhenUnconfigured('development'), true)
    assert.equal(maySkipRateLimitWhenUnconfigured('production'), false)
  })
})

describe('isValidUpstashRestUrl', () => {
  it('accepte une URL HTTPS valide', () => {
    assert.equal(isValidUpstashRestUrl(FAKE_UPSTASH_URL), true)
  })

  it('refuse HTTP, malformé et vide', () => {
    assert.equal(isValidUpstashRestUrl('http://fake-upstash-example.invalid'), false)
    assert.equal(isValidUpstashRestUrl('not-a-url'), false)
    assert.equal(isValidUpstashRestUrl(''), false)
  })
})

describe('assertRateLimitEnvConfigured', () => {
  const validEnv = {
    UPSTASH_REDIS_REST_URL: FAKE_UPSTASH_URL,
    UPSTASH_REDIS_REST_TOKEN: FAKE_UPSTASH_TOKEN,
    RATE_LIMIT_HMAC_SECRET: FAKE_HMAC_32,
  }

  /**
   * @param {NodeJS.ProcessEnv} env
   * @param {RegExp} [messagePattern]
   */
  function assertConfigRejected(env, messagePattern) {
    assert.throws(
      () => assertRateLimitEnvConfigured(env),
      (err) => {
        assert.equal(err?.name, 'RateLimitConfigError')
        const msg = String(err?.message ?? '')
        if (messagePattern) assert.match(msg, messagePattern)
        assert.doesNotMatch(msg, new RegExp(FAKE_UPSTASH_TOKEN, 'i'))
        assert.doesNotMatch(msg, new RegExp(FAKE_HMAC_32, 'i'))
        assert.doesNotMatch(msg, new RegExp(FAKE_HMAC_SHORT, 'i'))
        assert.doesNotMatch(msg, /fake-upstash-example\.invalid/i)
        return true
      },
    )
  }

  it('accepte une configuration complète valide (HMAC 32 octets)', () => {
    const cfg = assertRateLimitEnvConfigured(validEnv)
    assert.equal(cfg.url, FAKE_UPSTASH_URL)
    assert.equal(cfg.token, FAKE_UPSTASH_TOKEN)
    assert.equal(cfg.hmacSecret, FAKE_HMAC_32)
  })

  it('refuse URL absente', () => {
    assertConfigRejected(
      {
        UPSTASH_REDIS_REST_TOKEN: FAKE_UPSTASH_TOKEN,
        RATE_LIMIT_HMAC_SECRET: FAKE_HMAC_32,
      },
      /UPSTASH_REDIS_REST_URL/,
    )
  })

  it('refuse token absent', () => {
    assertConfigRejected(
      {
        UPSTASH_REDIS_REST_URL: FAKE_UPSTASH_URL,
        RATE_LIMIT_HMAC_SECRET: FAKE_HMAC_32,
      },
      /UPSTASH_REDIS_REST_TOKEN/,
    )
  })

  it('refuse secret HMAC absent', () => {
    assertConfigRejected(
      {
        UPSTASH_REDIS_REST_URL: FAKE_UPSTASH_URL,
        UPSTASH_REDIS_REST_TOKEN: FAKE_UPSTASH_TOKEN,
      },
      /RATE_LIMIT_HMAC_SECRET/,
    )
  })

  it('refuse secret HMAC de moins de 32 octets', () => {
    assertConfigRejected(
      {
        UPSTASH_REDIS_REST_URL: FAKE_UPSTASH_URL,
        UPSTASH_REDIS_REST_TOKEN: FAKE_UPSTASH_TOKEN,
        RATE_LIMIT_HMAC_SECRET: FAKE_HMAC_SHORT,
      },
      /RATE_LIMIT_HMAC_SECRET/,
    )
  })
})

describe('httpError — 429 / 503 publics', () => {
  it('expose 429 et 503', () => {
    assert.ok(PUBLIC_HTTP_STATUSES.includes(429))
    assert.ok(PUBLIC_HTTP_STATUSES.includes(503))
    const limited = new RateLimitExceededError(42)
    const classified = classifyHttpError(limited)
    assert.equal(classified.status, 429)
    assert.equal(classified.message, RATE_LIMIT_PUBLIC_MESSAGE)
    assert.equal(classified.internal, false)

    const unavail = new RateLimitUnavailableError()
    const c2 = classifyHttpError(unavail)
    assert.equal(c2.status, 503)
    assert.equal(c2.message, RATE_LIMIT_UNAVAILABLE_MESSAGE)
  })
})

describe('memory limiters — compteurs partagés', () => {
  it('sous le seuil autorisé ; dépassement → 429 ; Retry-After positif', async () => {
    const state = new Map()
    const runtime = testRuntime(state)
    const email = 'ok@example.com'

    for (let i = 0; i < 10; i += 1) {
      await enforceAuthRateLimit('login', {
        ip: IP_A,
        email,
        runtime,
      })
    }

    await assert.rejects(
      () =>
        enforceAuthRateLimit('login', {
          ip: IP_A,
          email,
          runtime,
        }),
      (err) => {
        assert.ok(err instanceof RateLimitExceededError)
        assert.equal(err.status, 429)
        assert.equal(err.message, RATE_LIMIT_PUBLIC_MESSAGE)
        assert.ok(err.retryAfterSec >= 1)
        return true
      },
    )
  })

  it('deux instances simulées partagent le store', async () => {
    const state = new Map()
    const runtimeA = testRuntime(state)
    const runtimeB = testRuntime(state)
    const email = 'shared@example.com'

    for (let i = 0; i < 5; i += 1) {
      await enforceAuthRateLimit('login', {
        ip: IP_A,
        email,
        runtime: runtimeA,
      })
    }
    for (let i = 0; i < 5; i += 1) {
      await enforceAuthRateLimit('login', {
        ip: IP_A,
        email,
        runtime: runtimeB,
      })
    }
    await assert.rejects(
      () =>
        enforceAuthRateLimit('login', {
          ip: IP_A,
          email,
          runtime: runtimeA,
        }),
      (err) => err instanceof RateLimitExceededError,
    )
  })

  it('même email depuis deux IP : compteurs login-pair indépendants', async () => {
    const state = new Map()
    const runtime = testRuntime(state)
    const email = 'multi-ip@example.com'

    for (let i = 0; i < 10; i += 1) {
      await enforceAuthRateLimit('login', {
        ip: IP_A,
        email,
        runtime,
      })
    }
    // IP_A pair saturé ; IP_B encore libre sur le couple (limites IP globales plus hautes).
    await enforceAuthRateLimit('login', {
      ip: IP_B,
      email,
      runtime,
    })
  })

  it('courte et longue durée consommées (register 3/h puis 5/24h)', async () => {
    let now = 1_700_000_000_000
    const state = new Map()
    const runtime = testRuntime(state, { now: () => now })

    for (let i = 0; i < 3; i += 1) {
      await enforceAuthRateLimit('register', { ip: IP_A, runtime, now: () => now })
    }
    // 4e tentative : refusée mais consomme aussi le compteur 24h (→ 4/5).
    await assert.rejects(
      () =>
        enforceAuthRateLimit('register', {
          ip: IP_A,
          runtime,
          now: () => now,
        }),
      (err) => err instanceof RateLimitExceededError,
    )

    // Après 1h : fenêtre 1h reset ; 24h a encore 4 → 1 restante puis refus.
    now += 60 * 60 * 1000 + 1
    await enforceAuthRateLimit('register', {
      ip: IP_A,
      runtime,
      now: () => now,
    })
    await assert.rejects(
      () =>
        enforceAuthRateLimit('register', {
          ip: IP_A,
          runtime,
          now: () => now,
        }),
      (err) => err instanceof RateLimitExceededError,
    )
  })

  it('timeout reason → fail-open login / fail-closed register', async () => {
    const openRuntime = testRuntime(new Map(), { forceTimeout: true })
    await enforceAuthRateLimit('login', {
      ip: IP_A,
      email: 't@x.com',
      runtime: openRuntime,
    })

    const closedRuntime = testRuntime(new Map(), { forceTimeout: true })
    await assert.rejects(
      () =>
        enforceAuthRateLimit('register', {
          ip: IP_A,
          runtime: closedRuntime,
        }),
      (err) => {
        assert.ok(err instanceof RateLimitUnavailableError)
        assert.equal(err.status, 503)
        assert.equal(err.message, RATE_LIMIT_UNAVAILABLE_MESSAGE)
        return true
      },
    )
  })

  it('erreur réseau → fail-open reset / fail-closed forgot', async () => {
    const openRuntime = testRuntime(new Map(), { forceNetworkError: true })
    await enforceAuthRateLimit('reset-password', {
      ip: IP_A,
      resetToken: 'abc',
      runtime: openRuntime,
    })

    const closedRuntime = testRuntime(new Map(), {
      forceNetworkError: true,
    })
    await assert.rejects(
      () =>
        enforceAuthRateLimit('forgot-password', {
          ip: IP_A,
          email: 'f@x.com',
          runtime: closedRuntime,
        }),
      (err) => err instanceof RateLimitUnavailableError,
    )
  })

  it('retryAfterSecondsFromReset', () => {
    const now = 1_000_000
    assert.equal(retryAfterSecondsFromReset(now + 2500, () => now), 3)
    assert.equal(retryAfterSecondsFromReset(now - 1000, () => now), 1)
  })
})

describe('HTTP auth rate limit', () => {
  /** @type {typeof import('./app.js').default} */
  let app
  /** @type {Map<string, number[]>} */
  let sharedState

  const envSnapshot = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    APP_URL: process.env.APP_URL,
  }

  beforeEach(async () => {
    resetRateLimitTestState()
    process.env.NODE_ENV = 'test'
    process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
    process.env.APP_URL = 'https://expiry.example.com'
    sharedState = new Map()
    const runtime = testRuntime(sharedState)
    setRateLimitRuntimeForTests(() => runtime)
    setAssertAuthRateLimitOverridesForTests({
      injectedIp: IP_A,
      runtime,
    })
    const mod = await import('./app.js')
    app = mod.default
  })

  afterEach(() => {
    resetRateLimitTestState()
    process.env.NODE_ENV = envSnapshot.NODE_ENV
    process.env.JWT_SECRET = envSnapshot.JWT_SECRET
    process.env.APP_URL = envSnapshot.APP_URL
  })

  it('login dépassement couple IP/email → 429 + Retry-After', async () => {
    const body = JSON.stringify({
      email: 'rate@example.com',
      password: 'irrelevant',
    })
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      // Sous le seuil : 401 métier (pas de DB) ou 500 — pas 429
      assert.notEqual(res.status, 429)
    }
    const blocked = await app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(blocked.status, 429)
    const payload = await blocked.json()
    assert.equal(payload.error, RATE_LIMIT_PUBLIC_MESSAGE)
    assert.ok(Number(blocked.headers.get('Retry-After')) >= 1)
    assert.doesNotMatch(JSON.stringify(payload), /upstash|redis|203\.0\.113/i)
  })

  it('register panne Upstash → 503 avant SQL', async () => {
    const runtime = testRuntime(new Map(), { forceNetworkError: true })
    setRateLimitRuntimeForTests(() => runtime)
    setAssertAuthRateLimitOverridesForTests({
      injectedIp: IP_A,
      runtime,
    })
    const res = await app.request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nom: 'Pharma',
        email: 'new@example.com',
        password: 'password1',
        siret: '73282932000074',
      }),
    })
    assert.equal(res.status, 503)
    const payload = await res.json()
    assert.equal(payload.error, RATE_LIMIT_UNAVAILABLE_MESSAGE)
  })

  it('forgot-password config absente (runtime null + env production) → 503', async () => {
    setRateLimitRuntimeForTests(() => null)
    setAssertAuthRateLimitOverridesForTests({
      injectedIp: IP_A,
      runtime: null,
      env: {
        NODE_ENV: 'production',
        VERCEL_ENV: 'production',
      },
    })
    const res = await app.request('http://localhost/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anyone@example.com' }),
    })
    assert.equal(res.status, 503)
  })

  /**
   * @param {'production' | 'preview'} vercelEnv
   */
  async function assertMissingClientIpReturns503(vercelEnv) {
    let limiterCalled = false
    const runtime = testRuntime(new Map())
    for (const [id, lim] of Object.entries(runtime.limiters)) {
      const orig = lim.limit.bind(lim)
      runtime.limiters[id] = {
        async limit(identifier) {
          limiterCalled = true
          return orig(identifier)
        },
      }
    }

    setRateLimitRuntimeForTests(() => runtime)
    setAssertAuthRateLimitOverridesForTests({
      // Pas d’IP injectée : force la résolution headers (absents).
      injectedIp: null,
      runtime,
      env: {
        NODE_ENV: 'production',
        VERCEL: '1',
        VERCEL_ENV: vercelEnv,
      },
    })

    const res = await app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'missing-ip@example.com',
        password: 'irrelevant',
      }),
    })

    assert.equal(res.status, 503)
    const payload = await res.json()
    assert.equal(payload.error, RATE_LIMIT_UNAVAILABLE_MESSAGE)
    assert.equal(limiterCalled, false, 'aucun compteur RL ni métier ne doit tourner')
    assert.doesNotMatch(
      JSON.stringify(payload),
      /RATE_LIMIT_CLIENT_IP|ClientIp|upstash|redis|ECONN|stack|VERCEL_ENV|203\.0\.113/i,
    )
  }

  it('login IP absente en Production (VERCEL=1) → 503 générique avant métier', async () => {
    await assertMissingClientIpReturns503('production')
  })

  it('login IP absente en Preview (VERCEL=1) → 503 générique avant métier', async () => {
    await assertMissingClientIpReturns503('preview')
  })

  it('forgot-password dépassement → 429 générique', async () => {
    const email = 'forgot@example.com'
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request(
        'http://localhost/api/auth/forgot-password',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        },
      )
      assert.notEqual(res.status, 429)
    }
    const blocked = await app.request(
      'http://localhost/api/auth/forgot-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      },
    )
    assert.equal(blocked.status, 429)
    const payload = await blocked.json()
    assert.equal(payload.error, RATE_LIMIT_PUBLIC_MESSAGE)
  })

  it('reset-password timeout → fail-open (passe le RL)', async () => {
    const runtime = testRuntime(new Map(), { forceTimeout: true })
    setRateLimitRuntimeForTests(() => runtime)
    setAssertAuthRateLimitOverridesForTests({
      injectedIp: IP_A,
      runtime,
    })
    const res = await app.request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'deadbeef',
        password: 'newpassword1',
      }),
    })
    // Pas 429/503 du RL — erreur métier/interne ensuite
    assert.notEqual(res.status, 429)
    assert.notEqual(res.status, 503)
  })

  it('autres routes non soumises au rate limit auth', async () => {
    const res = await app.request('http://localhost/api/health')
    assert.equal(res.status, 200)
  })

  it('assertAuthRateLimit skip en test sans runtime', async () => {
    resetRateLimitTestState()
    setRateLimitRuntimeForTests(() => null)
    const { Hono } = await import('hono')
    const h = new Hono()
    h.post('/t', async (c) => {
      const result = await assertAuthRateLimit(c, 'login', {
        email: 'x@y.z',
        env: { NODE_ENV: 'test' },
      })
      return c.json(result)
    })
    const res = await h.request('http://localhost/t', { method: 'POST' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.skipped, true)
  })
})
