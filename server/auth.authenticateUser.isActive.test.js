/**
 * authenticateUser : is_active + pharmacie SUSPENDED (exemption plateforme).
 */
import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import bcrypt from 'bcryptjs'
import {
  AuthError,
  authenticateUser,
  parseDbIsActive,
  setLoginUserFinderForTests,
} from './auth.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PHARMACY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PASSWORD = 'correct-password-ok'

const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
}

/** @type {string} */
let passwordHash

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * @param {Partial<{
 *   id: string,
 *   email: string,
 *   password_hash: string,
 *   nom: string,
 *   role: string,
 *   pharmacy_id: string,
 *   session_version: number,
 *   is_active: unknown,
 *   pharmacy_status: string,
 * }>} [overrides]
 */
function loginRow(overrides = {}) {
  return {
    id: overrides.id ?? USER_ID,
    email: overrides.email ?? 'user@db.local',
    password_hash: overrides.password_hash ?? passwordHash,
    nom: overrides.nom ?? 'User',
    role: overrides.role ?? 'staff',
    pharmacy_id: overrides.pharmacy_id ?? PHARMACY_ID,
    session_version: overrides.session_version ?? 0,
    is_active: Object.prototype.hasOwnProperty.call(overrides, 'is_active')
      ? overrides.is_active
      : true,
    pharmacy_nom: 'Pharmacie Test',
    pharmacy_code_client: 'TEST',
    pharmacy_siret: '00000000000000',
    pharmacy_status: overrides.pharmacy_status ?? 'ACTIVE',
    pharmacy_trial_ends_at: null,
  }
}

before(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
  passwordHash = await bcrypt.hash(PASSWORD, 4)
})

after(() => {
  restoreEnv()
  setLoginUserFinderForTests(null)
})

beforeEach(() => {
  setLoginUserFinderForTests(null)
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_USER_ID
})

afterEach(() => {
  setLoginUserFinderForTests(null)
})

describe('parseDbIsActive', () => {
  it('n’accepte que les booléens stricts', () => {
    assert.equal(parseDbIsActive(true), true)
    assert.equal(parseDbIsActive(false), false)
    for (const bad of [undefined, null, 0, 1, 'true', 'false', 't', {}]) {
      assert.equal(parseDbIsActive(bad), null, String(bad))
    }
  })
})

describe('authenticateUser — is_active / SUSPENDED', () => {
  it('utilisateur actif, pharmacie ACTIVE → connexion acceptée', async () => {
    setLoginUserFinderForTests(async () =>
      loginRow({ is_active: true, pharmacy_status: 'ACTIVE' }),
    )
    const user = await authenticateUser('user@db.local', PASSWORD)
    assert.equal(user.id, USER_ID)
    assert.equal(user.pharmacy.status, 'ACTIVE')
  })

  it('mauvais mot de passe → Identifiants invalides (pas Compte désactivé)', async () => {
    let compared = false
    setLoginUserFinderForTests(async () => {
      compared = true
      return loginRow({ is_active: false })
    })
    await assert.rejects(
      () => authenticateUser('user@db.local', 'wrong-password'),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 401)
        assert.match(err.message, /Identifiants invalides/)
        assert.doesNotMatch(err.message, /désactivé|suspendu/i)
        return true
      },
    )
    assert.equal(compared, true)
  })

  it('utilisateur désactivé → 403 après vérification du mot de passe', async () => {
    setLoginUserFinderForTests(async () => loginRow({ is_active: false }))
    await assert.rejects(
      () => authenticateUser('user@db.local', PASSWORD),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        assert.match(err.message, /Compte désactivé/)
        return true
      },
    )
  })

  it('is_active invalide → 403 (fail-closed)', async () => {
    setLoginUserFinderForTests(async () => loginRow({ is_active: 'true' }))
    await assert.rejects(
      () => authenticateUser('user@db.local', PASSWORD),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        return true
      },
    )
  })

  it('utilisateur normal, pharmacie SUSPENDED → connexion refusée', async () => {
    setLoginUserFinderForTests(async () =>
      loginRow({ is_active: true, pharmacy_status: 'SUSPENDED' }),
    )
    await assert.rejects(
      () => authenticateUser('user@db.local', PASSWORD),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        assert.match(err.message, /suspendu/i)
        return true
      },
    )
  })

  it('administrateur plateforme (ADMIN_EMAIL), pharmacie SUSPENDED → autorisé', async () => {
    process.env.ADMIN_EMAIL = 'platform@db.local'
    setLoginUserFinderForTests(async () =>
      loginRow({
        email: 'platform@db.local',
        is_active: true,
        pharmacy_status: 'SUSPENDED',
      }),
    )
    const user = await authenticateUser('platform@db.local', PASSWORD)
    assert.equal(user.email, 'platform@db.local')
    assert.equal(user.pharmacy.status, 'SUSPENDED')
  })

  it('administrateur plateforme (ADMIN_USER_ID), pharmacie SUSPENDED → autorisé', async () => {
    process.env.ADMIN_USER_ID = USER_ID
    setLoginUserFinderForTests(async () =>
      loginRow({
        email: 'other@db.local',
        is_active: true,
        pharmacy_status: 'SUSPENDED',
      }),
    )
    const user = await authenticateUser('other@db.local', PASSWORD)
    assert.equal(user.id, USER_ID)
    assert.equal(user.pharmacy.status, 'SUSPENDED')
  })

  it('essai TRIAL non expiré : pas de refus supplémentaire (politique inchangée)', async () => {
    setLoginUserFinderForTests(async () =>
      loginRow({ is_active: true, pharmacy_status: 'TRIAL' }),
    )
    const user = await authenticateUser('user@db.local', PASSWORD)
    assert.equal(user.pharmacy.status, 'TRIAL')
  })

  it('contrat source : SELECT login inclut is_active ; MDP avant refus désactivation', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'auth.js'),
      'utf8',
    )
    const fnStart = src.indexOf('async function defaultFindLoginUserByEmail')
    const authStart = src.indexOf('export async function authenticateUser')
    const nextExport = src.indexOf('\nexport async function registerPharmacy')
    const loginSelect = src.slice(fnStart, authStart)
    const authBody = src.slice(authStart, nextExport)
    assert.match(loginSelect, /u\.is_active/)
    assert.match(loginSelect, /p\.status AS pharmacy_status/)
    const bcryptIdx = authBody.indexOf('bcrypt.compare')
    const inactiveIdx = authBody.indexOf("parseDbIsActive(user.is_active)")
    const suspendedIdx = authBody.indexOf("SUSPENDED")
    assert.ok(bcryptIdx > 0)
    assert.ok(inactiveIdx > bcryptIdx, 'is_active après bcrypt')
    assert.ok(suspendedIdx > bcryptIdx, 'SUSPENDED après bcrypt')
    assert.match(authBody, /isPlatformAdmin/)
  })
})
