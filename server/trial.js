import { createSql } from './db.js'

/**
 * @param {string} pharmacyId
 * @returns {Promise<{
 *   id: string,
 *   status: string,
 *   trial_ends_at: string | null,
 *   trialExpired: boolean,
 * } | null>}
 */
export async function getPharmacyTrial(pharmacyId) {
  const sql = createSql()
  const rows = await sql`
    SELECT id, status, trial_ends_at
    FROM pharmacies
    WHERE id = ${pharmacyId}::uuid
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null

  const status = String(row.status || '')
  const trialEndsAt = row.trial_ends_at
    ? new Date(row.trial_ends_at).toISOString()
    : null
  const trialExpired =
    status === 'TRIAL' &&
    Boolean(trialEndsAt) &&
    new Date(trialEndsAt).getTime() <= Date.now()
  const suspended = status === 'SUSPENDED'

  return {
    id: String(row.id),
    status,
    trial_ends_at: trialEndsAt,
    trialExpired,
    suspended,
    accessBlocked: suspended || trialExpired,
  }
}

/**
 * Jours restants d’essai (0 si expiré / absent).
 * @param {string | null | undefined} trialEndsAt
 */
export function remainingTrialDays(trialEndsAt) {
  if (!trialEndsAt) return 0
  const ms = new Date(trialEndsAt).getTime() - Date.now()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}
