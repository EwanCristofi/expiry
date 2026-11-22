/**
 * Quota mensuel de création de références dans `parapharma_ref`.
 * La logique atomique vit en PostgreSQL (`try_create_parapharma_ref`).
 */

/** Nombre max de nouvelles références par pharmacie et par mois calendaire (Europe/Paris). */
export const PARAPHARMA_REF_MONTHLY_QUOTA = 100

/** @typedef {'created' | 'already_exists' | 'quota_exceeded'} ParapharmaRefStatus */

export const PARAPHARMA_REF_STATUS = Object.freeze({
  CREATED: /** @type {const} */ ('created'),
  ALREADY_EXISTS: /** @type {const} */ ('already_exists'),
  QUOTA_EXCEEDED: /** @type {const} */ ('quota_exceeded'),
})

/**
 * Message utilisateur lorsque le scan est enregistré mais la ref refusée pour quota.
 * @param {number} [limit=PARAPHARMA_REF_MONTHLY_QUOTA]
 */
export function quotaExceededUserMessage(
  limit = PARAPHARMA_REF_MONTHLY_QUOTA,
) {
  return (
    `Scan enregistré. La référence n’a pas été ajoutée au référentiel partagé : ` +
    `quota mensuel de ${limit} nouvelles références atteint.`
  )
}

/**
 * @param {unknown} raw
 * @returns {ParapharmaRefStatus | null}
 */
export function normalizeParapharmaRefStatus(raw) {
  const value = String(raw ?? '').trim()
  if (
    value === PARAPHARMA_REF_STATUS.CREATED ||
    value === PARAPHARMA_REF_STATUS.ALREADY_EXISTS ||
    value === PARAPHARMA_REF_STATUS.QUOTA_EXCEEDED
  ) {
    return value
  }
  return null
}
