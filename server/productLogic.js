import {
  getAcl7Variant,
  getCodeVariants,
  preferLongerCodes,
} from './codes.js'
import { sql, withPharmacy } from './db.js'
import { fixMojibake } from './encoding.js'

/**
 * Résolution produit (référentiels partagés — hors RLS tenant).
 * @param {string} rawCode
 * @returns {Promise<{ nomProduit: string, typeProduit: 'medicament' | 'parapharma' } | null>}
 */
export async function resolveProductName(rawCode) {
  if (!rawCode) return null

  const cleanCode = String(rawCode).trim()
  const baseVariants = getCodeVariants(cleanCode)
  const acl7 = getAcl7Variant(cleanCode)
  const medVariants = preferLongerCodes(
    acl7 ? [...baseVariants, acl7] : baseVariants,
  )
  const paraVariants = preferLongerCodes(baseVariants)

  for (const code of medVariants) {
    const medResult = await sql`
      SELECT nom_medicament FROM medicaments_ref
      WHERE TRIM(cip13::text) = ${code}
      LIMIT 1
    `
    if (medResult?.[0]?.nom_medicament) {
      return {
        nomProduit: String(fixMojibake(medResult[0].nom_medicament)),
        typeProduit: 'medicament',
      }
    }
  }

  for (const code of paraVariants) {
    const paraResult = await sql`
      SELECT nom_produit FROM parapharma_ref
      WHERE TRIM(gtin::text) = ${code}
      LIMIT 1
    `
    if (paraResult?.[0]?.nom_produit) {
      return {
        nomProduit: String(fixMojibake(paraResult[0].nom_produit)),
        typeProduit: 'parapharma',
      }
    }
  }

  return null
}

function mapZone(row) {
  return {
    id: Number(row.id),
    nom_zone: row.nom_zone,
    is_verified: Boolean(row.is_verified),
  }
}

export async function listZones(pharmacyId) {
  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      SELECT id, nom_zone, is_verified
      FROM zones_stockage
      ORDER BY nom_zone ASC
    `,
  ])
  return rows.map(mapZone)
}

export async function createZone(pharmacyId, nomZone) {
  const nom = String(nomZone ?? '').trim()
  if (!nom) throw new Error('Le nom de zone est obligatoire')

  try {
    const [rows] = await withPharmacy(pharmacyId, [
      sql`
        INSERT INTO zones_stockage (nom_zone, pharmacy_id)
        VALUES (${nom}, ${pharmacyId}::uuid)
        RETURNING id, nom_zone, is_verified
      `,
    ])
    return mapZone(rows[0])
  } catch (error) {
    if (error?.code === '23505') {
      throw new Error('Une zone avec ce nom existe déjà')
    }
    throw error
  }
}

/**
 * Insertion groupée de zones pour une pharmacie.
 * Ignore les doublons (même pharmacy_id + nom_zone).
 * @param {string} pharmacyId
 * @param {Array<{ nom_zone?: string, nomZone?: string } | string>} items
 * @returns {Promise<{ zones: Array<{ id: number, nom_zone: string }>, inserted: number, skipped: number }>}
 */
export async function bulkCreateZones(pharmacyId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Le tableau de zones est obligatoire')
  }

  const names = []
  const seen = new Set()

  for (const item of items) {
    const raw =
      typeof item === 'string'
        ? item
        : (item?.nom_zone ?? item?.nomZone ?? '')
    const nom = String(raw).trim()
    if (!nom) {
      throw new Error('Chaque ligne doit contenir un nom_zone non vide')
    }
    const key = nom.toLocaleLowerCase('fr')
    if (seen.has(key)) continue
    seen.add(key)
    names.push(nom)
  }

  if (!names.length) {
    throw new Error('Aucune zone valide à importer')
  }

  const valuesClause = names
    .map((_, index) => `($${index + 1}, $${names.length + 1}::uuid)`)
    .join(', ')
  const query = `
    INSERT INTO zones_stockage (nom_zone, pharmacy_id)
    VALUES ${valuesClause}
    ON CONFLICT (pharmacy_id, nom_zone) DO NOTHING
    RETURNING id, nom_zone
  `

  try {
    const [rows] = await withPharmacy(pharmacyId, [
      sql.query(query, [...names, pharmacyId]),
    ])
    const zones = (rows ?? []).map(mapZone)
    return {
      zones,
      inserted: zones.length,
      skipped: names.length - zones.length,
    }
  } catch (error) {
    if (error?.code === '23505') {
      throw new Error('Une zone avec ce nom existe déjà')
    }
    throw error
  }
}

export async function renameZone(pharmacyId, id, nomZone) {
  const nom = String(nomZone ?? '').trim()
  if (!id) throw new Error('Identifiant de zone manquant')
  if (!nom) throw new Error('Le nom de zone est obligatoire')

  try {
    const [rows] = await withPharmacy(pharmacyId, [
      sql`
        UPDATE zones_stockage
        SET nom_zone = ${nom}
        WHERE id = ${id}
        RETURNING id, nom_zone, is_verified
      `,
    ])
    if (!rows[0]) throw new Error('Zone introuvable')
    return mapZone(rows[0])
  } catch (error) {
    if (error?.code === '23505') {
      throw new Error('Une zone avec ce nom existe déjà')
    }
    throw error
  }
}

/**
 * Marque ou dé-marque une zone comme vérifiée (campagne de contrôle).
 * @param {string} pharmacyId
 * @param {number} id
 * @param {boolean} isVerified
 */
export async function setZoneVerified(pharmacyId, id, isVerified) {
  if (!id) throw new Error('Identifiant de zone manquant')

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      UPDATE zones_stockage
      SET is_verified = ${Boolean(isVerified)}
      WHERE id = ${id}
      RETURNING id, nom_zone, is_verified
    `,
  ])
  if (!rows[0]) throw new Error('Zone introuvable')
  return mapZone(rows[0])
}

