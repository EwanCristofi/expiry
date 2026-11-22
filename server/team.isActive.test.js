/**
 * Soft-disable équipe : is_active, session_version, isolation, concurrence.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import { AuthError } from './auth.js'
import {
  deleteTeamMember,
  setTeamMemberActive,
  setTeamSqlFactoryForTests,
  updateTeamMember,
} from './team.js'

const PHARMACY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PHARMACY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ADMIN_1 = '11111111-1111-4111-8111-111111111111'
const ADMIN_2 = '22222222-2222-4222-8222-222222222222'
const STAFF_1 = '33333333-3333-4333-8333-333333333333'
const OTHER_PHARMA_USER = '44444444-4444-4444-8444-444444444444'

const ORIGINAL_ENV = {
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
}

const teamSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'team.js'),
  'utf8',
)

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * @param {{
 *   id: string,
 *   email: string,
 *   pharmacy_id: string,
 *   role?: string,
 *   nom?: string,
 *   is_active?: boolean,
 *   session_version?: number,
 *   password_hash?: string,
 * }} input
 */
function makeUser(input) {
  return {
    id: input.id,
    email: input.email,
    pharmacy_id: input.pharmacy_id,
    role: input.role ?? 'staff',
    nom: input.nom ?? 'Member',
    is_active: input.is_active ?? true,
    session_version: input.session_version ?? 0,
    password_hash: input.password_hash ?? 'hash',
    created_at: new Date('2024-01-01T00:00:00.000Z'),
  }
}

/**
 * Mock Neon tagged-template : sérialise les requêtes (simule FOR UPDATE).
 * @param {Map<string, ReturnType<typeof makeUser>>} users
 */
