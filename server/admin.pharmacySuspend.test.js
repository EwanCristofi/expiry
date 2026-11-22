/**
 * Lot D — suspension pharmacie : statut + session_version atomiques,
 * JWT invalidés, login / routes admin plateforme.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import bcrypt from 'bcryptjs'
import { Hono } from 'hono'
import {
  AuthError,
  authenticateUser,
  resolveAuthSession,
  setAuthUserFinderForTests,
  setLoginUserFinderForTests,
  signToken,
} from './auth.js'
import {
  normalizePharmacyStatus,
  setAdminSqlFactoryForTests,
  updatePharmacyStatus,
} from './admin.js'

const PHARMACY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PHARMACY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_A1 = '11111111-1111-4111-8111-111111111111'
const USER_A2 = '22222222-2222-4222-8222-222222222222'
const USER_PLATFORM = '33333333-3333-4333-8333-333333333333'
const USER_B1 = '44444444-4444-4444-8444-444444444444'

const PASSWORD = 'correct-password-ok'

const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  DATABASE_URL: process.env.DATABASE_URL,
}

const dir = dirname(fileURLToPath(import.meta.url))
const adminSrc = readFileSync(join(dir, 'admin.js'), 'utf8')
const appSrc = readFileSync(join(dir, 'app.js'), 'utf8')
const authSrc = readFileSync(join(dir, 'auth.js'), 'utf8')

/** @type {string} */
let passwordHash

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * @param {{
 *   id: string,
 *   nom?: string,
 *   code_client?: string,
 *   status?: string,
 *   created_at?: Date,
 *   trial_ends_at?: Date | null,
 * }} input
 */
function makePharmacy(input) {
  return {
    id: input.id,
    nom: input.nom ?? 'Pharmacie',
    code_client: input.code_client ?? 'CODE',
    status: input.status ?? 'ACTIVE',
    created_at: input.created_at ?? new Date('2024-01-01T00:00:00.000Z'),
    trial_ends_at: Object.prototype.hasOwnProperty.call(input, 'trial_ends_at')
      ? input.trial_ends_at
      : null,
  }
}

/**
 * @param {{
 *   id: string,
 *   email: string,
 *   pharmacy_id: string,
 *   role?: string,
 *   nom?: string,
 *   session_version?: number,
 *   is_active?: boolean,
 *   password_hash?: string,
 * }} input
 */
function makeUser(input) {
  return {
    id: input.id,
    email: input.email,
    pharmacy_id: input.pharmacy_id,
    role: input.role ?? 'staff',
    nom: input.nom ?? 'User',
    session_version: input.session_version ?? 0,
    is_active: input.is_active ?? true,
    password_hash: input.password_hash ?? passwordHash,
  }
}

/**
 * Mock Neon tagged-template : sérialise les requêtes (simule FOR UPDATE).
 * @param {Map<string, ReturnType<typeof makePharmacy>>} pharmacies
 * @param {Map<string, ReturnType<typeof makeUser>>} users
 * @param {{ failTimes?: number, failError?: Error }} [opts]
 */
function createLockingAdminSql(pharmacies, users, opts = {}) {
  let chain = Promise.resolve()
  let failRemaining = opts.failTimes ?? 0
  const failError =
    opts.failError ??
    Object.assign(new Error('deadlock detected'), { code: '40P01' })

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

    if (
      normalized.includes('WITH locked AS') &&
      normalized.includes('FOR UPDATE') &&
      normalized.includes('session_version = u.session_version + 1')
    ) {
      if (failRemaining > 0) {
        failRemaining -= 1
        throw failError
      }

      const pharmacyId = String(values[0])
      const nextStatus = String(values[1])
      const pharmacy = pharmacies.get(pharmacyId)
      if (!pharmacy) return []

      const previousStatus = pharmacy.status
      pharmacy.status = nextStatus

      const shouldBump =
        String(previousStatus || '')
          .trim()
          .toUpperCase() !== 'SUSPENDED' &&
        String(nextStatus || '')
          .trim()
          .toUpperCase() === 'SUSPENDED'

      if (shouldBump) {
        for (const user of users.values()) {
          if (user.pharmacy_id === pharmacyId) {
            user.session_version += 1
          }
        }
      }

      return [
        {
          id: pharmacy.id,
          nom: pharmacy.nom,
          code_client: pharmacy.code_client,
          status: pharmacy.status,
          created_at: pharmacy.created_at,
          trial_ends_at: pharmacy.trial_ends_at,
        },
      ]
    }

    throw new Error(`Mock SQL non géré : ${normalized.slice(0, 180)}`)
  }

  return sql
}

