import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { AuthError } from './auth.js'
import { createSql } from './db.js'

const BCRYPT_ROUNDS = 12

/**
 * @param {unknown} role
 * @returns {'admin' | 'staff'}
 */
export function normalizeRole(role) {
  const value = String(role ?? '')
    .trim()
    .toLowerCase()
  if (value === 'admin' || value === 'administrator') return 'admin'
  if (value === 'staff' || value === 'member') return 'staff'
  throw new AuthError("Rôle invalide (ADMIN ou STAFF)", 400)
}

/**
 * @param {unknown} err
 */
function isUniqueViolation(err) {
  return (
    err?.code === '23505' ||
    /duplicate key|unique constraint/i.test(String(err?.message || ''))
  )
}

/**
 * @param {Record<string, unknown>} row
 */
function mapMember(row) {
  return {
    id: String(row.id),
    email: row.email,
    nom: row.nom ?? null,
    role: String(row.role || 'staff').toUpperCase(),
    created_at: row.created_at
      ? new Date(row.created_at).toISOString()
      : null,
  }
}

/**
 * @param {string} pharmacyId
 */
export async function listTeamMembers(pharmacyId) {
  const sql = createSql()
  const rows = await sql`
    SELECT id, email, nom, role, created_at
    FROM users
    WHERE pharmacy_id = ${pharmacyId}::uuid
    ORDER BY
      CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
      created_at ASC
  `
  return rows.map(mapMember)
}

/**
 * @param {string} pharmacyId
 * @param {{ email?: string, nom?: string, role?: string, password?: string }} input
 */
export async function createTeamMember(pharmacyId, input) {
  const email = String(input?.email ?? '')
    .trim()
    .toLowerCase()
  const nom = String(input?.nom ?? '').trim()
  const role = normalizeRole(input?.role)
  let password = String(input?.password ?? '')

  if (!email || !nom) {
    throw new AuthError('Email et nom obligatoires', 400)
  }
  if (!password) {
    password = randomBytes(9).toString('base64url')
  }
  if (password.length < 8) {
    throw new AuthError('Le mot de passe doit contenir au moins 8 caractères', 400)
  }

  const sql = createSql()
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

  try {
    const rows = await sql`
      INSERT INTO users (email, password_hash, pharmacy_id, nom, role)
      VALUES (
        ${email},
        ${passwordHash},
        ${pharmacyId}::uuid,
        ${nom},
        ${role}
      )
      RETURNING id, email, nom, role, created_at
    `
    return {
      user: mapMember(rows[0]),
      temporaryPassword: input?.password ? null : password,
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AuthError('Cet email est déjà utilisé', 409)
    }
    throw new AuthError(err?.message || 'Création impossible', 500)
  }
}

/**
 * @param {string} pharmacyId
 * @param {string} actorUserId
 * @param {string} targetUserId
 * @param {{ nom?: string, role?: string, password?: string }} input
 */
export async function updateTeamMember(
  pharmacyId,
  actorUserId,
  targetUserId,
  input,
) {
  const sql = createSql()
  const existing = await sql`
    SELECT id, email, nom, role, created_at
    FROM users
    WHERE id = ${targetUserId}::uuid
      AND pharmacy_id = ${pharmacyId}::uuid
    LIMIT 1
  `
  const current = existing[0]
  if (!current) {
    throw new AuthError('Utilisateur introuvable', 404)
  }

  const nextNom =
    input?.nom !== undefined ? String(input.nom).trim() : current.nom
  const nextRole =
    input?.role !== undefined ? normalizeRole(input.role) : current.role

  if (!nextNom) {
    throw new AuthError('Le nom est obligatoire', 400)
  }

  if (current.role === 'admin' && nextRole !== 'admin') {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE pharmacy_id = ${pharmacyId}::uuid
        AND role = 'admin'
    `
    if (count <= 1) {
      throw new AuthError('Impossible de retirer le dernier administrateur', 409)
    }
  }

  const password = input?.password != null ? String(input.password) : ''
  if (password && password.length < 8) {
    throw new AuthError('Le mot de passe doit contenir au moins 8 caractères', 400)
  }

  try {
    let rows
    if (password) {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      rows = await sql`
        UPDATE users
        SET
          nom = ${nextNom},
          role = ${nextRole},
          password_hash = ${passwordHash},
          session_version = session_version + 1
        WHERE id = ${targetUserId}::uuid
          AND pharmacy_id = ${pharmacyId}::uuid
        RETURNING id, email, nom, role, created_at
      `
    } else {
      rows = await sql`
        UPDATE users
        SET nom = ${nextNom}, role = ${nextRole}
        WHERE id = ${targetUserId}::uuid
          AND pharmacy_id = ${pharmacyId}::uuid
        RETURNING id, email, nom, role, created_at
      `
    }
    return mapMember(rows[0])
  } catch (err) {
    throw new AuthError(err?.message || 'Mise à jour impossible', 500)
  }
}

/**
 * @param {string} pharmacyId
 * @param {string} actorUserId
 * @param {string} targetUserId
 */
export async function deleteTeamMember(pharmacyId, actorUserId, targetUserId) {
  if (String(actorUserId) === String(targetUserId)) {
    throw new AuthError('Vous ne pouvez pas supprimer votre propre compte', 400)
  }

  const sql = createSql()
  const existing = await sql`
    SELECT id, role
    FROM users
    WHERE id = ${targetUserId}::uuid
      AND pharmacy_id = ${pharmacyId}::uuid
    LIMIT 1
  `
  const current = existing[0]
  if (!current) {
    throw new AuthError('Utilisateur introuvable', 404)
  }

  if (current.role === 'admin') {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE pharmacy_id = ${pharmacyId}::uuid
        AND role = 'admin'
    `
    if (count <= 1) {
      throw new AuthError('Impossible de supprimer le dernier administrateur', 409)
    }
  }

  await sql`
    DELETE FROM users
    WHERE id = ${targetUserId}::uuid
      AND pharmacy_id = ${pharmacyId}::uuid
  `
}
