import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import {
  resolveClientIp,
  shouldTrustForwardedClientIp,
} from './clientIp.js'
import {
  HttpError,
  logServerError,
  publicHttpError,
} from './httpError.js'
import {
  AUTH_RATE_LIMIT_POLICIES,
  RATE_LIMIT_PUBLIC_MESSAGE,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
} from './rateLimit.policies.js'
import {
  isValidRateLimitHmacSecret,
  normalizeEmail,
  rateLimitEmailKey,
  rateLimitIpKey,
  rateLimitLoginPairKey,
  rateLimitResetTokenKey,
  readRateLimitHmacSecret,
  requireRateLimitHmacSecret,
} from './rateLimitKeys.js'

/** Timeout SDK Upstash (ms) — interpréter `reason === "timeout"` explicitement. */
export const RATE_LIMIT_UPSTASH_TIMEOUT_MS = 500

/** Préfixe versionné des clés Redis. */
export const RATE_LIMIT_KEY_VERSION = 'expiry:rl:v1'

/**
 * @typedef {'production' | 'preview' | 'development' | 'test'} RateLimitDeployEnv
 */

/**
 * @typedef {{
 *   success: boolean,
 *   limit: number,
 *   remaining: number,
 *   reset: number,
 *   reason?: string,
 *   pending?: Promise<unknown>,
 * }} RateLimitAttemptResult
 */

/**
 * @typedef {{
 *   limit: (identifier: string) => Promise<RateLimitAttemptResult>,
 * }} RateLimiterHandle
 */

/**
 * @typedef {Record<string, RateLimiterHandle>} RateLimiterMap
 */

/**
 * @typedef {{
 *   limiters: RateLimiterMap,
 *   hmacSecret: string,
 *   deployEnv: RateLimitDeployEnv,
 *   now?: () => number,
 * }} RateLimitRuntime
 */

/** @type {RateLimitRuntime | null | undefined} */
let cachedRuntime = undefined

/** @type {null | (() => RateLimitRuntime | null)} */
let runtimeFactoryOverride = null

/**
 * Surcharges assertAuthRateLimit (tests uniquement).
 * @type {{
 *   injectedIp?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   runtime?: RateLimitRuntime | null,
 * } | null}
 */
let assertOverridesForTests = null

/**
 * Injection runtime (tests uniquement). `null` restaure le lazy init réel.
 * Passer une factory qui renvoie `null` pour simuler « non configuré ».
 * @param {null | (() => RateLimitRuntime | null)} factory
 */
export function setRateLimitRuntimeForTests(factory) {
  runtimeFactoryOverride = factory
  cachedRuntime = undefined
}

/**
 * @param {{
 *   injectedIp?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   runtime?: RateLimitRuntime | null,
 * } | null} overrides
 */
export function setAssertAuthRateLimitOverridesForTests(overrides) {
  assertOverridesForTests = overrides
}

/**
 * Remet le cache d’init (tests).
 */
export function resetRateLimitRuntimeCache() {
  cachedRuntime = undefined
}

/**
 * Remet toutes les injections de test.
 */
export function resetRateLimitTestState() {
  runtimeFactoryOverride = null
  assertOverridesForTests = null
  cachedRuntime = undefined
}

/**
 * Identifie l’espace de clés / le mode de déploiement.
 * Sur Vercel, `VERCEL_ENV` est la source de vérité.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {RateLimitDeployEnv}
 */
export function resolveRateLimitDeployEnv(env = process.env) {
  if (String(env.NODE_ENV || '').trim() === 'test') {
    return 'test'
  }

  const vercelEnv = String(env.VERCEL_ENV || '')
    .trim()
    .toLowerCase()
  if (vercelEnv === 'production') return 'production'
  if (vercelEnv === 'preview') return 'preview'
  if (vercelEnv === 'development') return 'development'

  // Sur Vercel sans VERCEL_ENV : ambigu → erreur de config (pas de préfixe flou).
  if (String(env.VERCEL || '').trim() === '1') {
    const err = new Error(
      'VERCEL_ENV manquant : impossible d’isoler les compteurs rate-limit',
    )
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }

  if (String(env.NODE_ENV || '').trim() === 'production') {
    // Build local / script hors Vercel : espace « production » explicite.
    return 'production'
  }

  return 'development'
}

/**
 * Rate limiting obligatoire (config absente = 503, jamais skip silencieux).
 * @param {RateLimitDeployEnv} deployEnv
 */
