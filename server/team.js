import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { AuthError } from './auth.js'
import { createSql } from './db.js'
import { isPlatformAdmin } from './platformAdmin.js'

const BCRYPT_ROUNDS = 12

/** @type {null | (() => ReturnType<typeof createSql>)} */
let teamSqlFactoryForTests = null

/**
 * Injection du client SQL (tests uniquement). Passer `null` pour restaurer Neon.
 * @param {null | (() => ReturnType<typeof createSql>)} factory
 */
export function setTeamSqlFactoryForTests(factory) {
  teamSqlFactoryForTests = factory
}

function getSql() {
  return teamSqlFactoryForTests ? teamSqlFactoryForTests() : createSql()
}

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
 * @param {unknown} raw
 * @returns {boolean}
 */
function coerceIsActive(raw) {
  return raw === true
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
    is_active: coerceIsActive(row.is_active),
    created_at: row.created_at
      ? new Date(row.created_at).toISOString()
      : null,
  }
}

/**
 * @param {string} pharmacyId
 * @param {string} targetUserId
 */
async function findTeamMemberRow(pharmacyId, targetUserId) {
  const sql = getSql()
  const rows = await sql`
    SELECT id, email, nom, role, is_active, session_version, created_at
    FROM users
    WHERE id = ${targetUserId}::uuid
      AND pharmacy_id = ${pharmacyId}::uuid
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * @param {string} pharmacyId
 */
export async function listTeamMembers(pharmacyId) {
  const sql = getSql()
  const rows = await sql`
    SELECT id, email, nom, role, is_active, created_at
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

  const sql = getSql()
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
      RETURNING id, email, nom, role, is_active, created_at
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
 * Désactivation atomique : verrouille tous les admins actifs de la pharmacie
 * (CTE FOR UPDATE), puis n’applique le soft-disable que s’il resterait ≥1 admin actif.
 * Deux désactivations concurrentes se sérialisent sur ces verrous ligne ; la seconde
 * voit COUNT=1 et n’affecte aucune ligne → 409.
 *
 * @param {string} pharmacyId
 * @param {string} targetUserId
 */
async function deactivateTeamMemberAtomic(pharmacyId, targetUserId) {
  const sql = getSql()
  const rows = await sql`
    WITH locked_admins AS (
      SELECT id
      FROM users
      WHERE pharmacy_id = ${pharmacyId}::uuid
        AND role = 'admin'
        AND is_active = true
      FOR UPDATE
    )
    UPDATE users AS u
    SET
      is_active = false,
      session_version = session_version + 1
    WHERE u.id = ${targetUserId}::uuid
      AND u.pharmacy_id = ${pharmacyId}::uuid
      AND u.is_active = true
      AND (
        u.role <> 'admin'
        OR (SELECT COUNT(*)::int FROM locked_admins) > 1
      )
    RETURNING u.id, u.email, u.nom, u.role, u.is_active, u.session_version, u.created_at
  `
  return rows[0] ?? null
}

/**
 * @param {string} pharmacyId
 * @param {string} targetUserId
 */
async function reactivateTeamMemberAtomic(pharmacyId, targetUserId) {
  const sql = getSql()
  const rows = await sql`
    UPDATE users
    SET is_active = true
    WHERE id = ${targetUserId}::uuid
      AND pharmacy_id = ${pharmacyId}::uuid
      AND is_active = false
    RETURNING id, email, nom, role, is_active, session_version, created_at
  `
  return rows[0] ?? null
}

/**
 * Soft-disable / réactivation d’un membre (scoped pharmacie).
 *
 * @param {string} pharmacyId
 * @param {string} actorUserId
 * @param {string} targetUserId
 * @param {boolean} nextActive
 */
export async function setTeamMemberActive(
  pharmacyId,
  actorUserId,
  targetUserId,
  nextActive,
) {
  if (typeof nextActive !== 'boolean') {
    throw new AuthError('is_active doit être un booléen', 400)
  }

  if (nextActive === false && String(actorUserId) === String(targetUserId)) {
    throw new AuthError('Vous ne pouvez pas désactiver votre propre compte', 400)
  }

  const current = await findTeamMemberRow(pharmacyId, targetUserId)
  if (!current) {
    throw new AuthError('Utilisateur introuvable', 404)
  }

  const currentlyActive = coerceIsActive(current.is_active)
  if (currentlyActive === nextActive) {
    return mapMember(current)
  }

  if (nextActive === false) {
    if (
      isPlatformAdmin({
        userId: String(current.id),
        email: String(current.email || ''),
      })
    ) {
      throw new AuthError('Compte plateforme protégé', 403)
    }

    const updated = await deactivateTeamMemberAtomic(pharmacyId, targetUserId)
    if (!updated) {
      // Course possible : dernier admin actif, ou déjà désactivé entre-temps.
      const again = await findTeamMemberRow(pharmacyId, targetUserId)
      if (!again) {
        throw new AuthError('Utilisateur introuvable', 404)
      }
      if (!coerceIsActive(again.is_active)) {
        return mapMember(again)
      }
      throw new AuthError(
        'Impossible de désactiver le dernier administrateur actif',
        409,
      )
    }
    return mapMember(updated)
  }

  const updated = await reactivateTeamMemberAtomic(pharmacyId, targetUserId)
  if (!updated) {
    const again = await findTeamMemberRow(pharmacyId, targetUserId)
    if (!again) {
      throw new AuthError('Utilisateur introuvable', 404)
    }
    return mapMember(again)
  }
  return mapMember(updated)
}

/**
 * Mise à jour atomique nom/rôle/password/is_active (une statement Neon HTTP).
 *
 * Seuls les champs explicitement fournis (`hasNomUpdate` / `hasRoleUpdate` /
 * `hasActiveUpdate` / `hasPasswordChange`) sont réécrits ; les autres conservent
 * `u.nom` / `u.role` / `u.is_active` / `u.password_hash` (pas de valeur issue
 * d’une lecture préalable — évite les lost updates concurrents).
 *
 * Transitions (dernier admin actif, bump session) calculées sur l’état courant
 * de la ligne sous `FOR UPDATE` des admins actifs.
 *
 * @param {string} pharmacyId
 * @param {string} targetUserId
 * @param {{
 *   hasNomUpdate: boolean,
 *   nom: string | null,
 *   hasRoleUpdate: boolean,
 *   role: 'admin' | 'staff' | null,
 *   hasActiveUpdate: boolean,
 *   nextActive: boolean | null,
 *   hasPasswordChange: boolean,
 *   passwordHash: string | null,
 * }} patch
 */
async function updateTeamMemberAtomic(pharmacyId, targetUserId, patch) {
  const sql = getSql()
  const nom = patch.hasNomUpdate ? patch.nom : null
  const role = patch.hasRoleUpdate ? patch.role : null
  const nextActive = patch.hasActiveUpdate ? patch.nextActive : null
  const passwordHash = patch.hasPasswordChange ? patch.passwordHash : null
  const rows = await sql`
    WITH locked_admins AS (
      SELECT id
      FROM users
      WHERE pharmacy_id = ${pharmacyId}::uuid
        AND role = 'admin'
        AND is_active = true
      FOR UPDATE
    )
    UPDATE users AS u
    SET
      nom = CASE
        WHEN ${patch.hasNomUpdate}::boolean THEN ${nom}
        ELSE u.nom
      END,
      role = CASE
        WHEN ${patch.hasRoleUpdate}::boolean THEN ${role}
        ELSE u.role
      END,
      password_hash = CASE
        WHEN ${patch.hasPasswordChange}::boolean THEN ${passwordHash}
        ELSE u.password_hash
      END,
      is_active = CASE
        WHEN ${patch.hasActiveUpdate}::boolean THEN ${nextActive}
        ELSE u.is_active
      END,
      session_version = u.session_version
        + CASE WHEN ${patch.hasPasswordChange}::boolean THEN 1 ELSE 0 END
        + CASE
            WHEN ${patch.hasActiveUpdate}::boolean
              AND ${nextActive}::boolean = false
              AND u.is_active = true
            THEN 1
            ELSE 0
          END
    WHERE u.id = ${targetUserId}::uuid
      AND u.pharmacy_id = ${pharmacyId}::uuid
      AND (
        NOT (u.role = 'admin' AND u.is_active = true)
        OR (
          (
            CASE
              WHEN ${patch.hasRoleUpdate}::boolean THEN ${role}
              ELSE u.role
            END
          ) = 'admin'
          AND (
            CASE
              WHEN ${patch.hasActiveUpdate}::boolean THEN ${nextActive}
              ELSE u.is_active
            END
          ) = true
        )
        OR (SELECT COUNT(*)::int FROM locked_admins) > 1
      )
    RETURNING u.id, u.email, u.nom, u.role, u.is_active, u.session_version, u.created_at
  `
  return rows[0] ?? null
}

/**
 * @param {string} pharmacyId
 * @param {string} actorUserId
 * @param {string} targetUserId
 * @param {{ nom?: string, role?: string, password?: string, is_active?: boolean }} input
 */
export async function updateTeamMember(
  pharmacyId,
  actorUserId,
  targetUserId,
  input,
) {
  const hasNomUpdate = input?.nom !== undefined
  const hasRoleUpdate = input?.role !== undefined
  const hasActiveUpdate = Object.prototype.hasOwnProperty.call(
    input ?? {},
    'is_active',
  )
  const password =
    input?.password != null && String(input.password) !== ''
      ? String(input.password)
      : ''
  const hasPasswordChange = Boolean(password)
  const hasProfileUpdate = hasNomUpdate || hasRoleUpdate || hasPasswordChange

  if (!hasProfileUpdate && !hasActiveUpdate) {
    throw new AuthError('Aucune modification fournie', 400)
  }

  if (hasActiveUpdate && typeof input.is_active !== 'boolean') {
    throw new AuthError('is_active doit être un booléen', 400)
  }

  // is_active seul : réutilise le chemin soft-disable / réactivation dédié.
  if (!hasProfileUpdate && hasActiveUpdate) {
    return setTeamMemberActive(
      pharmacyId,
      actorUserId,
      targetUserId,
      input.is_active,
    )
  }

  const nextNom = hasNomUpdate ? String(input.nom).trim() : null
  if (hasNomUpdate && !nextNom) {
    throw new AuthError('Le nom est obligatoire', 400)
  }

  /** @type {'admin' | 'staff' | null} */
  const nextRole = hasRoleUpdate ? normalizeRole(input.role) : null
  /** @type {boolean | null} */
  const nextActive = hasActiveUpdate ? input.is_active : null

  if (hasActiveUpdate && nextActive === false) {
    if (String(actorUserId) === String(targetUserId)) {
      throw new AuthError('Vous ne pouvez pas désactiver votre propre compte', 400)
    }
  }

  if (hasPasswordChange && password.length < 8) {
    throw new AuthError(
      'Le mot de passe doit contenir au moins 8 caractères',
      400,
    )
  }

  // Lecture uniquement pour existence / garde plateforme — jamais pour réécrire
  // les champs non fournis (valeurs effectives résolues en SQL sur u.*).
  const current = await findTeamMemberRow(pharmacyId, targetUserId)
  if (!current) {
    throw new AuthError('Utilisateur introuvable', 404)
  }

  if (
    hasActiveUpdate &&
    nextActive === false &&
    isPlatformAdmin({
      userId: String(current.id),
      email: String(current.email || ''),
    })
  ) {
    throw new AuthError('Compte plateforme protégé', 403)
  }

  const passwordHash = hasPasswordChange
    ? await bcrypt.hash(password, BCRYPT_ROUNDS)
    : null

  try {
    const updated = await updateTeamMemberAtomic(pharmacyId, targetUserId, {
      hasNomUpdate,
      nom: nextNom,
      hasRoleUpdate,
      role: nextRole,
      hasActiveUpdate,
      nextActive,
      hasPasswordChange,
      passwordHash,
    })

    if (!updated) {
      const again = await findTeamMemberRow(pharmacyId, targetUserId)
      if (!again) {
        throw new AuthError('Utilisateur introuvable', 404)
      }
      const effectiveRole = hasRoleUpdate
        ? /** @type {'admin' | 'staff'} */ (nextRole)
        : String(again.role) === 'admin'
          ? 'admin'
          : 'staff'
      const effectiveActive = hasActiveUpdate
        ? /** @type {boolean} */ (nextActive)
        : coerceIsActive(again.is_active)
      const losesActiveAdmin =
        coerceIsActive(again.is_active) &&
        String(again.role) === 'admin' &&
        !(effectiveRole === 'admin' && effectiveActive === true)
      if (losesActiveAdmin) {
        throw new AuthError(
          hasActiveUpdate && nextActive === false
            ? 'Impossible de désactiver le dernier administrateur actif'
            : 'Impossible de retirer le dernier administrateur',
          409,
        )
      }
      throw new AuthError('Mise à jour impossible', 409)
    }

    return mapMember(updated)
  } catch (err) {
    if (err instanceof AuthError) throw err
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

  const sql = getSql()
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
