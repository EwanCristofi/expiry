import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import { sql } from './db.js'

const TOKEN_COOKIE = 'expiry_token'
const TOKEN_TTL = '7d'

function getJwtSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET manquant ou trop court (min. 16 caractères) dans .env.local',
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
    throw new Error('Email et mot de passe obligatoires')
  }

  const rows = await sql`
    SELECT
      u.id,
      u.email,
      u.password_hash,
      u.nom,
      u.role,
      u.pharmacy_id,
      p.nom AS pharmacy_nom,
      p.code_client AS pharmacy_code_client
    FROM users u
    JOIN pharmacies p ON p.id = u.pharmacy_id
    WHERE u.email = ${normalized}
    LIMIT 1
  `

  const user = rows[0]
  if (!user) {
    throw new Error('Identifiants invalides')
  }

  const ok = await bcrypt.compare(String(password), user.password_hash)
  if (!ok) {
    throw new Error('Identifiants invalides')
  }

  return {
    id: String(user.id),
    email: user.email,
    nom: user.nom,
    role: user.role,
    pharmacy_id: String(user.pharmacy_id),
    pharmacy: {
      id: String(user.pharmacy_id),
      nom: user.pharmacy_nom,
      code_client: user.pharmacy_code_client,
    },
  }
}

/**
 * @param {string} userId
 */
export async function getUserProfile(userId) {
  const rows = await sql`
    SELECT
      u.id,
      u.email,
      u.nom,
      u.role,
      u.pharmacy_id,
      p.nom AS pharmacy_nom,
      p.code_client AS pharmacy_code_client
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
    pharmacy: {
      id: String(user.pharmacy_id),
      nom: user.pharmacy_nom,
      code_client: user.pharmacy_code_client,
    },
  }
}

export function readBearerToken(authHeader) {
  if (!authHeader) return null
  const [scheme, token] = String(authHeader).split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

export { TOKEN_COOKIE }
