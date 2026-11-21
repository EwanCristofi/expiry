import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import { createSql } from './db.js'
import { generateResetTokenPair, hashResetToken } from './resetToken.js'
import { parseValidSiret } from './siret.js'

export { hashResetToken, generateResetTokenPair } from './resetToken.js'

const TOKEN_COOKIE = 'expiry_token'
const TOKEN_TTL = '7d'
const BCRYPT_ROUNDS = 12
const TRIAL_DAYS = 7

/**
 * @param {{
 *   pharmacy_id: unknown,
 *   pharmacy_nom: unknown,
 *   pharmacy_code_client: unknown,
 *   pharmacy_siret?: unknown,
 *   pharmacy_status?: unknown,
 *   pharmacy_trial_ends_at?: unknown,
 * }} row
 */
function mapPharmacy(row) {
  return {
    id: String(row.pharmacy_id),
    nom: row.pharmacy_nom,
    code_client: row.pharmacy_code_client,
    siret: row.pharmacy_siret ? String(row.pharmacy_siret) : null,
    status: row.pharmacy_status ? String(row.pharmacy_status) : null,
    trial_ends_at: row.pharmacy_trial_ends_at
      ? new Date(row.pharmacy_trial_ends_at).toISOString()
      : null,
  }
}

/**
 * Génère un `code_client` unique à partir du nom de pharmacie.
 * @param {string} nom
 */
function generateCodeClient(nom) {
  const slug = String(nom)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 8)
    .toUpperCase()
  const suffix = randomBytes(3).toString('hex').toUpperCase()
  return `${slug || 'PHARMA'}-${suffix}`
}

/**
 * @param {unknown} err
 */
function isUniqueViolation(err) {
  return err?.code === '23505' || /duplicate key|unique constraint/i.test(String(err?.message || ''))
}

/** Erreur métier auth (→ 401) vs erreur infra (→ 500). */
export class AuthError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=401]
   */
  constructor(message, status = 401) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) {
    throw new AuthError(
      'JWT_SECRET manquant ou trop court (min. 16 caractères)',
      500,
    )
  }
  return new TextEncoder().encode(secret)
}

/**
 * @param {{ id: string, pharmacy_id: string, role: string, email: string }} user
 */
