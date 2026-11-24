/**
 * Classification centralisée des erreurs HTTP.
 *
 * Règle : seules les erreurs explicitement marquées `expose: true` avec un
 * statut public autorisé peuvent transmettre leur message au client.
 * Tout le reste (SQL, Neon, timeout, config, inconnu, statut non autorisé)
 * → message générique.
 */

export const GENERIC_HTTP_ERROR_MESSAGE = 'Erreur serveur'

/**
 * Statuts HTTP publics réellement utilisés par l’application.
 * Un statut hors de cette liste ne peut jamais exposer un message arbitraire.
 */
export const PUBLIC_HTTP_STATUSES = Object.freeze([
  400, 401, 402, 403, 404, 409,
])

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isAllowedPublicStatus(status) {
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    PUBLIC_HTTP_STATUSES.includes(status)
  )
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function pickSqlState(value) {
  if (value == null) return undefined
  const code = typeof value === 'object' && value !== null
    ? /** @type {{ code?: unknown }} */ (value).code
    : value
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/i.test(code)) {
    return code.toUpperCase()
  }
  return undefined
}

/**
 * Métadonnées de log sûres (jamais de message, stack, detail, PII).
 * @param {unknown} err
 * @param {{ status: number }} classified
 * @param {{ method?: string, path?: string, requestId?: string }} [request]
 */
export function buildSafeErrorLogMeta(err, classified, request = {}) {
  const e =
    err && typeof err === 'object'
      ? /** @type {{ name?: string, code?: unknown, cause?: unknown, constructor?: { name?: string } }} */ (
          err
        )
      : null
  const cause =
    e?.cause && typeof e.cause === 'object'
      ? /** @type {{ name?: string, code?: unknown }} */ (e.cause)
      : null

  return {
    method: request.method || undefined,
    path: request.path || undefined,
    requestId: request.requestId || undefined,
    status: classified.status,
    name: e?.name || undefined,
    type: e?.constructor?.name || typeof err,
    pgCode: pickSqlState(e) ?? pickSqlState(cause) ?? undefined,
  }
}

/**
 * Erreur applicative HTTP.
 *
 * - `expose` n’est vrai que s’il est demandé explicitement (`expose: true`)
 *   ET que le statut est dans {@link PUBLIC_HTTP_STATUSES}.
 * - Sinon : jamais exposé (statut HTTP client forcé à 500 via classify).
 * - cause technique distincte du message public.
 */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   status?: number,
   *   expose?: boolean,
   *   code?: string,
   *   cause?: unknown,
   * }} [options]
   */
  constructor(message, options = {}) {
    const rawStatus = Number.isFinite(options.status)
      ? Number(options.status)
      : 400
    const wantsExpose = options.expose === true
    const canExpose = wantsExpose && isAllowedPublicStatus(rawStatus)

    super(String(message || GENERIC_HTTP_ERROR_MESSAGE))
    this.name = 'HttpError'
    /** @type {number} */
    this.status = canExpose ? rawStatus : wantsExpose ? 500 : rawStatus
    /** @type {boolean} */
    this.expose = canExpose
    if (options.code != null) this.code = String(options.code)
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * Erreur métier explicitement publique.
 * @param {string} message
 * @param {number} [status=400]
 * @param {{ code?: string, cause?: unknown }} [options]
 */
export function publicHttpError(message, status = 400, options = {}) {
  return new HttpError(message, {
    status,
    expose: true,
    code: options.code,
    cause: options.cause,
  })
}

/**
 * Erreur interne : cause conservée côté serveur, jamais exposée au client.
 * @param {unknown} [cause]
 * @param {{ status?: number, code?: string }} [options]
 */
export function internalHttpError(cause, options = {}) {
  return new HttpError(GENERIC_HTTP_ERROR_MESSAGE, {
    status: options.status ?? 500,
    expose: false,
    code: options.code,
    cause,
  })
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPublicHttpError(err) {
  return Boolean(
    err &&
      typeof err === 'object' &&
      /** @type {{ expose?: unknown }} */ (err).expose === true &&
      isAllowedPublicStatus(/** @type {{ status?: unknown }} */ (err).status),
  )
}

/**
 * Classe une erreur pour la réponse HTTP client.
 * @param {unknown} err
 * @returns {{ status: number, message: string, internal: boolean }}
 */
export function classifyHttpError(err) {
  if (isPublicHttpError(err)) {
    return {
      status: /** @type {{ status: number }} */ (err).status,
      message: String(
        /** @type {{ message?: unknown }} */ (err).message ||
          GENERIC_HTTP_ERROR_MESSAGE,
      ),
      internal: false,
    }
  }
  return {
    status: 500,
    message: GENERIC_HTTP_ERROR_MESSAGE,
    internal: true,
  }
}

/**
 * Journalisation contrôlée des erreurs internes uniquement.
 * Ne logue pas les 4xx métier attendus.
 * Ne journalise jamais messages bruts, stacks, details PG ou PII.
 *
 * @param {string} scope
 * @param {unknown} err
 * @param {{ status: number, message: string, internal: boolean }} classified
 * @param {{ method?: string, path?: string, requestId?: string }} [request]
 */
export function logHttpError(scope, err, classified, request = {}) {
  if (!classified.internal) return
  console.error(`[${scope}]`, buildSafeErrorLogMeta(err, classified, request))
}

/**
 * Journalisation serveur maîtrisée hors frontière HTTP
 * (catch modules avant rethrow).
 *
 * @param {string} scope
 * @param {unknown} err
 * @param {{ method?: string, path?: string, requestId?: string }} [request]
 */
export function logServerError(scope, err, request = {}) {
  const status =
    err &&
    typeof err === 'object' &&
    typeof /** @type {{ status?: unknown }} */ (err).status === 'number' &&
    /** @type {{ status: number }} */ (err).status >= 500
      ? /** @type {{ status: number }} */ (err).status
      : 500
  console.error(
    `[${scope}]`,
    buildSafeErrorLogMeta(err, { status }, request),
  )
}
