const HEADER_NAMES = new Set([
  'nom_zone',
  'nom',
  'zone',
  'zone_geographique',
  'zones',
])

/**
 * Parse un CSV de zones (colonne `nom_zone`).
 * @param {string} fileContent
 * @returns {{ zones: Array<{ nom_zone: string }>, errors: string[] }}
 */
export function parseZonesCsv(fileContent) {
  const lines = String(fileContent ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')

  const zones = []
  const errors = []
  const seen = new Set()

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || !raw.trim()) continue

    const firstCol = raw
      .split(/[;,]/)[0]
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim()

    if (!firstCol) {
      errors.push(`Ligne ${i + 1} : nom_zone vide`)
      continue
    }

    if (i === 0 && HEADER_NAMES.has(firstCol.toLowerCase())) continue

    const key = firstCol.toLocaleLowerCase('fr')
    if (seen.has(key)) continue
    seen.add(key)

    zones.push({ nom_zone: firstCol })
  }

  return { zones, errors }
}