export async function signToken(user) {
  return new SignJWT({
    pharmacy_id: user.pharmacy_id,
    role: user.role,
    email: user.email,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getJwtSecret())
}

/**
 * @param {string | undefined} token
 * @returns {Promise<{ userId: string, pharmacyId: string, role: string, email: string } | null>}
 */
export async function verifyToken(token) {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getJwtSecret())
    const userId = payload.sub
    const pharmacyId = payload.pharmacy_id
    if (!userId || !pharmacyId) return null
    return {
      userId: String(userId),
      pharmacyId: String(pharmacyId),
      role: String(payload.role || 'staff'),
      email: String(payload.email || ''),
    }
  } catch {
    return null
  }
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function authenticateUser(email, password) {
  const normalized = String(email ?? '')
    .trim()
    .toLowerCase()
  if (!normalized || !password) {
    throw new AuthError('Email et mot de passe obligatoires')
  }

  let rows
  try {
    // Client HTTP Neon frais (process.env.DATABASE_URL), une requête = un fetch.
    const sql = createSql()
    rows = await sql`
      SELECT
        u.id,
        u.email,
        u.password_hash,
        u.nom,
        u.role,
        u.pharmacy_id,
        p.nom AS pharmacy_nom,
        p.code_client AS pharmacy_code_client,
        p.siret AS pharmacy_siret,
        p.status AS pharmacy_status,
        p.trial_ends_at AS pharmacy_trial_ends_at
      FROM users u
      JOIN pharmacies p ON p.id = u.pharmacy_id
      WHERE u.email = ${normalized}
      LIMIT 1
    `
  } catch (err) {
    if (err instanceof AuthError) throw err
    const message =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Timeout Neon : ${err.message}`
        : err?.message || 'Erreur base de données'
    console.error('[auth/authenticateUser]', err)
    throw new AuthError(message, 500)
  }

  const user = rows[0]
  if (!user) {
    throw new AuthError('Identifiants invalides')
  }

  const ok = await bcrypt.compare(String(password), user.password_hash)
  if (!ok) {
    throw new AuthError('Identifiants invalides')
  }

  return {
    id: String(user.id),
    email: user.email,
    nom: user.nom,
    role: user.role,
    pharmacy_id: String(user.pharmacy_id),
    pharmacy: mapPharmacy(user),
  }
}

/**
 * Crée une pharmacie + un compte administrateur.
 * @param {{ nom?: string, email?: string, password?: string, siret?: string }} input
 */
export async function registerPharmacy(input) {
  const nom = String(input?.nom ?? '').trim()
  const normalized = String(input?.email ?? '')
    .trim()
    .toLowerCase()
  const password = String(input?.password ?? '')
  const siret = parseValidSiret(input?.siret)

  if (!siret) {
    throw new AuthError('SIRET invalide (14 chiffres, contrôle Luhn)', 400)
  }
  if (!nom || !normalized || !password) {
    throw new AuthError(
      'Nom de pharmacie, email et mot de passe obligatoires',
      400,
    )
  }
  if (password.length < 8) {
    throw new AuthError('Le mot de passe doit contenir au moins 8 caractères', 400)
  }

  const sql = createSql()
  const trialEndsAt = new Date(
    Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  try {
    const existingEmail = await sql`
      SELECT id FROM users WHERE email = ${normalized} LIMIT 1
    `
    if (existingEmail[0]) {
      throw new AuthError('Cet email est déjà utilisé', 409)
    }

    const existingSiret = await sql`
      SELECT id FROM pharmacies WHERE siret = ${siret} LIMIT 1
    `
    if (existingSiret[0]) {
      throw new AuthError('Ce SIRET est déjà associé à un espace pharmacie', 409)
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const codeClient = generateCodeClient(nom)

    // CTE atomique : pharmacie + admin (évite une pharmacie orpheline).
    const rows = await sql`
      WITH new_pharmacy AS (
        INSERT INTO pharmacies (nom, code_client, siret, status, trial_ends_at)
        VALUES (
          ${nom},
          ${codeClient},
          ${siret},
          'TRIAL',
          ${trialEndsAt}::timestamptz
        )
        RETURNING
          id,
          nom,
          code_client,
          siret,
          status,
          trial_ends_at
      ),
      new_user AS (
        INSERT INTO users (email, password_hash, pharmacy_id, role)
        SELECT ${normalized}, ${passwordHash}, id, 'admin'
        FROM new_pharmacy
        RETURNING id, email, nom, role, pharmacy_id
      )
      SELECT
        u.id,
        u.email,
        u.nom,
        u.role,
        u.pharmacy_id,
        p.nom AS pharmacy_nom,
        p.code_client AS pharmacy_code_client,
        p.siret AS pharmacy_siret,
        p.status AS pharmacy_status,
        p.trial_ends_at AS pharmacy_trial_ends_at
      FROM new_user u
      JOIN new_pharmacy p ON p.id = u.pharmacy_id
    `

    const user = rows[0]
    if (!user) {
      throw new AuthError('Inscription impossible', 500)
    }

    return {
      id: String(user.id),
      email: user.email,
      nom: user.nom,
      role: user.role,
      pharmacy_id: String(user.pharmacy_id),
      pharmacy: mapPharmacy(user),
    }
  } catch (err) {
    if (err instanceof AuthError) throw err
    if (isUniqueViolation(err)) {
      const detail = String(err?.detail || err?.message || '')
      if (/siret/i.test(detail)) {
        throw new AuthError(
          'Ce SIRET est déjà associé à un espace pharmacie',
          409,
        )
      }
      throw new AuthError('Cet email est déjà utilisé', 409)
    }
    const message =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Timeout Neon : ${err.message}`
        : err?.message || 'Erreur base de données'
    console.error('[auth/registerPharmacy]', err)
    throw new AuthError(message, 500)
  }
}