/** @type {Map<string, ReturnType<typeof makePharmacy>>} */
let pharmacies
/** @type {Map<string, ReturnType<typeof makeUser>>} */
let users

function seedStore() {
  pharmacies = new Map()
  users = new Map()

  for (const row of [
    makePharmacy({ id: PHARMACY_A, nom: 'Alpha', status: 'ACTIVE' }),
    makePharmacy({ id: PHARMACY_B, nom: 'Beta', status: 'ACTIVE' }),
  ]) {
    pharmacies.set(row.id, row)
  }

  for (const row of [
    makeUser({
      id: USER_A1,
      email: 'staff@a.local',
      pharmacy_id: PHARMACY_A,
      role: 'staff',
      session_version: 2,
    }),
    makeUser({
      id: USER_A2,
      email: 'admin@a.local',
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      session_version: 5,
    }),
    makeUser({
      id: USER_PLATFORM,
      email: 'platform@db.local',
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      session_version: 1,
    }),
    makeUser({
      id: USER_B1,
      email: 'staff@b.local',
      pharmacy_id: PHARMACY_B,
      role: 'staff',
      session_version: 7,
    }),
  ]) {
    users.set(row.id, row)
  }
}

/**
 * @param {ReturnType<typeof makeUser>} user
 * @param {ReturnType<typeof makePharmacy>} pharmacy
 */
function toLoginRow(user, pharmacy) {
  return {
    id: user.id,
    email: user.email,
    password_hash: user.password_hash,
    nom: user.nom,
    role: user.role,
    pharmacy_id: user.pharmacy_id,
    session_version: user.session_version,
    is_active: user.is_active,
    pharmacy_nom: pharmacy.nom,
    pharmacy_code_client: pharmacy.code_client,
    pharmacy_siret: '00000000000000',
    pharmacy_status: pharmacy.status,
    pharmacy_trial_ends_at: pharmacy.trial_ends_at,
  }
}

/**
 * @param {ReturnType<typeof makeUser>} user
 */
function toAuthUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    pharmacy_id: user.pharmacy_id,
    session_version: user.session_version,
    is_active: user.is_active,
  }
}

before(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
  // Évite createSql() accidentel hors mock.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/test'
  passwordHash = await bcrypt.hash(PASSWORD, 4)
})

beforeEach(() => {
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_USER_ID
  seedStore()
  setAdminSqlFactoryForTests(() => createLockingAdminSql(pharmacies, users))
  setLoginUserFinderForTests(null)
  setAuthUserFinderForTests(null)
})

afterEach(() => {
  setAdminSqlFactoryForTests(null)
  setLoginUserFinderForTests(null)
  setAuthUserFinderForTests(null)
})

after(() => {
  restoreEnv()
  setAdminSqlFactoryForTests(null)
  setLoginUserFinderForTests(null)
  setAuthUserFinderForTests(null)
})