/**
 * Remet toutes les zones à « à faire » pour une nouvelle campagne de contrôle.
 * @param {string} pharmacyId
 * @returns {Promise<{ updated: number }>}
 */
export async function resetAllZonesVerified(pharmacyId) {
  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      UPDATE zones_stockage
      SET is_verified = FALSE
      WHERE is_verified = TRUE
      RETURNING id
    `,
  ])
  return { updated: rows?.length ?? 0 }
}

export async function deleteZone(pharmacyId, id) {
  if (!id) throw new Error('Identifiant de zone manquant')

  const [linked] = await withPharmacy(pharmacyId, [
    sql`SELECT COUNT(*)::int AS count FROM scans WHERE zone_id = ${id}`,
  ])
  if ((linked[0]?.count ?? 0) > 0) {
    throw new Error(
      'Impossible de supprimer : des produits sont encore associés à cette zone.',
    )
  }

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      DELETE FROM zones_stockage
      WHERE id = ${id}
      RETURNING id
    `,
  ])
  if (!rows[0]) throw new Error('Zone introuvable')
}

function formatScanDate(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date) {
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

/**
 * Recherche globale dans le stock scanné (péremptions).
 * @param {string} pharmacyId
 * @param {{
 *   q?: string,
 *   zoneId?: number | null,
 *   laboratoire?: string | null,
 *   limit?: number,
 * }} options
 */
export async function searchScans(
  pharmacyId,
  { q = '', zoneId = null, laboratoire = null, limit = 100 } = {},
) {
  const query = String(q ?? '').trim()
  const labFilter = String(laboratoire ?? '').trim()
  const hasZone = zoneId != null && Number.isFinite(Number(zoneId))
  const zoneFilterId = hasZone ? Number(zoneId) : 0
  const hasLab = labFilter.length > 0
  const hasQuery = query.length >= 2

  if (!hasQuery && !hasZone && !hasLab) {
    return []
  }

  const pattern = hasQuery ? `%${query}%` : ''
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500)

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      SELECT
        s.id,
        s.code_gtin,
        s.nom_produit,
        s.date_peremption::text AS date_peremption,
        s.quantite,
        s.zone_id,
        z.nom_zone,
        COALESCE(
          NULLIF(TRIM(m.laboratoire), ''),
          NULLIF(TRIM(p.laboratoire), '')
        ) AS laboratoire
      FROM scans s
      LEFT JOIN zones_stockage z ON z.id = s.zone_id
      LEFT JOIN medicaments_ref m
        ON TRIM(m.cip13::text) = TRIM(s.code_gtin::text)
      LEFT JOIN parapharma_ref p
        ON TRIM(p.gtin::text) = TRIM(s.code_gtin::text)
      WHERE (
          ${!hasQuery}::boolean
          OR s.nom_produit ILIKE ${pattern}
          OR s.code_gtin::text ILIKE ${pattern}
          OR z.nom_zone ILIKE ${pattern}
          OR COALESCE(
            NULLIF(TRIM(m.laboratoire), ''),
            NULLIF(TRIM(p.laboratoire), '')
          ) ILIKE ${pattern}
        )
        AND (
          ${!hasZone}::boolean
          OR s.zone_id = ${zoneFilterId}
        )
        AND (
          ${!hasLab}::boolean
          OR COALESCE(
            NULLIF(TRIM(m.laboratoire), ''),
            NULLIF(TRIM(p.laboratoire), '')
          ) ILIKE ${labFilter}
        )
      ORDER BY
        s.date_peremption ASC NULLS LAST,
        s.nom_produit ASC,
        z.nom_zone ASC NULLS LAST
      LIMIT ${safeLimit}
    `,
  ])

  return rows.map((row) => ({
    id: String(row.id),
    code_gtin: row.code_gtin,
    nom_produit: String(fixMojibake(row.nom_produit) ?? ''),
    date_peremption: formatScanDate(row.date_peremption),
    quantite: Number(row.quantite ?? 1),
    zone_id: row.zone_id == null ? null : Number(row.zone_id),
    nom_zone: row.nom_zone ?? null,
    laboratoire: row.laboratoire
      ? String(fixMojibake(row.laboratoire))
      : null,
  }))
}

/**
 * Laboratoires distincts présents dans le stock de la pharmacie.
 * @param {string} pharmacyId
 * @returns {Promise<string[]>}
 */
export async function listLaboratoires(pharmacyId) {
  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      SELECT DISTINCT
        COALESCE(
          NULLIF(TRIM(m.laboratoire), ''),
          NULLIF(TRIM(p.laboratoire), '')
        ) AS laboratoire
      FROM scans s
      LEFT JOIN medicaments_ref m
        ON TRIM(m.cip13::text) = TRIM(s.code_gtin::text)
      LEFT JOIN parapharma_ref p
        ON TRIM(p.gtin::text) = TRIM(s.code_gtin::text)
      WHERE COALESCE(
        NULLIF(TRIM(m.laboratoire), ''),
        NULLIF(TRIM(p.laboratoire), '')
      ) IS NOT NULL
      ORDER BY 1 ASC
    `,
  ])

  return rows
    .map((row) => String(fixMojibake(row.laboratoire) ?? '').trim())
    .filter(Boolean)
}