/**
 * @param {string} userId
 */
export async function getUserProfile(userId) {
  try {
    const sql = createSql()
    const rows = await sql`
      SELECT
        u.id,
        u.email,
        u.nom,
        u.role,
        u.pharmacy_id,
        p.nom AS pharmacy_nom,
        p.code_client AS pharmacy_code_client,
        p.siret AS pharmacy_siret,
        p.status AS pharmacy_status,
        p.trial_ends_at AS pharmacy_trial_ends_at
      FROM users u
      JOIN pharmacies p ON p.id = u.pharmacy_id
      WHERE u.id = ${userId}::uuid
      LIMIT 1
    `
    const user = rows[0]
    if (!user) return null
    return {
      id: String(user.id),
      email: user.email,
      nom: user.nom,
      role: user.role,
      pharmacy_id: String(user.pharmacy_id),
      pharmacy: mapPharmacy(user),
    }
  } catch (err) {
    console.error('[auth/getUserProfile]', err)
    throw new AuthError(err?.message || 'Erreur base de données', 500)
  }
}

export function readBearerToken(authHeader) {
  if (!authHeader) return null
  const [scheme, token] = String(authHeader).split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000
const NEUTRAL_FORGOT_MESSAGE =
  'Si un compte est associé à cette adresse, un lien de réinitialisation vient d’être envoyé.'
const DEV_FALLBACK_APP_URL = 'http://localhost:5173'

/**
 * @returns {boolean}
 */
export function isProductionEnv() {
  return process.env.NODE_ENV === 'production'
}

/**
 * Normalise et valide une URL d’application (liens e-mail uniquement).
 * N’accepte jamais Origin / Host / x-forwarded-* — uniquement `APP_URL`.
 *
 * @param {string} raw
 * @param {{ requireHttps?: boolean }} [options]
 * @returns {string} URL sans slash final
 */
export function normalizeAppUrl(raw, options = {}) {
  const requireHttps = Boolean(options.requireHttps)
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    throw new AuthError(
      'APP_URL manquante : définissez l’URL publique HTTPS de l’application',
      500,
    )
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new AuthError('APP_URL invalide (URL absolue attendue)', 500)
  }

  if (parsed.username || parsed.password) {
    throw new AuthError(
      'APP_URL invalide (identifiants interdits dans l’URL)',
      500,
    )
  }

  const protocol = parsed.protocol.toLowerCase()
  if (requireHttps) {
    if (protocol !== 'https:') {
      throw new AuthError(
        'APP_URL invalide en production : HTTPS obligatoire',
        500,
      )
    }
  } else if (protocol !== 'http:' && protocol !== 'https:') {
    throw new AuthError('APP_URL invalide (http ou https attendu)', 500)
  }

  const path =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  return `${parsed.origin}${path}`
}

/**
 * URL publique de l’app pour les liens e-mail (reset password).
 *
 * - Production : `APP_URL` obligatoire, HTTPS uniquement. Aucun fallback
 *   Origin / Host / x-forwarded-host. Pas de `VITE_*` / `NEXT_PUBLIC_*`.
 * - Développement : `APP_URL` si définie (http/https), sinon localhost.
 *
 * Les en-têtes de requête éventuels sont volontairement ignorés.
 *
 * @param {unknown} [_req] ignoré (compatibilité d’appel)
 * @returns {string}
 */
export function resolveAppUrl(_req) {
  const fromEnv = process.env.APP_URL
  const requireHttps = isProductionEnv()

  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return normalizeAppUrl(fromEnv, { requireHttps })
  }

  if (requireHttps) {
    throw new AuthError(
      'APP_URL manquante : définissez l’URL publique HTTPS de l’application',
      500,
    )
  }

  return DEV_FALLBACK_APP_URL
}