function createLockingTeamSql(users) {
  let chain = Promise.resolve()

  /**
   * @param {() => unknown | Promise<unknown>} fn
   */
  function exclusive(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * @param {string} pharmacyId
   */
  function activeAdminCount(pharmacyId) {
    return [...users.values()].filter(
      (u) =>
        u.pharmacy_id === pharmacyId &&
        u.role === 'admin' &&
        u.is_active === true,
    ).length
  }

  /**
   * @param {ReturnType<typeof makeUser>} target
   * @param {string} nextRole
   * @param {boolean} nextActive
   * @param {number} adminCount
   */
  function allowsLosingActiveAdmin(target, nextRole, nextActive, adminCount) {
    const currentlyActiveAdmin =
      target.role === 'admin' && target.is_active === true
    if (!currentlyActiveAdmin) return true
    if (nextRole === 'admin' && nextActive === true) return true
    return adminCount > 1
  }

  /**
   * Simule l’UPDATE conditionnel de updateTeamMemberAtomic (CASE WHEN flags).
   * Ordre des params aligné sur le tagged-template de team.js :
   * 0 pharmacyId, 1-2 nom, 3-4 role, 5-6 password, 7-8 is_active,
   * 9 passwordBump, 10-11 activeBump, 12 targetId, 13 pharmacyId,
   * 14-17 guard role/active.
   * @param {unknown[]} values
   */
  function applyConditionalMemberUpdate(values) {
    const pharmacyId = String(values[0])
    const hasNomUpdate = values[1] === true
    const nom = values[2]
    const hasRoleUpdate = values[3] === true
    const role = values[4]
    const hasPasswordChange = values[5] === true
    const passwordHash = values[6]
    const hasActiveUpdate = values[7] === true
    const nextActive = values[8]
    const targetId = String(values[12])

    const target = users.get(targetId)
    if (!target || target.pharmacy_id !== pharmacyId) return []

    const effectiveRole = hasRoleUpdate ? String(role) : target.role
    const effectiveActive = hasActiveUpdate
      ? nextActive === true
      : target.is_active === true
    const adminCount = activeAdminCount(pharmacyId)
    if (
      !allowsLosingActiveAdmin(target, effectiveRole, effectiveActive, adminCount)
    ) {
      return []
    }

    if (hasNomUpdate) target.nom = nom
    if (hasRoleUpdate) target.role = effectiveRole
    if (hasPasswordChange) target.password_hash = passwordHash
    const deactivating =
      hasActiveUpdate && nextActive === false && target.is_active === true
    if (hasActiveUpdate) target.is_active = nextActive === true
    target.session_version +=
      (hasPasswordChange ? 1 : 0) + (deactivating ? 1 : 0)
    return [{ ...target }]
  }

  /**
   * @param {TemplateStringsArray} strings
   * @param {...unknown} values
   */
  function sql(strings, ...values) {
    const text = strings.join(' ')
    return exclusive(() => execute(text, values))
  }

  /**
   * @param {string} text
   * @param {unknown[]} values
   */
  function execute(text, values) {
    const normalized = text.replace(/\s+/g, ' ')

    // updateTeamMemberAtomic : CASE WHEN flags (ELSE u.nom) + guard admins actifs
    if (
      normalized.includes('WITH locked_admins') &&
      normalized.includes('FOR UPDATE') &&
      normalized.includes('ELSE u.nom')
    ) {
      return applyConditionalMemberUpdate(values)
    }

    // deactivateTeamMemberAtomic
    if (normalized.includes('WITH locked_admins') && normalized.includes('FOR UPDATE')) {
      const pharmacyId = String(values[0])
      const targetId = String(values[1])
      const target = users.get(targetId)
      if (!target || target.pharmacy_id !== pharmacyId || !target.is_active) {
        return []
      }
      const adminCount = activeAdminCount(pharmacyId)
      if (target.role === 'admin' && adminCount <= 1) {
        return []
      }
      target.is_active = false
      target.session_version += 1
      return [{ ...target }]
    }

    if (
      normalized.includes('SET is_active = true') &&
      normalized.includes('is_active = false')
    ) {
      const targetId = String(values[0])
      const pharmacyId = String(values[1])
      const target = users.get(targetId)
      if (!target || target.pharmacy_id !== pharmacyId || target.is_active) {
        return []
      }
      target.is_active = true
      return [{ ...target }]
    }

    if (normalized.includes('COUNT(*)') && normalized.includes("role = 'admin'")) {
      const pharmacyId = String(values[0])
      // deleteTeamMember historique : compte tous les admins (actifs ou non)
      const count = [...users.values()].filter(
        (u) => u.pharmacy_id === pharmacyId && u.role === 'admin',
      ).length
      return [{ count }]
    }

    if (normalized.includes('DELETE FROM users')) {
      const targetId = String(values[0])
      const pharmacyId = String(values[1])
      const target = users.get(targetId)
      if (target && target.pharmacy_id === pharmacyId) {
        users.delete(targetId)
      }
      return []
    }

    if (normalized.includes('SELECT id, role') && normalized.includes('LIMIT 1')) {
      const targetId = String(values[0])
      const pharmacyId = String(values[1])
      const target = users.get(targetId)
      if (!target || target.pharmacy_id !== pharmacyId) return []
      return [{ id: target.id, role: target.role }]
    }

    if (
      normalized.includes('SELECT id, email, nom, role, is_active, session_version, created_at') ||
      normalized.includes('SELECT id, email, nom, role, is_active, created_at')
    ) {
      if (normalized.includes('ORDER BY')) {
        const pharmacyId = String(values[0])
        return [...users.values()]
          .filter((u) => u.pharmacy_id === pharmacyId)
          .map((u) => ({ ...u }))
      }
      const targetId = String(values[0])
      const pharmacyId = String(values[1])
      const target = users.get(targetId)
      if (!target || target.pharmacy_id !== pharmacyId) return []
      return [{ ...target }]
    }

    throw new Error(`Mock SQL non géré : ${normalized.slice(0, 160)}`)
  }

  return sql
}

/** @type {Map<string, ReturnType<typeof makeUser>>} */
let users

beforeEach(() => {
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_USER_ID
  users = new Map()
  for (const row of [
    makeUser({
      id: ADMIN_1,
      email: 'admin1@a.local',
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      nom: 'Admin One',
      session_version: 3,
    }),
    makeUser({
      id: ADMIN_2,
      email: 'admin2@a.local',
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      nom: 'Admin Two',
      session_version: 1,
    }),
    makeUser({
      id: STAFF_1,
      email: 'staff@a.local',
      pharmacy_id: PHARMACY_A,
      role: 'staff',
      nom: 'Staff',
      session_version: 0,
    }),
    makeUser({
      id: OTHER_PHARMA_USER,
      email: 'admin@b.local',
      pharmacy_id: PHARMACY_B,
      role: 'admin',
      nom: 'Other',
    }),
  ]) {
    users.set(row.id, row)
  }
  setTeamSqlFactoryForTests(() => createLockingTeamSql(users))
})

afterEach(() => {
  setTeamSqlFactoryForTests(null)
})

after(() => {
  restoreEnv()
  setTeamSqlFactoryForTests(null)
})

describe('team is_active — contrats source', () => {
  it('désactivation : CTE FOR UPDATE + bump session_version atomique', () => {
    assert.match(teamSrc, /WITH locked_admins AS/)
    assert.match(teamSrc, /FOR UPDATE/)
    assert.match(
      teamSrc,
      /is_active = false,[\s\S]*?session_version = session_version \+ 1/,
    )
    assert.match(teamSrc, /\(SELECT COUNT\(\*\)::int FROM locked_admins\) > 1/)
    assert.match(teamSrc, /AND u\.pharmacy_id = \$\{pharmacyId\}::uuid/)
  })

  it('updateTeamMemberAtomic : CASE WHEN flags + FOR UPDATE (pas d’écrasement des champs non fournis)', () => {
    const atomic = teamSrc.match(
      /async function updateTeamMemberAtomic[\s\S]*?^}/m,
    )
    assert.ok(atomic)
    assert.match(atomic[0], /WITH locked_admins AS/)
    assert.match(atomic[0], /FOR UPDATE/)
    assert.match(atomic[0], /hasNomUpdate/)
    assert.match(atomic[0], /hasRoleUpdate/)
    assert.match(atomic[0], /hasActiveUpdate/)
    assert.match(atomic[0], /ELSE u\.nom/)
    assert.match(atomic[0], /ELSE u\.role/)
    assert.match(atomic[0], /ELSE u\.is_active/)
    assert.match(
      atomic[0],
      /NOT \(u\.role = 'admin' AND u\.is_active = true\)/,
    )
    assert.match(
      atomic[0],
      /session_version = u\.session_version[\s\S]*hasPasswordChange[\s\S]*hasActiveUpdate/,
    )
    const updateFn = teamSrc.match(
      /export async function updateTeamMember[\s\S]*?^}/m,
    )
    assert.ok(updateFn)
    assert.match(updateFn[0], /updateTeamMemberAtomic\(/)
    assert.equal(
      [...updateFn[0].matchAll(/setTeamMemberActive\(/g)].length,
      1,
    )
    assert.match(updateFn[0], /if \(!hasProfileUpdate && hasActiveUpdate\)/)
    // Diagnostic 409 : relecture `again`, pas l’objet `current` stale
    assert.match(updateFn[0], /const again = await findTeamMemberRow/)
    assert.match(updateFn[0], /coerceIsActive\(again\.is_active\)/)
    assert.doesNotMatch(
      updateFn[0],
      /losesActiveAdmin[\s\S]*current\.is_active/,
    )
  })

  it('réactivation : is_active=true sans bump session_version', () => {
    const reactivate = teamSrc.match(
      /async function reactivateTeamMemberAtomic[\s\S]*?^}/m,
    )
    assert.ok(reactivate)
    assert.match(reactivate[0], /SET is_active = true/)
    assert.doesNotMatch(
      reactivate[0],
      /SET[\s\S]*session_version\s*=\s*session_version\s*\+\s*1/,
    )
  })

  it('deleteTeamMember inchangé (DELETE physique, pas is_active)', () => {
    const del = teamSrc.match(/export async function deleteTeamMember[\s\S]*?^}/m)
    assert.ok(del)
    assert.match(del[0], /DELETE FROM users/)
    assert.doesNotMatch(del[0], /is_active = false/)
  })
})

