import { createSql } from './db.js'
import {
  HttpError,
  internalHttpError,
  logServerError,
  publicHttpError,
} from './httpError.js'

/** @typedef {'TRIAL' | 'ACTIVE' | 'SUSPENDED'} PharmacyStatus */

const STATUS_SET = new Set(['TRIAL', 'ACTIVE', 'SUSPENDED'])

/** Nombre de tentatives si PostgreSQL signale un deadlock (40P01). */
const STATUS_UPDATE_MAX_ATTEMPTS = 3

/** @type {null | (() => ReturnType<typeof createSql>)} */
let adminSqlFactoryForTests = null

/**
 * Injection du client SQL (tests uniquement). Passer `null` pour restaurer Neon.
 * @param {null | (() => ReturnType<typeof createSql>)} factory
 */
export function setAdminSqlFactoryForTests(factory) {
  adminSqlFactoryForTests = factory
}

function getSql() {
  return adminSqlFactoryForTests ? adminSqlFactoryForTests() : createSql()
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isDeadlockError(err) {
  const code = err?.code ?? err?.cause?.code
  if (code === '40P01') return true
  const message = String(err?.message || err?.cause?.message || '')
  return /deadlock detected/i.test(message)
}

/**
 * Normalise un statut pharmacie stocké en base.
 * @param {unknown} value
 * @returns {PharmacyStatus}
 */
export function normalizePharmacyStatus(value) {
  const upper = String(value || '').trim().toUpperCase()
  if (STATUS_SET.has(upper)) return /** @type {PharmacyStatus} */ (upper)
  return 'ACTIVE'
}

/**
 * @param {PharmacyStatus} status
 */
export function pharmacyStatusLabel(status) {
  switch (normalizePharmacyStatus(status)) {
    case 'TRIAL':
      return 'Essai'
    case 'SUSPENDED':
      return 'Suspendu'
    default:
      return 'Actif'
  }
}

/**
 * KPIs globaux + tableau pharmacies + santé DB (requêtes agrégées).
 */
export async function getAdminDashboard() {
  const sql = createSql()

  const kpiRows = await sql`
    WITH active_window AS (
      SELECT pharmacy_id
      FROM scans
      WHERE date_peremption >= (CURRENT_DATE - INTERVAL '3 months')
        AND date_peremption < (date_trunc('month', CURRENT_DATE) + INTERVAL '15 months')
    )
    SELECT
      (SELECT COUNT(*)::int FROM pharmacies) AS pharmacies_total,
      (
        SELECT COUNT(DISTINCT s.pharmacy_id)::int
        FROM scans s
        WHERE s.date_scan >= NOW() - INTERVAL '7 days'
      ) AS pharmacies_active_7d,
      (
        SELECT COUNT(*)::int
        FROM scans
        WHERE date_scan >= NOW() - INTERVAL '7 days'
      ) AS scans_7d,
      (SELECT COUNT(*)::int FROM active_window) AS active_lines,
      (
        SELECT COALESCE(
          ROUND(
            COUNT(*)::numeric / NULLIF((SELECT COUNT(*) FROM pharmacies), 0),
            1
          ),
          0
        )
        FROM active_window
      ) AS active_lines_avg_per_pharmacy,
      (
        SELECT COUNT(*)::int
        FROM scans
        WHERE is_manual = TRUE
      ) AS manual_entries,
      (SELECT COUNT(*)::int FROM scans) AS scans_total,
      (
        SELECT ROUND(
          100.0 * COUNT(*) FILTER (WHERE is_manual = TRUE)
            / NULLIF(COUNT(*), 0),
          1
        )
        FROM scans
      ) AS manual_rate_pct,
      (
        SELECT MIN(date_peremption)::text
        FROM scans
      ) AS oldest_expiry_date,
      (
        SELECT MIN(date_scan)
        FROM scans
      ) AS oldest_scan_at,
      (
        SELECT COUNT(*)::int FROM pharmacies
      ) AS pharmacies_rows,
      (
        SELECT COUNT(*)::int FROM users
      ) AS users_rows,
      (
        SELECT COUNT(*)::int FROM zones_stockage
      ) AS zones_rows,
      (
        SELECT COUNT(*)::int FROM scans
      ) AS scans_rows
  `
  const kpis = kpiRows[0]

  const pharmacies = await sql`
    WITH contact AS (
      SELECT DISTINCT ON (pharmacy_id)
        pharmacy_id,
        email AS contact_email
      FROM users
      ORDER BY
        pharmacy_id,
        CASE WHEN lower(role) = 'admin' THEN 0 ELSE 1 END,
        created_at ASC
    ),
    activity AS (
      SELECT
        pharmacy_id,
        MAX(date_scan) AS last_activity_at,
        COUNT(*) FILTER (
          WHERE date_scan >= NOW() - INTERVAL '7 days'
        )::int AS scans_7d,
        COUNT(*) FILTER (
          WHERE date_scan >= NOW() - INTERVAL '30 days'
        )::int AS scans_30d
      FROM scans
      GROUP BY pharmacy_id
    ),
    inventory AS (
      SELECT
        pharmacy_id,
        COUNT(*) FILTER (
          WHERE date_peremption >= (CURRENT_DATE - INTERVAL '3 months')
            AND date_peremption < (
              date_trunc('month', CURRENT_DATE) + INTERVAL '15 months'
            )
        )::int AS active_lines,
        COUNT(*) FILTER (
          WHERE date_peremption >= CURRENT_DATE
            AND date_peremption < (CURRENT_DATE + INTERVAL '90 days')
        )::int AS due_90d
      FROM scans
      GROUP BY pharmacy_id
    )
    SELECT
      p.id,
      p.nom,
      p.code_client,
      p.status,
      p.created_at,
      p.trial_ends_at,
      c.contact_email,
      a.last_activity_at,
      COALESCE(a.scans_7d, 0)::int AS scans_7d,
      COALESCE(a.scans_30d, 0)::int AS scans_30d,
      COALESCE(i.active_lines, 0)::int AS active_lines,
      COALESCE(i.due_90d, 0)::int AS due_90d
    FROM pharmacies p
    LEFT JOIN contact c ON c.pharmacy_id = p.id
    LEFT JOIN activity a ON a.pharmacy_id = p.id
    LEFT JOIN inventory i ON i.pharmacy_id = p.id
    ORDER BY p.created_at DESC
  `

  const kpi = kpis || {}

  return {
    kpis: {
      pharmacies_active_7d: Number(kpi.pharmacies_active_7d ?? 0),
      pharmacies_total: Number(kpi.pharmacies_total ?? 0),
      scans_7d: Number(kpi.scans_7d ?? 0),
      active_lines: Number(kpi.active_lines ?? 0),
      active_lines_avg_per_pharmacy: Number(
        kpi.active_lines_avg_per_pharmacy ?? 0,
      ),
      manual_entries: Number(kpi.manual_entries ?? 0),
      scans_total: Number(kpi.scans_total ?? 0),
      manual_rate_pct:
        kpi.manual_rate_pct == null ? null : Number(kpi.manual_rate_pct),
    },
    pharmacies: pharmacies.map((row) => {
      const status = normalizePharmacyStatus(row.status)
      return {
        id: String(row.id),
        nom: row.nom,
        code_client: row.code_client,
        contact_email: row.contact_email ? String(row.contact_email) : null,
        status,
        status_label: pharmacyStatusLabel(status),
        created_at: row.created_at
          ? new Date(row.created_at).toISOString()
          : null,
        trial_ends_at: row.trial_ends_at
          ? new Date(row.trial_ends_at).toISOString()
          : null,
        last_activity_at: row.last_activity_at
          ? new Date(row.last_activity_at).toISOString()
          : null,
        scans_7d: Number(row.scans_7d ?? 0),
        scans_30d: Number(row.scans_30d ?? 0),
        active_lines: Number(row.active_lines ?? 0),
        due_90d: Number(row.due_90d ?? 0),
      }
    }),
    health: {
      oldest_expiry_date: kpi.oldest_expiry_date
        ? String(kpi.oldest_expiry_date)
        : null,
      oldest_scan_at: kpi.oldest_scan_at
        ? new Date(kpi.oldest_scan_at).toISOString()
        : null,
      table_counts: {
        pharmacies: Number(kpi.pharmacies_rows ?? 0),
        users: Number(kpi.users_rows ?? 0),
        zones_stockage: Number(kpi.zones_rows ?? 0),
        scans: Number(kpi.scans_rows ?? 0),
      },
    },
  }
}

/**
 * Mappe une ligne pharmacies → payload API admin.
 * @param {{
 *   id: unknown,
 *   nom: unknown,
 *   code_client: unknown,
 *   status: unknown,
 *   created_at: unknown,
 *   trial_ends_at: unknown,
 * }} row
 */
function mapPharmacyRow(row) {
  const normalized = normalizePharmacyStatus(row.status)
  return {
    id: String(row.id),
    nom: row.nom,
    code_client: row.code_client,
    status: normalized,
    status_label: pharmacyStatusLabel(normalized),
    created_at: row.created_at
      ? new Date(/** @type {string | number | Date} */ (row.created_at)).toISOString()
      : null,
    trial_ends_at: row.trial_ends_at
      ? new Date(
          /** @type {string | number | Date} */ (row.trial_ends_at),
        ).toISOString()
      : null,
  }
}

/**
 * Une seule requête PostgreSQL (CTE writable) :
 * 1. verrouille la pharmacie (`FOR UPDATE`) ;
 * 2. met à jour `pharmacies.status` ;
 * 3. n’incrémente `users.session_version` que si l’on passe réellement
 *    d’un statut ≠ SUSPENDED vers SUSPENDED.
 *
 * Atomicité : une statement = une transaction implicite Neon/PostgreSQL.
 * Deux suspensions concurrentes se sérialisent sur le verrou ligne pharmacie ;
 * la seconde voit `previous_status = SUSPENDED` et ne re-bump pas.
 *
 * @param {string} pharmacyId
 * @param {'ACTIVE' | 'SUSPENDED'} status
 */
async function updatePharmacyStatusAtomic(pharmacyId, status) {
  const sql = getSql()
  const rows = await sql`
    WITH locked AS (
      SELECT id, status AS previous_status
      FROM pharmacies
      WHERE id = ${pharmacyId}::uuid
      FOR UPDATE
    ),
    updated AS (
      UPDATE pharmacies AS p
      SET status = ${status}
      FROM locked AS l
      WHERE p.id = l.id
      RETURNING
        p.id,
        p.nom,
        p.code_client,
        p.status,
        p.created_at,
        p.trial_ends_at,
        l.previous_status
    ),
    bumped AS (
      UPDATE users AS u
      SET session_version = u.session_version + 1
      FROM updated AS upd
      WHERE u.pharmacy_id = upd.id
        AND upper(trim(upd.previous_status::text)) IS DISTINCT FROM 'SUSPENDED'
        AND upper(trim(upd.status::text)) = 'SUSPENDED'
      RETURNING u.id
    )
    SELECT
      id,
      nom,
      code_client,
      status,
      created_at,
      trial_ends_at
    FROM updated
  `
  return rows[0] ?? null
}

/**
 * Bascule le statut d’une pharmacie (ACTIVE ↔ SUSPENDED).
 * Un compte en TRIAL peut aussi être activé ou suspendu.
 * Transition réelle vers SUSPENDED → révocation atomique des JWT
 * (`session_version + 1` pour tous les users de la pharmacie).
 *
 * @param {string} pharmacyId
 * @param {'ACTIVE' | 'SUSPENDED'} nextStatus
 */
export async function updatePharmacyStatus(pharmacyId, nextStatus) {
  const id = String(pharmacyId || '').trim()
  const status = normalizePharmacyStatus(nextStatus)
  if (!id) throw publicHttpError('Identifiant pharmacie manquant', 400)
  if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
    throw publicHttpError('Statut invalide (ACTIVE ou SUSPENDED)', 400)
  }

  let lastErr
  for (let attempt = 1; attempt <= STATUS_UPDATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const row = await updatePharmacyStatusAtomic(id, status)
      if (!row) throw publicHttpError('Pharmacie introuvable', 404)
      return mapPharmacyRow(row)
    } catch (err) {
      lastErr = err
      if (err instanceof HttpError) throw err
      if (attempt < STATUS_UPDATE_MAX_ATTEMPTS && isDeadlockError(err)) {
        continue
      }
      logServerError('admin/updatePharmacyStatus', err)
      throw internalHttpError(err)
    }
  }

  logServerError('admin/updatePharmacyStatus', lastErr)
  throw internalHttpError(lastErr)
}
