import { apiFetch } from './api.js'

/**
 * Résout le nom d'un produit (Médicament OU Parapharmacie — un seul résultat).
 * @param {string} rawCode
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ nomProduit: string, typeProduit: 'medicament' | 'parapharma' } | null>}
 */
export async function resolveProductName(rawCode, options = {}) {
  if (!rawCode) return null
  const data = await apiFetch(
    `/api/products/resolve?code=${encodeURIComponent(String(rawCode).trim())}`,
    { signal: options.signal },
  )
  return data.product ?? null
}

/**
 * Liste les zones de stockage, triées par nom.
 * @returns {Promise<Array<{ id: number, nom_zone: string, is_verified: boolean }>>}
 */
export async function listZones() {
  const data = await apiFetch('/api/zones')
  return data.zones ?? []
}

/**
 * Crée une zone de stockage.
 * @param {string} nomZone
 * @returns {Promise<{ id: number, nom_zone: string, is_verified: boolean }>}
 */
export async function createZone(nomZone) {
  const data = await apiFetch('/api/zones', {
    method: 'POST',
    json: { nom_zone: nomZone },
  })
  return data.zone
}

/**
 * Importe plusieurs zones de stockage en une requête.
 * @param {Array<{ nom_zone: string }>} zones
 * @returns {Promise<{ zones: Array<{ id: number, nom_zone: string, is_verified: boolean }>, inserted: number, skipped: number }>}
 */
export async function bulkCreateZones(zones) {
  return apiFetch('/api/zones/bulk', {
    method: 'POST',
    json: { zones },
  })
}

/**
 * Renomme une zone de stockage.
 * @param {number} id
 * @param {string} nomZone
 * @returns {Promise<{ id: number, nom_zone: string, is_verified: boolean }>}
 */
export async function renameZone(id, nomZone) {
  const data = await apiFetch(`/api/zones/${id}`, {
    method: 'PATCH',
    json: { nom_zone: nomZone },
  })
  return data.zone
}

/**
 * Marque ou dé-marque une zone comme vérifiée.
 * @param {number} id
 * @param {boolean} isVerified
 * @returns {Promise<{ id: number, nom_zone: string, is_verified: boolean }>}
 */
export async function setZoneVerified(id, isVerified) {
  const data = await apiFetch(`/api/zones/${id}/verified`, {
    method: 'PATCH',
    json: { is_verified: Boolean(isVerified) },
  })
  return data.zone
}

/**
 * Remet toutes les zones à « à faire » (nouvelle campagne de contrôle).
 * @returns {Promise<{ updated: number }>}
 */
export async function resetAllZonesVerified() {
  return apiFetch('/api/zones/reset-verification', { method: 'POST' })
}

/**
 * Supprime une zone de stockage.
 * @param {number} id
 */
export async function deleteZone(id) {
  await apiFetch(`/api/zones/${id}`, { method: 'DELETE' })
}

/**
 * Recherche globale dans le stock (nom, CIP, zone, laboratoire).
 * @param {{
 *   q?: string,
 *   zoneId?: number | null,
 *   laboratoire?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function searchScans({
  q = '',
  zoneId = null,
  laboratoire = '',
  limit = 100,
  signal,
} = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (zoneId != null) params.set('zoneId', String(zoneId))
  if (laboratoire) params.set('laboratoire', laboratoire)
  if (limit) params.set('limit', String(limit))

  const data = await apiFetch(`/api/scans/search?${params}`, { signal })
  return data.items ?? []
}

/**
 * Laboratoires distincts du stock de la pharmacie.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string[]>}
 */
export async function listLaboratoires(options = {}) {
  const data = await apiFetch('/api/laboratoires', { signal: options.signal })
  return data.laboratoires ?? []
}

/**
 * Liste les scans à contrôler pour un mois / une zone.
 */
export async function listExpiryChecks({
  year,
  month,
  zoneId = null,
  status = 'unverified',
  sort = 'date',
}) {
  const params = new URLSearchParams({
    year: String(year),
    month: String(month),
    status,
    sort,
  })
  if (zoneId != null) params.set('zoneId', String(zoneId))

  const data = await apiFetch(`/api/expiry-checks?${params}`)
  return data.items ?? []
}

/**
 * Marque ou dé-marque un scan comme vérifié.
 * @param {string} scanId
 * @param {boolean} isVerified
 */
export async function setScanVerified(scanId, isVerified) {
  return apiFetch(`/api/scans/${encodeURIComponent(scanId)}/verified`, {
    method: 'PATCH',
    json: { is_verified: Boolean(isVerified) },
  })
}

/**
 * Enregistre le scan d'un produit dans une zone géographique.
 * @returns {Promise<{ id: string, nom_produit: string, date_peremption: string, quantite: number }>}
 */
export async function saveScan({
  gtin,
  nomProduit,
  datePeremption,
  zoneId,
  typeProduit = 'inconnu',
  nomManuel = false,
}) {
  const data = await apiFetch('/api/scans', {
    method: 'POST',
    json: {
      gtin,
      nomProduit,
      datePeremption,
      zoneId,
      typeProduit,
      nomManuel,
    },
  })
  return data.scan
}

/**
 * Supprime un scan par identifiant (pharmacie de la session).
 * @param {string} scanId
 */
export async function deleteScan(scanId) {
  return apiFetch(`/api/scans/${encodeURIComponent(scanId)}`, {
    method: 'DELETE',
  })
}