/**
 * Construit le chemin relatif de reset (évite toute redirection ouverte).
 * @param {string} token
 */
export function buildPasswordResetPath(token) {
  return `/reset-password?token=${encodeURIComponent(String(token ?? ''))}`
}

/**
 * Accès DB pour le flux reset (injectable en tests).
 * @typedef {{
 *   findUserByEmail: (email: string) => Promise<{ id: string, email: string } | null>,
 *   saveResetTokenHash: (userId: string, tokenHash: string, expiresAt: string) => Promise<void>,
 *   findUserByResetTokenHash: (tokenHash: string) => Promise<{ id: string, reset_token_expires: unknown } | null>,
 *   consumeResetToken: (userId: string, passwordHash: string) => Promise<void>,
 * }} PasswordResetStore
 */

/**
 * @returns {PasswordResetStore}
 */
function createNeonPasswordResetStore() {
  return {
    async findUserByEmail(email) {
      const sql = createSql()
      const rows = await sql`
        SELECT id, email
        FROM users
        WHERE lower(email) = ${email}
        LIMIT 1
      `
      return rows[0]
        ? { id: String(rows[0].id), email: String(rows[0].email) }
        : null
    },
    async saveResetTokenHash(userId, tokenHash, expiresAt) {
      const sql = createSql()
      await sql`
        UPDATE users
        SET
          reset_token = ${tokenHash},
          reset_token_expires = ${expiresAt}::timestamptz
        WHERE id = ${userId}::uuid
      `
    },
    async findUserByResetTokenHash(tokenHash) {
      const sql = createSql()
      const rows = await sql`
        SELECT id, reset_token_expires
        FROM users
        WHERE reset_token = ${tokenHash}
        LIMIT 1
      `
      return rows[0]
        ? {
            id: String(rows[0].id),
            reset_token_expires: rows[0].reset_token_expires,
          }
        : null
    },
    async consumeResetToken(userId, passwordHash) {
      const sql = createSql()
      await sql`
        UPDATE users
        SET
          password_hash = ${passwordHash},
          reset_token = NULL,
          reset_token_expires = NULL
        WHERE id = ${userId}::uuid
      `
    },
  }
}

/**
 * @param {{
 *   to: string,
 *   from: string,
 *   resetUrl: string,
 * }} payload
 */
