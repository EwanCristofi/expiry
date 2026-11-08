/**
 * Variantes GTIN / EAN / CIP (sans ACL-7).
 */
export function getCodeVariants(rawCode) {
  if (!rawCode) return []
  const clean = String(rawCode).trim()
  const variants = new Set([clean])

  if (clean.length === 14 && clean.startsWith('0')) {
    variants.add(clean.slice(1))
  }

  if (clean.length === 13 && /^\d+$/.test(clean)) {
    variants.add(`0${clean}`)
  }

  const stripped = clean.replace(/^0+/, '')
  if (stripped && stripped !== clean) {
    variants.add(stripped)
  }

  return Array.from(variants)
}

/** ACL-7 dérivé d'un CIP13 français (3400… / 3401…). */
export function getAcl7Variant(rawCode) {
  const clean = String(rawCode ?? '').trim()
  const code13 =
    clean.length === 14 && clean.startsWith('0') ? clean.slice(1) : clean
  if (
    code13.length === 13 &&
    /^\d+$/.test(code13) &&
    (code13.startsWith('3401') || code13.startsWith('3400'))
  ) {
    return code13.slice(5, 12)
  }
  return null
}

export function preferLongerCodes(variants) {
  return [...variants].sort((a, b) => b.length - a.length || a.localeCompare(b))
}
