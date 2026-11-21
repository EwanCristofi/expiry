import { createSql } from './db.js'

/** @typedef {'TRIAL' | 'ACTIVE' | 'SUSPENDED'} PharmacyStatus */

const STATUS_SET = new Set(['TRIAL', 'ACTIVE', 'SUSPENDED'])

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
 * Bascule le statut d’une pharmacie (ACTIVE ↔ SUSPENDED).
 * Un compte en TRIAL peut aussi être activé ou suspendu.
 * @param {string} pharmacyId
 * @param {'ACTIVE' | 'SUSPENDED'} nextStatus
 */
export async function updatePharmacyStatus(pharmacyId, nextStatus) {
  const id = String(pharmacyId || '').trim()
  const status = normalizePharmacyStatus(nextStatus)
  if (!id) throw new Error('Identifiant pharmacie manquant')
  if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
    throw new Error('Statut invalide (ACTIVE ou SUSPENDED)')
  }

  const sql = createSql()
  const rows = await sql`
    UPDATE pharmacies
    SET status = ${status}
    WHERE id = ${id}::uuid
    RETURNING
      id,
      nom,
      code_client,
      status,
      created_at,
      trial_ends_at
  `
  const row = rows[0]
  if (!row) throw new Error('Pharmacie introuvable')

  const normalized = normalizePharmacyStatus(row.status)
  return {
    id: String(row.id),
    nom: row.nom,
    code_client: row.code_client,
    status: normalized,
    status_label: pharmacyStatusLabel(normalized),
    created_at: row.created_at
      ? new Date(row.created_at).toISOString()
      : null,
    trial_ends_at: row.trial_ends_at
      ? new Date(row.trial_ends_at).toISOString()
      : null,
  }
}
