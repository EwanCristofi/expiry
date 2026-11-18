/**
 * Normalise un SIRET (chiffres uniquement).
 * @param {unknown} value
 */
export function normalizeSiret(value) {
  return String(value ?? '').replace(/\D/g, '')
}

/**
 * Algorithme de Luhn (SIRET français, 14 chiffres).
 * @param {string} digits
 */
export function isValidLuhn(digits) {
  if (!/^\d{14}$/.test(digits)) return false

  let sum = 0
  let doubleDigit = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (doubleDigit) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    doubleDigit = !doubleDigit
  }
  return sum % 10 === 0
}

/**
 * @param {unknown} value
 * @returns {string | null} SIRET normalisé ou null si invalide
 */
export function parseValidSiret(value) {
  const digits = normalizeSiret(value)
  if (digits === '00000000000000') return null
  if (!isValidLuhn(digits)) return null
  return digits
}