export async function listExpiryChecks(
  pharmacyId,
  { year, month, zoneId = null, status = 'unverified', sort = 'date' },
) {
  if (!year || !month || month < 1 || month > 12) {
    throw new Error('Mois / année invalides')
  }

  const onlyUnverified = status === 'unverified'
  const onlyVerified = status === 'verified'
  const allZones = zoneId == null
  const zoneFilterId = zoneId ?? 0
  const sortByName = sort === 'name'

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      SELECT
        s.id,
        s.code_gtin,
        s.nom_produit,
        s.date_peremption::text AS date_peremption,
        s.date_scan,
        s.quantite,
        s.is_verified,
        s.zone_id,
        z.nom_zone
      FROM scans s
      LEFT JOIN zones_stockage z ON z.id = s.zone_id
      WHERE (
          ${allZones}::boolean
          OR s.zone_id = ${zoneFilterId}
        )
        AND EXTRACT(YEAR FROM s.date_peremption) = ${year}
        AND EXTRACT(MONTH FROM s.date_peremption) = ${month}
        AND (
          ${onlyUnverified}::boolean IS FALSE
          OR s.is_verified = FALSE
        )
        AND (
          ${onlyVerified}::boolean IS FALSE
          OR s.is_verified = TRUE
        )
      ORDER BY
        s.is_verified ASC,
        CASE WHEN ${sortByName}::boolean THEN s.nom_produit END ASC NULLS LAST,
        CASE WHEN ${sortByName}::boolean THEN NULL ELSE s.date_scan END ASC NULLS LAST,
        s.nom_produit ASC,
        z.nom_zone ASC NULLS LAST
    `,
  ])

  return rows.map((row) => ({
    id: String(row.id),
    code_gtin: row.code_gtin,
    nom_produit: String(fixMojibake(row.nom_produit) ?? ''),
    date_peremption: formatScanDate(row.date_peremption),
    date_scan:
      row.date_scan == null
        ? null
        : row.date_scan instanceof Date
          ? row.date_scan.toISOString()
          : String(row.date_scan),
    quantite: Number(row.quantite ?? 1),
    is_verified: Boolean(row.is_verified),
    zone_id: row.zone_id == null ? null : Number(row.zone_id),
    nom_zone: row.nom_zone ?? null,
  }))
}

export async function setScanVerified(pharmacyId, scanId, isVerified) {
  if (!scanId) throw new Error('Identifiant de scan manquant')

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      UPDATE scans
      SET is_verified = ${Boolean(isVerified)}
      WHERE id = ${scanId}::uuid
      RETURNING id, is_verified
    `,
  ])
  if (!rows[0]) throw new Error('Produit introuvable')
  return {
    id: String(rows[0].id),
    is_verified: Boolean(rows[0].is_verified),
  }
}

