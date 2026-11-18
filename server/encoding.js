import iconv from 'iconv-lite'

/**
 * Utilitaires d’encodage UTF-8 (connexion Neon + correction mojibake).
 *
 * Symptôme typique : "polyÃ©thylÃ¨ne" au lieu de "polyéthylène"
 * = octets UTF-8 interprétés comme Latin-1 / Windows-1252.
 */

/**
 * Force `client_encoding=UTF8` sur une URL PostgreSQL / Neon.
 * @param {string} databaseUrl
 * @returns {string}
 */
export function withUtf8ClientEncoding(databaseUrl) {
  if (!databaseUrl) return databaseUrl

  try {
    const url = new URL(databaseUrl)
    const existing = url.searchParams.get('options') || ''
    if (!/client_encoding\s*=\s*UTF8/i.test(existing)) {
      const utf8Option = '-c client_encoding=UTF8'
      url.searchParams.set(
        'options',
        existing ? `${existing} ${utf8Option}` : utf8Option,
      )
    }
    return url.toString()
  } catch {
    // URL non parseable (ex. format non standard) : on laisse tel quel
    return databaseUrl
  }
}

/**
 * Indique si la chaîne ressemble à du mojibake Latin-1←UTF-8.
 * Évite les faux positifs français légitimes (`mâcher`, `âge`…).
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeMojibake(value) {
  return (
    typeof value === 'string' &&
    /(?:Ã[\u0080-\u00FF]|Â[\u0080-\u00FF]|â[\u0080-\u00FF]|ð[\u0080-\u00FF])/.test(
      value,
    )
  )
}

/**
 * Répare le mojibake UTF-8 lu comme Latin-1.
 * Gère aussi les chaînes mixtes (accents déjà corrects + fragments corrompus),
 * typiques après import BDPM CIS(Latin-1) + CIP(UTF-8 forcé en Latin-1).
 *
 * Équivalent ciblé de `decodeURIComponent(escape(chunk))`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function fixMojibake(value) {
  if (typeof value !== 'string' || !value) return value
  if (!looksLikeMojibake(value)) return value

  // Remplace uniquement les séquences suspectes (préserve les accents déjà OK)
  return value.replace(
    /(?:Ã[\u0080-\u00FF]|Â[\u0080-\u00FF]|â[\u0080-\u00FF]{1,2}|ð[\u0080-\u00FF]{1,3})+/g,
    (chunk) => {
      try {
        const fixed = Buffer.from(chunk, 'latin1').toString('utf8')
        return !fixed || fixed.includes('\uFFFD') ? chunk : fixed
      } catch {
        return chunk
      }
    },
  )
}

/**
 * Décode un buffer BDPM : UTF-8 si valide, sinon Windows-1252 (CIS historique).
 * `CIS_bdpm.txt` → ISO-8859-1 / Windows-1252
 * `CIS_CIP_bdpm.txt` → UTF-8 (forcer Latin-1 produit "polyÃ©thylÃ¨ne")
 *
 * @param {ArrayBuffer | Buffer | Uint8Array} input
 * @returns {string}
 */
export function decodeBdpmBuffer(input) {
  const bytes =
    input instanceof Buffer
      ? input
      : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input)

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return iconv.decode(bytes, 'win1252')
  }
}
