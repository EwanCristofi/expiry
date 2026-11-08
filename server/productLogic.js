import {
  getAcl7Variant,
  getCodeVariants,
  preferLongerCodes,
} from './codes.js'
import { sql, withPharmacy } from './db.js'

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
        nomProduit: medResult[0].nom_medicament,
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
        nomProduit: paraResult[0].nom_produit,
        typeProduit: 'parapharma',
      }
    }
  }

  return null
}

export async function listZones(pharmacyId) {
  const [rows] = await withPharmacy(pharmacyId, [
    sql`
      SELECT id, nom_zone
      FROM zones_stockage
      ORDER BY nom_zone ASC
    `,
  ])
  return rows.map((row) => ({
    id: Number(row.id),
    nom_zone: row.nom_zone,
  }))
}

export async function createZone(pharmacyId, nomZone) {
  const nom = String(nomZone ?? '').trim()
  if (!nom) throw new Error('Le nom de zone est obligatoire')

  try {
    const [rows] = await withPharmacy(pharmacyId, [
      sql`
        INSERT INTO zones_stockage (nom_zone, pharmacy_id)
        VALUES (${nom}, ${pharmacyId}::uuid)
        RETURNING id, nom_zone
      `,
    ])
    return { id: Number(rows[0].id), nom_zone: rows[0].nom_zone }
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
        RETURNING id, nom_zone
      `,
    ])
    if (!rows[0]) throw new Error('Zone introuvable')
    return { id: Number(rows[0].id), nom_zone: rows[0].nom_zone }
  } catch (error) {
    if (error?.code === '23505') {
      throw new Error('Une zone avec ce nom existe déjà')
    }
    throw error
  }
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
        CASE WHEN ${sortByName}::boolean THEN NULL ELSE s.date_scan END DESC NULLS LAST,
        s.nom_produit ASC,
        z.nom_zone ASC NULLS LAST
    `,
  ])

  return rows.map((row) => ({
    id: String(row.id),
    code_gtin: row.code_gtin,
    nom_produit: row.nom_produit,
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
      RETURNING id
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
}