describe('admin pharmacy suspend — contrats source', () => {
  it('updatePharmacyStatus : CTE FOR UPDATE + bump conditionnel atomique', () => {
    assert.match(adminSrc, /WITH locked AS/)
    assert.match(adminSrc, /FOR UPDATE/)
    assert.match(
      adminSrc,
      /session_version = u\.session_version \+ 1/,
    )
    assert.match(
      adminSrc,
      /IS DISTINCT FROM 'SUSPENDED'/,
    )
    assert.match(adminSrc, /upper\(trim\(upd\.status::text\)\) = 'SUSPENDED'/)
  })

  it('pas de double requête non transactionnelle pharmacies puis users', () => {
    const fnStart = adminSrc.indexOf(
      'async function updatePharmacyStatusAtomic',
    )
    assert.ok(fnStart >= 0)
    const brace = adminSrc.indexOf('{', fnStart)
    let depth = 0
    let end = brace
    for (; end < adminSrc.length; end += 1) {
      if (adminSrc[end] === '{') depth += 1
      else if (adminSrc[end] === '}') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    const body = adminSrc.slice(fnStart, end)
    assert.equal((body.match(/await sql`/g) || []).length, 1)
  })

  it('retry deadlock 40P01', () => {
    assert.match(adminSrc, /40P01/)
    assert.match(adminSrc, /isDeadlockError/)
    assert.match(adminSrc, /STATUS_UPDATE_MAX_ATTEMPTS/)
  })

  it('/api/admin/* : requireAuth + requirePlatformAdmin, sans requireActiveTrial', () => {
    assert.match(
      appSrc,
      /app\.get\(\s*'\/api\/admin\/dashboard',\s*requireAuth,\s*requirePlatformAdmin/,
    )
    assert.match(
      appSrc,
      /app\.patch\(\s*'\/api\/admin\/pharmacies\/:id\/status',\s*requireAuth,\s*requirePlatformAdmin/,
    )
    const dashIdx = appSrc.indexOf("'/api/admin/dashboard'")
    const statusIdx = appSrc.indexOf("'/api/admin/pharmacies/:id/status'")
    const productsIdx = appSrc.indexOf("'/api/products/resolve'")
    assert.ok(dashIdx >= 0 && statusIdx > dashIdx && productsIdx > statusIdx)
    const adminSection = appSrc.slice(dashIdx, productsIdx)
    assert.doesNotMatch(adminSection, /requireActiveTrial/)
  })

  it('resolveAuthSession ne consulte pas pharmacies.status', () => {
    const fnStart = authSrc.indexOf('export async function resolveAuthSession')
    assert.ok(fnStart >= 0)
    const brace = authSrc.indexOf('{', fnStart)
    let depth = 0
    let end = brace
    for (; end < authSrc.length; end += 1) {
      if (authSrc[end] === '{') depth += 1
      else if (authSrc[end] === '}') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    const body = authSrc.slice(fnStart, end)
    assert.doesNotMatch(body, /pharmacy_status|pharmacies\.status|SUSPENDED/)
  })

  it('isPlatformAdmin inchangé (ADMIN_EMAIL / ADMIN_USER_ID uniquement)', () => {
    const platformSrc = readFileSync(join(dir, 'platformAdmin.js'), 'utf8')
    assert.match(platformSrc, /ADMIN_EMAIL/)
    assert.match(platformSrc, /ADMIN_USER_ID/)
    assert.doesNotMatch(platformSrc, /role\s*===|SUSPENDED|is_active/)
  })
})

describe('updatePharmacyStatus — suspension / réactivation', () => {
  it('ACTIVE → SUSPENDED : statut + bump session_version pour tous ses users', async () => {
    const beforeA1 = users.get(USER_A1).session_version
    const beforeA2 = users.get(USER_A2).session_version
    const beforePlatform = users.get(USER_PLATFORM).session_version
    const beforeB = users.get(USER_B1).session_version

    const result = await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(result.status, 'SUSPENDED')
    assert.equal(pharmacies.get(PHARMACY_A).status, 'SUSPENDED')
    assert.equal(users.get(USER_A1).session_version, beforeA1 + 1)
    assert.equal(users.get(USER_A2).session_version, beforeA2 + 1)
    assert.equal(users.get(USER_PLATFORM).session_version, beforePlatform + 1)
    assert.equal(users.get(USER_B1).session_version, beforeB)
  })

  it('TRIAL → SUSPENDED : même résultat', async () => {
    pharmacies.get(PHARMACY_A).status = 'TRIAL'
    const before = users.get(USER_A1).session_version
    const result = await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(result.status, 'SUSPENDED')
    assert.equal(users.get(USER_A1).session_version, before + 1)
  })

  it('SUSPENDED → SUSPENDED : aucun nouvel incrément', async () => {
    pharmacies.get(PHARMACY_A).status = 'SUSPENDED'
    const versions = {
      a1: users.get(USER_A1).session_version,
      a2: users.get(USER_A2).session_version,
      platform: users.get(USER_PLATFORM).session_version,
    }
    const result = await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(result.status, 'SUSPENDED')
    assert.equal(users.get(USER_A1).session_version, versions.a1)
    assert.equal(users.get(USER_A2).session_version, versions.a2)
    assert.equal(users.get(USER_PLATFORM).session_version, versions.platform)
  })

  it('SUSPENDED → ACTIVE : statut modifié, aucun incrément', async () => {
    pharmacies.get(PHARMACY_A).status = 'SUSPENDED'
    const before = users.get(USER_A1).session_version
    const result = await updatePharmacyStatus(PHARMACY_A, 'ACTIVE')
    assert.equal(result.status, 'ACTIVE')
    assert.equal(pharmacies.get(PHARMACY_A).status, 'ACTIVE')
    assert.equal(users.get(USER_A1).session_version, before)
  })

  it('ACTIVE → ACTIVE : comportement historique (statut inchangé, pas de bump)', async () => {
    const before = users.get(USER_A1).session_version
    const result = await updatePharmacyStatus(PHARMACY_A, 'ACTIVE')
    assert.equal(result.status, 'ACTIVE')
    assert.equal(users.get(USER_A1).session_version, before)
  })

  it('TRIAL → ACTIVE : pas de bump (comportement historique)', async () => {
    pharmacies.get(PHARMACY_A).status = 'TRIAL'
    const before = users.get(USER_A1).session_version
    const result = await updatePharmacyStatus(PHARMACY_A, 'ACTIVE')
    assert.equal(result.status, 'ACTIVE')
    assert.equal(normalizePharmacyStatus(pharmacies.get(PHARMACY_A).status), 'ACTIVE')
    assert.equal(users.get(USER_A1).session_version, before)
  })

  it('users d’une autre pharmacie : versions inchangées', async () => {
    const beforeB = users.get(USER_B1).session_version
    await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(users.get(USER_B1).session_version, beforeB)
    assert.equal(pharmacies.get(PHARMACY_B).status, 'ACTIVE')
  })

  it('pharmacie introuvable → Error 404-compatible', async () => {
    await assert.rejects(
      () =>
        updatePharmacyStatus('99999999-9999-4999-8999-999999999999', 'SUSPENDED'),
      (err) => {
        assert.match(String(err.message), /introuvable/i)
        return true
      },
    )
  })

  it('statut TRIAL rejeté (inchangé)', async () => {
    await assert.rejects(
      () => updatePharmacyStatus(PHARMACY_A, /** @type {any} */ ('TRIAL')),
      /Statut invalide/,
    )
    assert.equal(pharmacies.get(PHARMACY_A).status, 'ACTIVE')
  })

  it('deux suspensions concurrentes : une seule vague de bumps', async () => {
    const before = users.get(USER_A1).session_version
    const [r1, r2] = await Promise.all([
      updatePharmacyStatus(PHARMACY_A, 'SUSPENDED'),
      updatePharmacyStatus(PHARMACY_A, 'SUSPENDED'),
    ])
    assert.equal(r1.status, 'SUSPENDED')
    assert.equal(r2.status, 'SUSPENDED')
    assert.equal(users.get(USER_A1).session_version, before + 1)
  })

  it('deadlock 40P01 : retry puis succès', async () => {
    // Une seule instance : le compteur failTimes survit aux retries getSql().
    const mockSql = createLockingAdminSql(pharmacies, users, { failTimes: 1 })
    setAdminSqlFactoryForTests(() => mockSql)
    const before = users.get(USER_A1).session_version
    const result = await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(result.status, 'SUSPENDED')
    assert.equal(users.get(USER_A1).session_version, before + 1)
  })

  it('deadlock persistant → erreur propre', async () => {
    const mockSql = createLockingAdminSql(pharmacies, users, { failTimes: 10 })
    setAdminSqlFactoryForTests(() => mockSql)
    await assert.rejects(
      () => updatePharmacyStatus(PHARMACY_A, 'SUSPENDED'),
      /deadlock/i,
    )
    // Aucune écriture partielle dans le mock (throw avant mutation).
    assert.equal(pharmacies.get(PHARMACY_A).status, 'ACTIVE')
  })
})

describe('suspension → JWT / login / admin', () => {
  it('ancien JWT invalidé après suspension (resolveAuthSession)', async () => {
    const user = users.get(USER_A1)
    const oldToken = await signToken({
      id: user.id,
      email: user.email,
      role: user.role,
      pharmacy_id: user.pharmacy_id,
      session_version: user.session_version,
    })
    setAuthUserFinderForTests(async (id) => {
      const row = users.get(id)
      return row ? toAuthUser(row) : null
    })
    assert.ok(await resolveAuthSession(oldToken))

    await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    assert.equal(await resolveAuthSession(oldToken), null)

    const fresh = await signToken({
      id: user.id,
      email: user.email,
      role: user.role,
      pharmacy_id: user.pharmacy_id,
      session_version: users.get(USER_A1).session_version,
    })
    // Compte toujours actif côté users ; seul le login métier refuse SUSPENDED.
    assert.ok(await resolveAuthSession(fresh))
  })

  it('connexion refusée aux utilisateurs ordinaires pendant la suspension', async () => {
    await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    setLoginUserFinderForTests(async (email) => {
      const user = [...users.values()].find((u) => u.email === email)
      if (!user) return null
      return toLoginRow(user, pharmacies.get(user.pharmacy_id))
    })
    await assert.rejects(
      () => authenticateUser('staff@a.local', PASSWORD),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 403)
        assert.match(err.message, /suspendu/i)
        return true
      },
    )
  })

  it('connexion autorisée à l’administrateur plateforme (pharmacie suspendue)', async () => {
    process.env.ADMIN_EMAIL = 'platform@db.local'
    await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')
    setLoginUserFinderForTests(async (email) => {
      const user = [...users.values()].find((u) => u.email === email)
      if (!user) return null
      return toLoginRow(user, pharmacies.get(user.pharmacy_id))
    })
    const user = await authenticateUser('platform@db.local', PASSWORD)
    assert.equal(user.email, 'platform@db.local')
    assert.equal(user.pharmacy.status, 'SUSPENDED')
    assert.equal(
      user.session_version,
      users.get(USER_PLATFORM).session_version,
    )
  })

  it('admin plateforme : accès /api/admin après reconnexion, réactivation sans bump', async () => {
    process.env.ADMIN_USER_ID = USER_PLATFORM
    const platform = users.get(USER_PLATFORM)
    const oldToken = await signToken({
      id: platform.id,
      email: platform.email,
      role: platform.role,
      pharmacy_id: platform.pharmacy_id,
      session_version: platform.session_version,
    })

    await updatePharmacyStatus(PHARMACY_A, 'SUSPENDED')

    setAuthUserFinderForTests(async (id) => {
      const row = users.get(id)
      return row ? toAuthUser(row) : null
    })
    assert.equal(await resolveAuthSession(oldToken), null)

    const freshToken = await signToken({
      id: platform.id,
      email: platform.email,
      role: platform.role,
      pharmacy_id: platform.pharmacy_id,
      session_version: users.get(USER_PLATFORM).session_version,
    })
    assert.ok(await resolveAuthSession(freshToken))

    const { requireAuth, requirePlatformAdmin } = await import(
      `./app.js?pharmacySuspend=${Date.now()}`
    )
    const h = new Hono()
    h.get('/api/admin/dashboard', requireAuth, requirePlatformAdmin, (c) =>
      c.json({ ok: true }),
    )
    h.patch(
      '/api/admin/pharmacies/:id/status',
      requireAuth,
      requirePlatformAdmin,
      async (c) => {
        const body = await c.req.json()
        const pharmacy = await updatePharmacyStatus(
          c.req.param('id'),
          body?.status,
        )
        return c.json({ pharmacy })
      },
    )

    const dash = await h.request('http://localhost/api/admin/dashboard', {
      headers: { Authorization: `Bearer ${freshToken}` },
    })
    assert.equal(dash.status, 200)

    const versionBeforeReactivate = users.get(USER_A1).session_version
    const patch = await h.request(
      `http://localhost/api/admin/pharmacies/${PHARMACY_A}/status`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ACTIVE' }),
      },
    )
    assert.equal(patch.status, 200)
    const body = await patch.json()
    assert.equal(body.pharmacy.status, 'ACTIVE')
    assert.equal(pharmacies.get(PHARMACY_A).status, 'ACTIVE')
    assert.equal(users.get(USER_A1).session_version, versionBeforeReactivate)
  })

  it('getAdminDashboard / normalizePharmacyStatus inchangés (pas de régression API)', () => {
    assert.match(adminSrc, /export async function getAdminDashboard/)
    assert.match(adminSrc, /export function normalizePharmacyStatus/)
    assert.match(adminSrc, /pharmacies_active_7d/)
    assert.equal(normalizePharmacyStatus('trial'), 'TRIAL')
    assert.equal(normalizePharmacyStatus('active'), 'ACTIVE')
    assert.equal(normalizePharmacyStatus('suspended'), 'SUSPENDED')
  })
})
