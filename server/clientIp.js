import { isIP } from 'node:net'

/**
 * Environnements où les headers de forwarding Vercel sont fiables.
 * En local / development, ces headers ne doivent pas être considérés comme
 * authentiques (un client pourrait les forger).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldTrustForwardedClientIp(env = process.env) {
  const vercelEnv = String(env.VERCEL_ENV || '')
    .trim()
    .toLowerCase()
  return vercelEnv === 'production' || vercelEnv === 'preview'
}

/**
 * Extrait et valide une adresse IP depuis une valeur d’en-tête.
 * Prend la première entrée d’une liste CSV.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function parseFirstValidIp(raw) {
  if (raw == null) return null
  const first = String(raw)
    .split(',')[0]
    ?.trim()
  if (!first) return null
  if (first.toLowerCase() === 'unknown') return null
  // Strip éventuel port IPv4 (rare) : 1.2.3.4:1234 — isIP refuse ; on ne l’accepte pas.
  // IPv6 bracket form [addr] → retirer les crochets.
  let candidate = first
  if (candidate.startsWith('[') && candidate.includes(']')) {
    candidate = candidate.slice(1, candidate.indexOf(']'))
  }
  if (isIP(candidate) === 0) return null
  return candidate
}

/**
 * Résultat d’identification IP.
 * @typedef {{
 *   ok: true,
 *   ip: string,
 *   source: 'injected' | 'x-vercel-forwarded-for' | 'x-forwarded-for' | 'x-real-ip',
 * } | {
 *   ok: false,
 *   reason: 'untrusted_environment' | 'missing' | 'invalid',
 * }} ClientIpResult
 */

/**
 * Résout l’IP client pour le rate limiting.
 *
 * Priorité Vercel (doc) : x-vercel-forwarded-for → x-forwarded-for → x-real-ip.
 * La confiance repose sur l’infrastructure Vercel qui remplace XFF — un test
 * unitaire qui fournit XFF ne prouve pas l’authenticité du header.
 *
 * @param {{
 *   header?: (name: string) => string | undefined,
 * } | null | undefined} request
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   trustForwardedHeaders?: boolean,
 *   injectedIp?: string | null,
 * }} [options]
 * @returns {ClientIpResult}
 */
export function resolveClientIp(request, options = {}) {
  const env = options.env ?? process.env
  const injected =
    options.injectedIp != null && String(options.injectedIp).trim() !== ''
      ? String(options.injectedIp).trim()
      : null

  if (injected != null) {
    const ip = parseFirstValidIp(injected)
    if (!ip) return { ok: false, reason: 'invalid' }
    return { ok: true, ip, source: 'injected' }
  }

  const trust =
    options.trustForwardedHeaders ?? shouldTrustForwardedClientIp(env)
  if (!trust) {
    return { ok: false, reason: 'untrusted_environment' }
  }

  const header = request?.header?.bind(request)
  if (typeof header !== 'function') {
    return { ok: false, reason: 'missing' }
  }

  /** @type {Array<{ name: string, source: 'x-vercel-forwarded-for' | 'x-forwarded-for' | 'x-real-ip' }>} */
  const candidates = [
    { name: 'x-vercel-forwarded-for', source: 'x-vercel-forwarded-for' },
    { name: 'x-forwarded-for', source: 'x-forwarded-for' },
    { name: 'x-real-ip', source: 'x-real-ip' },
  ]

  let sawAny = false
  for (const { name, source } of candidates) {
    const raw = header(name)
    if (raw == null || String(raw).trim() === '') continue
    sawAny = true
    const ip = parseFirstValidIp(raw)
    if (ip) return { ok: true, ip, source }
  }

  return { ok: false, reason: sawAny ? 'invalid' : 'missing' }
}