export async function saveScan(
  pharmacyId,
  {
    gtin,
    nomProduit,
    datePeremption,
    zoneId,
    typeProduit = 'inconnu',
    nomManuel = false,
  },
) {
  if (!gtin || !datePeremption) {
    throw new Error('GTIN et date de péremption obligatoires')
  }
  if (!zoneId) {
    throw new Error('Sélectionnez une zone de stockage avant d’enregistrer')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(datePeremption).trim())) {
    throw new Error('Date de péremption invalide (attendu AAAA-MM-JJ)')
  }

  const date = String(datePeremption).trim()

  const [inserted] = await withPharmacy(pharmacyId, [
    sql`
      INSERT INTO scans (
        code_gtin, nom_produit, date_peremption, zone_id, quantite, pharmacy_id
      )
      SELECT
        ${gtin},
        ${nomProduit},
        ${date}::date,
        ${zoneId},
        1,
        ${pharmacyId}::uuid
      WHERE EXISTS (
        SELECT 1 FROM zones_stockage WHERE id = ${zoneId}
      )
      ON CONFLICT (pharmacy_id, code_gtin, date_peremption, zone_id)
      DO UPDATE SET
        quantite = scans.quantite + 1,
        nom_produit = EXCLUDED.nom_produit,
        date_scan = NOW()
      RETURNING
        id,
        nom_produit,
        date_peremption::text AS date_peremption,
        quantite
    `,
  ])

  if (!inserted[0]) {
    throw new Error('Zone introuvable pour cette pharmacie')
  }

  if (
    nomManuel &&
    (typeProduit === 'parapharma' ||
      typeProduit === 'parapharmacie' ||
      typeProduit === 'inconnu') &&
    nomProduit
  ) {
    await sql`
      INSERT INTO parapharma_ref (gtin, nom_produit)
      VALUES (${gtin}, ${nomProduit})
      ON CONFLICT (gtin)
      DO UPDATE SET nom_produit = EXCLUDED.nom_produit
    `
  }

  const row = inserted[0]
  return {
    id: String(row.id),
    nom_produit: row.nom_produit,
    date_peremption: formatScanDate(row.date_peremption),
    quantite: Number(row.quantite ?? 1),
  }
}

/**
 * Annule un scan de la pharmacie (RLS / withPharmacy) :
 * décrémente `quantite` si > 1, sinon supprime la ligne.
 * @param {string} pharmacyId
 * @param {string} scanId
 * @returns {Promise<{ id: string, deleted: boolean, quantite: number }>}
 */
export async function deleteScan(pharmacyId, scanId) {
  if (!scanId) throw new Error('Identifiant de scan manquant')

  const [existing] = await withPharmacy(pharmacyId, [
    sql`
      SELECT id, quantite
      FROM scans
      WHERE id = ${scanId}::uuid
    `,
  ])
  if (!existing[0]) throw new Error('Scan introuvable')

  const qty = Number(existing[0].quantite ?? 1)
  if (qty > 1) {
    const [updated] = await withPharmacy(pharmacyId, [
      sql`
        UPDATE scans
        SET quantite = quantite - 1
        WHERE id = ${scanId}::uuid
        RETURNING id, quantite
      `,
    ])
    return {
      id: String(updated[0].id),
      deleted: false,
      quantite: Number(updated[0].quantite),
    }
  }

  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      DELETE FROM scans
      WHERE id = ${scanId}::uuid
      RETURNING id
    `,
  ])
  if (!rows[0]) throw new Error('Scan introuvable')
  return { id: String(rows[0].id), deleted: true, quantite: 0 }
}

/**
 * Purge globale des scans périmés depuis plus de 3 mois.
 * Exécutée hors RLS (rôle owner Neon) pour couvrir tous les tenants.
 * @returns {Promise<{ deleted: number }>}
 */
export async function cleanupExpiredScans() {
  const rows = await sql`
    DELETE FROM scans
    WHERE date_peremption < (CURRENT_DATE - INTERVAL '3 months')
    RETURNING id
  `
  return { deleted: Array.isArray(rows) ? rows.length : 0 }
}
