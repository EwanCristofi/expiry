import { apiFetch } from './api.js'

/**
 * Résout le nom d'un produit (Médicament OU Parapharmacie — un seul résultat).
 * @returns {Promise<{ nomProduit: string, typeProduit: 'medicament' | 'parapharma' } | null>}
 */
export async function resolveProductName(rawCode) {
  if (!rawCode) return null
  const data = await apiFetch(
    `/api/products/resolve?code=${encodeURIComponent(String(rawCode).trim())}`,
  )
  return data.product ?? null
}

/**
 * Liste les zones de stockage, triées par nom.
 * @returns {Promise<Array<{ id: number, nom_zone: string }>>}
 */
export async function listZones() {
  const data = await apiFetch('/api/zones')
  return data.zones ?? []
}

/**
 * Crée une zone de stockage.
 * @param {string} nomZone
 * @returns {Promise<{ id: number, nom_zone: string }>}
 */
export async function createZone(nomZone) {
  const data = await apiFetch('/api/zones', {
    method: 'POST',
    json: { nom_zone: nomZone },
  })
  return data.zone
}

/**
 * Renomme une zone de stockage.
 * @param {number} id
 * @param {string} nomZone
 * @returns {Promise<{ id: number, nom_zone: string }>}
 */
export async function renameZone(id, nomZone) {
  const data = await apiFetch(`/api/zones/${id}`, {
    method: 'PATCH',
    json: { nom_zone: nomZone },
  })
  return data.zone
}

/**
 * Supprime une zone de stockage.
 * @param {number} id
 */
export async function deleteZone(id) {
  await apiFetch(`/api/zones/${id}`, { method: 'DELETE' })
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
 */
export async function saveScan({
  gtin,
  nomProduit,
  datePeremption,
  zoneId,
  typeProduit = 'inconnu',
  nomManuel = false,
}) {
  await apiFetch('/api/scans', {
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
}
