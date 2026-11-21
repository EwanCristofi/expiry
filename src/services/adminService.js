import { apiFetch } from './api.js'

/**
 * Tableau de bord admin plateforme (KPIs + pharmacies + santé).
 */
export async function fetchAdminDashboard() {
  return apiFetch('/api/admin/dashboard')
}

/**
 * @param {string} pharmacyId
 * @param {'ACTIVE' | 'SUSPENDED'} status
 */
export async function updatePharmacyStatus(pharmacyId, status) {
  const data = await apiFetch(
    `/api/admin/pharmacies/${encodeURIComponent(pharmacyId)}/status`,
    {
      method: 'PATCH',
      json: { status },
    },
  )
  return data.pharmacy
}
