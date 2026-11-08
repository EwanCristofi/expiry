/**
 * Parse a raw barcode / DataMatrix string into GTIN and expiry date.
 *
 * Supports:
 * - GS1 DataMatrix with AIs 01 (GTIN) and 17 (expiry YYMMDD)
 * - Plain EAN-13 / CIP (no date → empty for manual entry)
 *
 * @param {string} rawInput
 * @returns {{ rawCode: string, gtin: string, datePeremption: string }}
 */
export function parseGs1(rawInput) {
  const rawCode = String(rawInput ?? '').trim()
  if (!rawCode) {
    return { rawCode: '', gtin: '', datePeremption: '' }
  }

  const normalized = normalizeGs1Payload(rawCode)
  const fromParentheses = parseParenthesized(normalized)
  const fromConcatenated = parseConcatenated(normalized)

  const gtin = fromParentheses.gtin || fromConcatenated.gtin || ''
  const datePeremption =
    fromParentheses.datePeremption || fromConcatenated.datePeremption || ''

  if (gtin) {
    return { rawCode, gtin, datePeremption }
  }

  // Plain EAN-8 / UPC-A / EAN-13 / CIP without GS1 structure
  const digitsOnly = rawCode.replace(/\D/g, '')
  if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digitsOnly)) {
    return { rawCode, gtin: digitsOnly, datePeremption: '' }
  }

  return { rawCode, gtin: rawCode, datePeremption: '' }
}

/** Strip human-readable noise; keep GS (FNC1) as a separator marker. */
function normalizeGs1Payload(raw) {
  return raw
    .replace(/^\u001d+/, '') // leading FNC1
    .replace(/\u001e/g, '') // RS
    .replace(/\r|\n/g, '')
    .trim()
}

/**
 * Human-readable / some scanners: (01)XXXXXXXXXXXXXX(17)AAMMJJ…
 */
function parseParenthesized(payload) {
  const gtinMatch = payload.match(/\(01\)(\d{14})/)
  const dateMatch = payload.match(/\(17\)(\d{6})/)

  return {
    gtin: gtinMatch?.[1] ?? '',
    datePeremption: dateMatch ? yymmddToIso(dateMatch[1]) : '',
  }
}

/**
 * Element-string form: 01 + 14 digits, 17 + 6 digits.
 * Variable-length AIs may be delimited by GS (\x1D).
 */
function parseConcatenated(payload) {
  // Drop parentheses if mixed, keep digits + GS separators
  const compact = payload.replace(/[()]/g, '')

  let gtin = ''
  let datePeremption = ''

  // Fixed-length AI 01
  const ai01 = compact.match(/(?:^|\u001d)01(\d{14})/)
  if (ai01) gtin = ai01[1]

  // Fixed-length AI 17
  const ai17 = compact.match(/(?:^|\u001d)17(\d{6})/)
  if (ai17) datePeremption = yymmddToIso(ai17[1])

  // Fallback without GS: look for 01…17… in a digit stream starting at 01
  if (!gtin || !datePeremption) {
    const digitStream = compact.replace(/\u001d/g, '')
    if (!gtin) {
      const m = digitStream.match(/^01(\d{14})/)
      if (m) gtin = m[1]
      else {
        const embedded = digitStream.match(/01(\d{14})/)
        if (embedded) gtin = embedded[1]
      }
    }
    if (!datePeremption) {
      const m = digitStream.match(/17(\d{6})/)
      if (m) datePeremption = yymmddToIso(m[1])
    }
  }

  return { gtin, datePeremption }
}

/**
 * GS1 AI 17: YYMMDD → YYYY-MM-DD.
 * Day 00 means last day of the month (GS1 convention).
 * Century: 00–49 → 20xx, 50–99 → 19xx.
 */
function yymmddToIso(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return ''

  const yy = Number(yymmdd.slice(0, 2))
  const mm = Number(yymmdd.slice(2, 4))
  let dd = Number(yymmdd.slice(4, 6))

  if (mm < 1 || mm > 12) return ''

  const year = yy <= 49 ? 2000 + yy : 1900 + yy

  if (dd === 0) {
    dd = lastDayOfMonth(year, mm)
  }

  const maxDay = lastDayOfMonth(year, mm)
  if (dd < 1 || dd > maxDay) return ''

  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate()
}