export function isRateLimitConfigRequired(deployEnv) {
  return deployEnv === 'production' || deployEnv === 'preview'
}

/**
 * Skip explicite autorisé uniquement en development local sans Upstash.
 * Impossible en production/preview.
 * @param {RateLimitDeployEnv} deployEnv
 */
export function maySkipRateLimitWhenUnconfigured(deployEnv) {
  return deployEnv === 'development'
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function readUpstashRestConfig(env = process.env) {
  const url = String(env.UPSTASH_REDIS_REST_URL ?? '').trim()
  const token = String(env.UPSTASH_REDIS_REST_TOKEN ?? '').trim()
  return { url, token }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isValidUpstashRestUrl(url) {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertRateLimitEnvConfigured(env = process.env) {
  const { url, token } = readUpstashRestConfig(env)
  const hmac = readRateLimitHmacSecret(env)

  if (!isValidUpstashRestUrl(url)) {
    const err = new Error(
      'UPSTASH_REDIS_REST_URL manquante ou invalide (HTTPS requis)',
    )
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  if (!token) {
    const err = new Error('UPSTASH_REDIS_REST_TOKEN manquant')
    err.name = 'RateLimitConfigError'
    err.code = 'RATE_LIMIT_CONFIG'
    throw err
  }
  requireRateLimitHmacSecret(hmac)
  return { url, token, hmacSecret: hmac }
}

/**
 * @param {RateLimitDeployEnv} deployEnv
 */
export function rateLimitKeyPrefix(deployEnv) {
  return `${RATE_LIMIT_KEY_VERSION}:${deployEnv}`
}

/**
 * Store mémoire partagé (TESTS UNIQUEMENT) — sliding window simplifié.
 * Plusieurs « instances » doivent partager le même objet `state`.
 *
 * @param {{
 *   state?: Map<string, number[]>,
 *   now?: () => number,
 *   forceTimeout?: boolean | (() => boolean),
 *   forceNetworkError?: boolean | (() => boolean),
 * }} [options]
 * @returns {RateLimiterMap}
 */
export function createMemoryRateLimiters(options = {}) {
  const state = options.state ?? new Map()
  const nowFn = options.now ?? (() => Date.now())

  /**
   * @param {string} ruleId
   * @param {number} max
   * @param {number} windowMs
   * @returns {RateLimiterHandle}
   */
  function makeLimiter(ruleId, max, windowMs) {
    return {
      async limit(identifier) {
        if (
          typeof options.forceNetworkError === 'function'
            ? options.forceNetworkError()
            : options.forceNetworkError
        ) {
          const err = new Error('ECONNRESET')
          err.name = 'RateLimitNetworkError'
          err.code = 'RATE_LIMIT_NETWORK'
          throw err
        }
        if (
          typeof options.forceTimeout === 'function'
            ? options.forceTimeout()
            : options.forceTimeout
        ) {
          return {
            success: true,
            limit: max,
            remaining: max,
            reset: nowFn() + windowMs,
            reason: 'timeout',
            pending: Promise.resolve(),
          }
        }

        const now = nowFn()
        const key = `${ruleId}:${identifier}`
        const cutoff = now - windowMs
        const prev = state.get(key) ?? []
        const kept = prev.filter((ts) => ts > cutoff)
        kept.push(now)
        state.set(key, kept)

        const success = kept.length <= max
        const remaining = Math.max(0, max - kept.length)
        const oldest = kept[0] ?? now
        const reset = oldest + windowMs

        return {
          success,
          limit: max,
          remaining: success ? remaining : 0,
          reset,
          reason: undefined,
          pending: Promise.resolve(),
        }
      },
    }
  }

  /** @type {RateLimiterMap} */
  const limiters = {}
  for (const policy of Object.values(AUTH_RATE_LIMIT_POLICIES)) {
    for (const rule of policy.rules) {
      limiters[rule.id] = makeLimiter(rule.id, rule.max, rule.windowMs)
    }
  }
  return limiters
}

/**
 * @param {{
 *   redis: import('@upstash/redis').Redis,
 *   deployEnv: RateLimitDeployEnv,
 *   timeoutMs?: number,
 * }} options
 * @returns {RateLimiterMap}
 */
export function createUpstashRateLimiters(options) {
  const prefix = rateLimitKeyPrefix(options.deployEnv)
  const timeout = options.timeoutMs ?? RATE_LIMIT_UPSTASH_TIMEOUT_MS
  /** @type {RateLimiterMap} */
  const limiters = {}

  for (const policy of Object.values(AUTH_RATE_LIMIT_POLICIES)) {
    for (const rule of policy.rules) {
      const rl = new Ratelimit({
        redis: options.redis,
        limiter: Ratelimit.slidingWindow(rule.max, rule.window),
        prefix: `${prefix}:${rule.id}`,
        // Pas de cache process-local (évite états divergents entre instances).
        ephemeralCache: false,
        timeout,
      })
      limiters[rule.id] = {
        limit: (identifier) => rl.limit(identifier),
      }
    }
  }
  return limiters
}

/**
 * Construit le runtime Upstash depuis l’env (lazy).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {RateLimitRuntime | null}
 */
export function buildUpstashRateLimitRuntime(env = process.env) {
  const deployEnv = resolveRateLimitDeployEnv(env)
  const required = isRateLimitConfigRequired(deployEnv)
  const { url, token } = readUpstashRestConfig(env)
  const hmac = readRateLimitHmacSecret(env)
  const configured =
    isValidUpstashRestUrl(url) &&
    Boolean(token) &&
    isValidRateLimitHmacSecret(hmac)

  if (!configured) {
    if (required) {
      assertRateLimitEnvConfigured(env)
    }
    // Development : skip explicite (retour null).
    if (maySkipRateLimitWhenUnconfigured(deployEnv)) {
      return null
    }
    // test sans injection → null (les tests injectent un runtime).
    if (deployEnv === 'test') return null
    assertRateLimitEnvConfigured(env)
  }

  const cfg = assertRateLimitEnvConfigured(env)
  const redis = new Redis({ url: cfg.url, token: cfg.token })
  return {
    deployEnv,
    hmacSecret: cfg.hmacSecret,
    limiters: createUpstashRateLimiters({ redis, deployEnv }),
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {RateLimitRuntime | null}
 */
export function getRateLimitRuntime(env = process.env) {
  if (runtimeFactoryOverride) {
    return runtimeFactoryOverride()
  }
  if (cachedRuntime !== undefined) {
    return cachedRuntime
  }
  try {
    cachedRuntime = buildUpstashRateLimitRuntime(env)
  } catch (err) {
    // Ne pas cacher une config invalide comme « null » (skip) : propager.
    if (err?.name === 'RateLimitConfigError' || err?.code === 'RATE_LIMIT_CONFIG') {
      cachedRuntime = undefined
      throw err
    }
    cachedRuntime = undefined
    throw err
  }
  return cachedRuntime
}

/**
 * Erreur publique 429 (+ Retry-After côté handler).
 */
export class RateLimitExceededError extends HttpError {
  /**
   * @param {number} [retryAfterSec]
   */
  constructor(retryAfterSec = 60) {
    super(RATE_LIMIT_PUBLIC_MESSAGE, {
      status: 429,
      expose: true,
      code: 'RATE_LIMITED',
    })
    this.name = 'RateLimitExceededError'
    const sec = Math.max(1, Math.ceil(Number(retryAfterSec) || 60))
    /** @type {number} */
    this.retryAfterSec = sec
  }
}

/**
 * Service rate-limit indisponible (config ou panne fail-closed) → 503.
 */
export class RateLimitUnavailableError extends HttpError {
  /**
   * @param {unknown} [cause]
   * @param {{ code?: string }} [options]
   */
  constructor(cause, options = {}) {
    super(RATE_LIMIT_UNAVAILABLE_MESSAGE, {
      status: 503,
      expose: true,
      code: options.code || 'RATE_LIMIT_UNAVAILABLE',
      cause,
    })
    this.name = 'RateLimitUnavailableError'
  }
}

/**
 * @param {number} resetMs
 * @param {() => number} nowFn
 */
export function retryAfterSecondsFromReset(resetMs, nowFn = Date.now) {
  const delta = Math.ceil((Number(resetMs) - nowFn()) / 1000)
  return Math.max(1, Number.isFinite(delta) ? delta : 60)
}

/**
 * @param {import('./rateLimit.policies.js').AuthRateLimitSurface} surface
 * @param {string} hmacSecret
 * @param {{ ip: string, email?: unknown, resetToken?: unknown }} subjects
 * @returns {Record<string, string>}
 */
function resolveSubjectKeys(surface, hmacSecret, subjects) {
  const policy = AUTH_RATE_LIMIT_POLICIES[surface]
  /** @type {Record<string, string>} */
  const byRule = {}
  const emailNorm = normalizeEmail(subjects.email)
  const tokenRaw = String(subjects.resetToken ?? '').trim()

  for (const rule of policy.rules) {
    if (rule.subject === 'ip') {
      byRule[rule.id] = rateLimitIpKey(hmacSecret, subjects.ip)
      continue
    }
    if (rule.subject === 'login-pair') {
      // Sans email : seules les limites IP s’appliquent (le métier renverra 400/401).
      if (!emailNorm) continue
      byRule[rule.id] = rateLimitLoginPairKey(
        hmacSecret,
        subjects.ip,
        emailNorm,
      )
      continue
    }
    if (rule.subject === 'email') {
      if (!emailNorm) continue
      byRule[rule.id] = rateLimitEmailKey(hmacSecret, emailNorm)
      continue
    }
    if (rule.subject === 'reset-token') {
      if (!tokenRaw) continue
      byRule[rule.id] = rateLimitResetTokenKey(hmacSecret, tokenRaw)
    }
  }
  return byRule
}

/**
 * Applique toutes les règles d’une surface (sans court-circuit).
 *
 * @param {import('./rateLimit.policies.js').AuthRateLimitSurface} surface
 * @param {{
 *   ip: string,
 *   email?: unknown,
 *   resetToken?: unknown,
 *   runtime?: RateLimitRuntime | null,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 * }} options
 */
export async function enforceAuthRateLimit(surface, options = {}) {
  const env = options.env ?? process.env
  const nowFn = options.now ?? Date.now
  const policy = AUTH_RATE_LIMIT_POLICIES[surface]
  if (!policy) {
    throw publicHttpError('Surface rate-limit inconnue', 500)
  }

  let runtime
  try {
    runtime =
      options.runtime !== undefined
        ? options.runtime
        : getRateLimitRuntime(env)
  } catch (err) {
    if (err?.name === 'RateLimitConfigError' || err?.code === 'RATE_LIMIT_CONFIG') {
      logServerError('rateLimit/config', err)
      throw new RateLimitUnavailableError(err, { code: 'RATE_LIMIT_CONFIG' })
    }
    throw err
  }

  if (!runtime) {
    const deployEnv = resolveRateLimitDeployEnv(env)
    if (maySkipRateLimitWhenUnconfigured(deployEnv)) {
      // Développement local sans Upstash : skip explicite.
      return { skipped: true, reason: 'development_unconfigured' }
    }
    if (deployEnv === 'test') {
      // Tests sans injection : skip (les suites HTTP injectent un runtime).
      return { skipped: true, reason: 'test_unconfigured' }
    }
    logServerError('rateLimit/config', {
      name: 'RateLimitConfigError',
      code: 'RATE_LIMIT_CONFIG',
    })
    throw new RateLimitUnavailableError(undefined, {
      code: 'RATE_LIMIT_CONFIG',
    })
  }

  const keys = resolveSubjectKeys(surface, runtime.hmacSecret, {
    ip: options.ip,
    email: options.email,
    resetToken: options.resetToken,
  })

  /** @type {RateLimitAttemptResult[]} */
  const results = []
  /** @type {unknown} */
  let networkError = null

  const activeRules = policy.rules.filter((rule) => keys[rule.id])

  // Toutes les règles applicables, en parallèle — pas de court-circuit
  // (ex. courte + longue durée toujours consommées ensemble).
  const settled = await Promise.all(
    activeRules.map(async (rule) => {
      const limiter = runtime.limiters[rule.id]
      if (!limiter) {
        const err = new Error(`Limiter manquant: ${rule.id}`)
        err.name = 'RateLimitConfigError'
        err.code = 'RATE_LIMIT_CONFIG'
        throw err
      }
      try {
        const result = await limiter.limit(keys[rule.id])
        return { rule, result, error: null }
      } catch (err) {
        return { rule, result: null, error: err }
      }
    }),
  )

  let sawTimeout = false
  let blocked = false
  let maxRetryAfter = 1

  for (const item of settled) {
    if (item.error) {
      networkError = item.error
      continue
    }
    const result = /** @type {RateLimitAttemptResult} */ (item.result)
    results.push(result)

    if (result.reason === 'timeout') {
      sawTimeout = true
      continue
    }

    if (!result.success) {
      blocked = true
      maxRetryAfter = Math.max(
        maxRetryAfter,
        retryAfterSecondsFromReset(result.reset, nowFn),
      )
    }
  }

  if (networkError) {
    logServerError('rateLimit/network', {
      name: /** @type {{ name?: string }} */ (networkError)?.name || 'Error',
      code: 'RATE_LIMIT_NETWORK',
    })
    if (policy.networkFailMode === 'closed') {
      throw new RateLimitUnavailableError(networkError, {
        code: 'RATE_LIMIT_NETWORK',
      })
    }
    // fail-open : continuer (éventuellement après un 429 d’une autre règle)
  }

  if (sawTimeout) {
    logServerError('rateLimit/timeout', {
      name: 'RateLimitTimeout',
      code: 'RATE_LIMIT_TIMEOUT',
    })
    if (policy.networkFailMode === 'closed') {
      throw new RateLimitUnavailableError(undefined, {
        code: 'RATE_LIMIT_TIMEOUT',
      })
    }
  }

  if (blocked) {
    throw new RateLimitExceededError(maxRetryAfter)
  }

  return { skipped: false, results }
}

/**
 * Résout l’IP fiable pour une surface auth, ou 503 si obligatoire et absente.
 *
 * @param {import('hono').Context} c
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   injectedIp?: string | null,
 * }} [options]
 */
export function requireClientIpForRateLimit(c, options = {}) {
  const env = options.env ?? process.env
  const deployEnv = resolveRateLimitDeployEnv(env)
  const trust = shouldTrustForwardedClientIp(env)

  const resolved = resolveClientIp(
    { header: (name) => c.req.header(name) },
    {
      env,
      trustForwardedHeaders: trust,
      injectedIp: options.injectedIp,
    },
  )

  if (resolved.ok) return resolved.ip

  // Hors Production/Preview : headers non fiables → IP synthétique locale
  // (un seul bucket pour le trafic de développement). Jamais en prod/preview.
  if (!isRateLimitConfigRequired(deployEnv)) {
    return '127.0.0.1'
  }

  logServerError('rateLimit/clientIp', {
    name: 'ClientIpError',
    code: resolved.reason || 'missing',
  })
  throw new RateLimitUnavailableError(undefined, {
    code: 'RATE_LIMIT_CLIENT_IP',
  })
}

/**
 * Helper Hono : enforce + mapping erreurs déjà HttpError.
 *
 * @param {import('hono').Context} c
 * @param {import('./rateLimit.policies.js').AuthRateLimitSurface} surface
 * @param {{
 *   email?: unknown,
 *   resetToken?: unknown,
 *   injectedIp?: string | null,
 *   runtime?: RateLimitRuntime | null,
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 * }} [options]
 */
export async function assertAuthRateLimit(c, surface, options = {}) {
  const testOv = assertOverridesForTests
  const env = options.env ?? testOv?.env ?? process.env
  const injectedIp =
    options.injectedIp !== undefined
      ? options.injectedIp
      : testOv?.injectedIp
  const now = options.now ?? testOv?.now
  const runtimeOpt =
    options.runtime !== undefined
      ? options.runtime
      : testOv && Object.prototype.hasOwnProperty.call(testOv, 'runtime')
        ? testOv.runtime
        : undefined

  let runtime
  try {
    runtime =
      runtimeOpt !== undefined ? runtimeOpt : getRateLimitRuntime(env)
  } catch (err) {
    if (err?.name === 'RateLimitConfigError' || err?.code === 'RATE_LIMIT_CONFIG') {
      logServerError('rateLimit/config', err)
      throw new RateLimitUnavailableError(err, { code: 'RATE_LIMIT_CONFIG' })
    }
    throw err
  }

  if (!runtime) {
    const deployEnv = resolveRateLimitDeployEnv(env)
    if (
      maySkipRateLimitWhenUnconfigured(deployEnv) ||
      deployEnv === 'test'
    ) {
      return {
        skipped: true,
        reason:
          deployEnv === 'test'
            ? 'test_unconfigured'
            : 'development_unconfigured',
      }
    }
    logServerError('rateLimit/config', {
      name: 'RateLimitConfigError',
      code: 'RATE_LIMIT_CONFIG',
    })
    throw new RateLimitUnavailableError(undefined, {
      code: 'RATE_LIMIT_CONFIG',
    })
  }

  const ip = requireClientIpForRateLimit(c, {
    env,
    injectedIp,
  })

  return enforceAuthRateLimit(surface, {
    ip,
    email: options.email,
    resetToken: options.resetToken,
    runtime,
    env,
    now,
  })
}

export {
  AUTH_RATE_LIMIT_POLICIES,
  RATE_LIMIT_PUBLIC_MESSAGE,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
  normalizeEmail,
}