async function sendPasswordResetEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error('[auth/requestPasswordReset] RESEND_API_KEY manquante')
    throw new AuthError('Envoi d’e-mail indisponible', 500)
  }

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from: payload.from,
    to: payload.to,
    subject: 'Réinitialisation de votre mot de passe Expiry',
    html: `
      <div style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <h1 style="font-size: 20px; font-weight: 600; color: #134e4a; margin: 0 0 16px;">Expiry</h1>
        <p style="font-size: 15px; line-height: 1.5; margin: 0 0 12px;">
          Vous avez demandé la réinitialisation de votre mot de passe.
        </p>
        <p style="font-size: 15px; line-height: 1.5; margin: 0 0 24px;">
          Ce lien est valable une heure. Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.
        </p>
        <p style="margin: 0 0 24px;">
          <a href="${payload.resetUrl}"
             style="display: inline-block; background: #0f766e; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 20px; border-radius: 8px;">
            Réinitialiser mon mot de passe
          </a>
        </p>
        <p style="font-size: 12px; line-height: 1.5; color: #64748b; margin: 0;">
          Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br />
          <a href="${payload.resetUrl}" style="color: #0f766e; word-break: break-all;">${payload.resetUrl}</a>
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('[auth/requestPasswordReset] resend', error)
    throw new AuthError('Envoi d’e-mail impossible', 500)
  }
}

/**
 * Crée un jeton de reset et envoie l’e-mail via Resend.
 * Réponse toujours neutre (anti-énumération).
 * Le jeton clair n’est jamais persisté : seule l’empreinte SHA-256 est stockée.
 *
 * @param {string} email
 * @param {{
 *   store?: PasswordResetStore,
 *   sendEmail?: (payload: { to: string, from: string, resetUrl: string }) => Promise<void>,
 *   now?: () => number,
 * }} [options]
 */
export async function requestPasswordReset(email, options = {}) {
  const normalized = String(email ?? '')
    .trim()
    .toLowerCase()

  if (!normalized) {
    throw new AuthError('Email obligatoire', 400)
  }

  // Fail-closed avant toute écriture DB si l’URL de lien est indisponible.
  const appUrl = resolveAppUrl()
  const store = options.store ?? createNeonPasswordResetStore()
  const sendEmail = options.sendEmail ?? sendPasswordResetEmail
  const nowMs = options.now?.() ?? Date.now()

  let user
  try {
    user = await store.findUserByEmail(normalized)
  } catch (err) {
    console.error('[auth/requestPasswordReset]', err)
    throw new AuthError(err?.message || 'Erreur base de données', 500)
  }

  if (!user) {
    return { message: NEUTRAL_FORGOT_MESSAGE }
  }

  const { token, tokenHash } = generateResetTokenPair()
  const expiresAt = new Date(nowMs + RESET_TOKEN_TTL_MS).toISOString()

  try {
    // Persiste uniquement l’empreinte — jamais le jeton clair.
    await store.saveResetTokenHash(String(user.id), tokenHash, expiresAt)
  } catch (err) {
    console.error('[auth/requestPasswordReset] update', err)
    throw new AuthError(err?.message || 'Erreur base de données', 500)
  }

  const from =
    process.env.EMAIL_FROM || 'Expiry <ne-pas-repondre@expiry.fr>'
  const resetUrl = `${appUrl}${buildPasswordResetPath(token)}`

  await sendEmail({
    to: String(user.email),
    from,
    resetUrl,
  })

  return { message: NEUTRAL_FORGOT_MESSAGE }
}

/**
 * Valide le jeton et met à jour le mot de passe (bcrypt, mêmes rounds que l’inscription).
 * Lookup uniquement via SHA-256(token) ; invalidation après succès.
 *
 * @param {string} token
 * @param {string} password
 * @param {{
 *   store?: PasswordResetStore,
 *   now?: () => number,
 * }} [options]
 */
export async function resetPasswordWithToken(token, password, options = {}) {
  const rawToken = String(token ?? '').trim()
  const nextPassword = String(password ?? '')

  if (!rawToken || !nextPassword) {
    throw new AuthError('Jeton et mot de passe obligatoires', 400)
  }
  if (nextPassword.length < 8) {
    throw new AuthError(
      'Le mot de passe doit contenir au moins 8 caractères',
      400,
    )
  }

  const store = options.store ?? createNeonPasswordResetStore()
  const nowMs = options.now?.() ?? Date.now()
  const tokenHash = hashResetToken(rawToken)

  let user
  try {
    user = await store.findUserByResetTokenHash(tokenHash)
  } catch (err) {
    console.error('[auth/resetPasswordWithToken]', err)
    throw new AuthError(err?.message || 'Erreur base de données', 500)
  }

  const expiresAt = user?.reset_token_expires
    ? new Date(user.reset_token_expires).getTime()
    : 0
  if (!user || !expiresAt || expiresAt <= nowMs) {
    throw new AuthError(
      'Ce lien est invalide ou a expiré. Veuillez faire une nouvelle demande.',
      400,
    )
  }

  const passwordHash = await bcrypt.hash(nextPassword, BCRYPT_ROUNDS)

  try {
    await store.consumeResetToken(String(user.id), passwordHash)
  } catch (err) {
    console.error('[auth/resetPasswordWithToken] update', err)
    throw new AuthError(err?.message || 'Erreur base de données', 500)
  }

  return { ok: true }
}

export { TOKEN_COOKIE }
