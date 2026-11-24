/**
 * Politiques de rate limiting auth (sliding windows).
 *
 * failMode réseau :
 * - open  → panne/timeout Upstash : laisser passer (+ log)
 * - closed → panne/timeout Upstash : 503
 *
 * Configuration manquante/invalide → toujours 503 (jamais fail-open silencieux).
 */

/** @typedef {'login' | 'register' | 'forgot-password' | 'reset-password'} AuthRateLimitSurface */

/**
 * @typedef {{
 *   id: string,
 *   subject: 'ip' | 'login-pair' | 'email' | 'reset-token',
 *   max: number,
 *   window: import('@upstash/ratelimit').Duration,
 *   windowMs: number,
 * }} RateLimitRule
 */

/**
 * @typedef {{
 *   surface: AuthRateLimitSurface,
 *   networkFailMode: 'open' | 'closed',
 *   rules: RateLimitRule[],
 * }} RateLimitPolicy
 */

/** @type {Readonly<Record<AuthRateLimitSurface, RateLimitPolicy>>} */
export const AUTH_RATE_LIMIT_POLICIES = Object.freeze({
  login: Object.freeze({
    surface: /** @type {const} */ ('login'),
    networkFailMode: /** @type {const} */ ('open'),
    rules: Object.freeze([
      Object.freeze({
        id: 'login_ip_15m',
        subject: /** @type {const} */ ('ip'),
        max: 20,
        window: /** @type {const} */ ('15 m'),
        windowMs: 15 * 60 * 1000,
      }),
      Object.freeze({
        id: 'login_ip_24h',
        subject: /** @type {const} */ ('ip'),
        max: 100,
        window: /** @type {const} */ ('24 h'),
        windowMs: 24 * 60 * 60 * 1000,
      }),
      Object.freeze({
        id: 'login_pair_15m',
        subject: /** @type {const} */ ('login-pair'),
        max: 10,
        window: /** @type {const} */ ('15 m'),
        windowMs: 15 * 60 * 1000,
      }),
      Object.freeze({
        id: 'login_pair_24h',
        subject: /** @type {const} */ ('login-pair'),
        max: 30,
        window: /** @type {const} */ ('24 h'),
        windowMs: 24 * 60 * 60 * 1000,
      }),
    ]),
  }),
  register: Object.freeze({
    surface: /** @type {const} */ ('register'),
    networkFailMode: /** @type {const} */ ('closed'),
    rules: Object.freeze([
      Object.freeze({
        id: 'register_ip_1h',
        subject: /** @type {const} */ ('ip'),
        max: 3,
        window: /** @type {const} */ ('1 h'),
        windowMs: 60 * 60 * 1000,
      }),
      Object.freeze({
        id: 'register_ip_24h',
        subject: /** @type {const} */ ('ip'),
        max: 5,
        window: /** @type {const} */ ('24 h'),
        windowMs: 24 * 60 * 60 * 1000,
      }),
    ]),
  }),
  'forgot-password': Object.freeze({
    surface: /** @type {const} */ ('forgot-password'),
    networkFailMode: /** @type {const} */ ('closed'),
    rules: Object.freeze([
      Object.freeze({
        id: 'forgot_ip_1h',
        subject: /** @type {const} */ ('ip'),
        max: 5,
        window: /** @type {const} */ ('1 h'),
        windowMs: 60 * 60 * 1000,
      }),
      Object.freeze({
        id: 'forgot_ip_24h',
        subject: /** @type {const} */ ('ip'),
        max: 15,
        window: /** @type {const} */ ('24 h'),
        windowMs: 24 * 60 * 60 * 1000,
      }),
      Object.freeze({
        id: 'forgot_email_1h',
        subject: /** @type {const} */ ('email'),
        max: 3,
        window: /** @type {const} */ ('1 h'),
        windowMs: 60 * 60 * 1000,
      }),
      Object.freeze({
        id: 'forgot_email_24h',
        subject: /** @type {const} */ ('email'),
        max: 5,
        window: /** @type {const} */ ('24 h'),
        windowMs: 24 * 60 * 60 * 1000,
      }),
    ]),
  }),
  'reset-password': Object.freeze({
    surface: /** @type {const} */ ('reset-password'),
    networkFailMode: /** @type {const} */ ('open'),
    rules: Object.freeze([
      Object.freeze({
        id: 'reset_ip_15m',
        subject: /** @type {const} */ ('ip'),
        max: 20,
        window: /** @type {const} */ ('15 m'),
        windowMs: 15 * 60 * 1000,
      }),
      Object.freeze({
        id: 'reset_token_15m',
        subject: /** @type {const} */ ('reset-token'),
        max: 5,
        window: /** @type {const} */ ('15 m'),
        windowMs: 15 * 60 * 1000,
      }),
    ]),
  }),
})

export const RATE_LIMIT_PUBLIC_MESSAGE =
  'Trop de tentatives. Réessayez plus tard.'

export const RATE_LIMIT_UNAVAILABLE_MESSAGE =
  'Service temporairement indisponible'