describe('setTeamMemberActive / updateTeamMember — comportement', () => {
  it('désactivation incrémente session_version', async () => {
    const before = users.get(STAFF_1).session_version
    const member = await setTeamMemberActive(
      PHARMACY_A,
      ADMIN_1,
      STAFF_1,
      false,
    )
    assert.equal(member.is_active, false)
    assert.equal(users.get(STAFF_1).session_version, before + 1)
  })

  it('réactivation sans incrément session_version', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, STAFF_1, false)
    const version = users.get(STAFF_1).session_version
    const member = await setTeamMemberActive(
      PHARMACY_A,
      ADMIN_1,
      STAFF_1,
      true,
    )
    assert.equal(member.is_active, true)
    assert.equal(users.get(STAFF_1).session_version, version)
  })

  it('impossibilité de se désactiver soi-même', async () => {
    await assert.rejects(
      () => setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_1, false),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 400)
        assert.match(err.message, /propre compte/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_1).is_active, true)
  })

  it('impossibilité de désactiver le dernier administrateur actif', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false)
    assert.equal(users.get(ADMIN_2).is_active, false)
    await assert.rejects(
      () => setTeamMemberActive(PHARMACY_A, STAFF_1, ADMIN_1, false),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 409)
        assert.match(err.message, /dernier administrateur actif/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_1).is_active, true)
  })

  it('deux administrateurs actifs : désactivation de l’un autorisée', async () => {
    const member = await setTeamMemberActive(
      PHARMACY_A,
      ADMIN_1,
      ADMIN_2,
      false,
    )
    assert.equal(member.is_active, false)
    assert.equal(users.get(ADMIN_1).is_active, true)
  })

  it('deux désactivations concurrentes ne laissent jamais 0 admin actif', async () => {
    const results = await Promise.allSettled([
      setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false),
      setTeamMemberActive(PHARMACY_A, ADMIN_2, ADMIN_1, false),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.status, 409)
    const activeAdmins = [...users.values()].filter(
      (u) =>
        u.pharmacy_id === PHARMACY_A && u.role === 'admin' && u.is_active,
    )
    assert.equal(activeAdmins.length, 1)
  })

  it('impossibilité de désactiver un administrateur plateforme (ADMIN_EMAIL)', async () => {
    process.env.ADMIN_EMAIL = 'admin2@a.local'
    await assert.rejects(
      () => setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        assert.match(err.message, /plateforme/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_2).is_active, true)
  })

  it('impossibilité de désactiver un administrateur plateforme (ADMIN_USER_ID)', async () => {
    process.env.ADMIN_USER_ID = ADMIN_2
    await assert.rejects(
      () => setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        return true
      },
    )
  })

  it('isolation pharmacie → 404', async () => {
    await assert.rejects(
      () =>
        setTeamMemberActive(PHARMACY_A, ADMIN_1, OTHER_PHARMA_USER, false),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 404)
        return true
      },
    )
    assert.equal(users.get(OTHER_PHARMA_USER).is_active, true)
  })

  it('combinaison nom + rôle + is_active via updateTeamMember', async () => {
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Renamed Staff',
      role: 'staff',
      is_active: false,
    })
    assert.equal(member.nom, 'Renamed Staff')
    assert.equal(member.is_active, false)
    assert.equal(users.get(STAFF_1).session_version, 1)
  })

  it('combinaison password + is_active bump session_version atomique (+2 raisons)', async () => {
    const before = users.get(STAFF_1).session_version
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      password: 'new-password-ok',
      is_active: false,
    })
    assert.equal(member.is_active, false)
    // password (+1) + désactivation (+1) dans la même statement
    assert.equal(users.get(STAFF_1).session_version, before + 2)
  })

  it('démotion admin→staff refusée si dernier administrateur actif (admin inactif ignoré)', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false)
    assert.equal(users.get(ADMIN_2).is_active, false)
    const before = { ...users.get(ADMIN_1) }
    await assert.rejects(
      () =>
        updateTeamMember(PHARMACY_A, STAFF_1, ADMIN_1, {
          role: 'staff',
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 409)
        assert.match(err.message, /dernier administrateur/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_1).role, before.role)
    assert.equal(users.get(ADMIN_1).is_active, true)
  })

  it('combinaison role=staff + is_active=false refusée atomiquement (aucun champ appliqué)', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, ADMIN_2, false)
    const before = { ...users.get(ADMIN_1) }
    await assert.rejects(
      () =>
        updateTeamMember(PHARMACY_A, STAFF_1, ADMIN_1, {
          nom: 'Should Not Apply',
          role: 'staff',
          is_active: false,
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 409)
        assert.match(err.message, /dernier administrateur actif/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_1).nom, before.nom)
    assert.equal(users.get(ADMIN_1).role, 'admin')
    assert.equal(users.get(ADMIN_1).is_active, true)
    assert.equal(users.get(ADMIN_1).session_version, before.session_version)
  })

  it('deux démotions de rôle concurrentes ne laissent jamais 0 admin actif', async () => {
    const results = await Promise.allSettled([
      updateTeamMember(PHARMACY_A, ADMIN_1, ADMIN_2, { role: 'staff' }),
      updateTeamMember(PHARMACY_A, ADMIN_2, ADMIN_1, { role: 'staff' }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.status, 409)
    const activeAdmins = [...users.values()].filter(
      (u) =>
        u.pharmacy_id === PHARMACY_A && u.role === 'admin' && u.is_active,
    )
    assert.equal(activeAdmins.length, 1)
  })

  it('updateTeamMember : impossibilité de se désactiver soi-même', async () => {
    await assert.rejects(
      () =>
        updateTeamMember(PHARMACY_A, ADMIN_1, ADMIN_1, {
          nom: 'Self',
          is_active: false,
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 400)
        assert.match(err.message, /propre compte/)
        return true
      },
    )
    assert.equal(users.get(ADMIN_1).is_active, true)
  })

  it('updateTeamMember : impossibilité de désactiver un admin plateforme', async () => {
    process.env.ADMIN_USER_ID = ADMIN_2
    await assert.rejects(
      () =>
        updateTeamMember(PHARMACY_A, ADMIN_1, ADMIN_2, {
          role: 'admin',
          is_active: false,
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        return true
      },
    )
    assert.equal(users.get(ADMIN_2).is_active, true)
  })

  it('suppression physique inchangée', async () => {
    await deleteTeamMember(PHARMACY_A, ADMIN_1, STAFF_1)
    assert.equal(users.has(STAFF_1), false)
  })

  it('updateTeamMember sans is_active : profil seul (régression)', async () => {
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Only Name',
    })
    assert.equal(member.nom, 'Only Name')
    assert.equal(member.is_active, true)
    assert.equal(users.get(STAFF_1).session_version, 0)
  })

  it('réactivation via updateTeamMember sans bump session_version', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, STAFF_1, false)
    const version = users.get(STAFF_1).session_version
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Back',
      is_active: true,
    })
    assert.equal(member.is_active, true)
    assert.equal(member.nom, 'Back')
    assert.equal(users.get(STAFF_1).session_version, version)
  })

  it('nom seul n’incrémente pas session_version (pas de transition de statut)', async () => {
    const before = users.get(STAFF_1).session_version
    await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, { nom: 'No Bump' })
    assert.equal(users.get(STAFF_1).session_version, before)
    assert.equal(users.get(STAFF_1).is_active, true)
    assert.equal(users.get(STAFF_1).role, 'staff')
  })

  it('désactivation effective via updateTeamMember incrémente session_version', async () => {
    const before = users.get(STAFF_1).session_version
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Off',
      is_active: false,
    })
    assert.equal(member.is_active, false)
    assert.equal(users.get(STAFF_1).session_version, before + 1)
  })

  it('is_active=false déjà inactif : pas d’incrément injustifié', async () => {
    await setTeamMemberActive(PHARMACY_A, ADMIN_1, STAFF_1, false)
    const version = users.get(STAFF_1).session_version
    const member = await updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Still Off',
      is_active: false,
    })
    assert.equal(member.is_active, false)
    assert.equal(member.nom, 'Still Off')
    assert.equal(users.get(STAFF_1).session_version, version)
  })

  it('deux MAJ concurrentes champs différents : pas de lost update nom/rôle', async () => {
    const results = await Promise.all([
      updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, { nom: 'Concurrent Name' }),
      updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, { role: 'admin' }),
    ])
    assert.equal(results.length, 2)
    assert.equal(users.get(STAFF_1).nom, 'Concurrent Name')
    assert.equal(users.get(STAFF_1).role, 'admin')
    assert.equal(users.get(STAFF_1).is_active, true)
  })

  it('MAJ nom ne réécrit pas un rôle changé concurremment (sérialisation FOR UPDATE)', async () => {
    // Interleave volontaire : B change le rôle entre le SELECT et l’UPDATE de A.
    // Le mock sérialise les statements ; A (nom) ne touche pas role.
    const pNom = updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      nom: 'Keep Role Intact',
    })
    const pRole = updateTeamMember(PHARMACY_A, ADMIN_1, STAFF_1, {
      role: 'admin',
    })
    await Promise.all([pNom, pRole])
    assert.equal(users.get(STAFF_1).nom, 'Keep Role Intact')
    assert.equal(users.get(STAFF_1).role, 'admin')
  })

  it('deux désactivations concurrentes d’admins via updateTeamMember', async () => {
    const results = await Promise.allSettled([
      updateTeamMember(PHARMACY_A, ADMIN_1, ADMIN_2, {
        nom: 'Admin Two',
        is_active: false,
      }),
      updateTeamMember(PHARMACY_A, ADMIN_2, ADMIN_1, {
        nom: 'Admin One',
        is_active: false,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.status, 409)
    const activeAdmins = [...users.values()].filter(
      (u) =>
        u.pharmacy_id === PHARMACY_A && u.role === 'admin' && u.is_active,
    )
    assert.equal(activeAdmins.length, 1)
  })

  it('updateTeamMember isolation pharmacie → 404', async () => {
    await assert.rejects(
      () =>
        updateTeamMember(PHARMACY_A, ADMIN_1, OTHER_PHARMA_USER, {
          nom: 'Hack',
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 404)
        return true
      },
    )
    assert.equal(users.get(OTHER_PHARMA_USER).nom, 'Other')
  })
})
