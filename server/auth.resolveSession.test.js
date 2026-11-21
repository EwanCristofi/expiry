/**
 * Auth : JWT crypto + relecture DB (resolveAuthSession / requireAuth).
 * Vérifie que les claims JWT obsolètes ne font plus autorité.
 */
import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import {
  AuthError,
  TOKEN_COOKIE,
  resolveAuthSession,
  setAuthUserFinderForTests,
  signToken,
  verifyToken,
} from './auth.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PHARMACY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PHARMACY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

before(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
})

after(() => {
  restoreEnv()
  setAuthUserFinderForTests(null)
})

beforeEach(() => {
  setAuthUserFinderForTests(null)
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_USER_ID
})

afterEach(() => {
  setAuthUserFinderForTests(null)
})

/**
 * @param {Partial<{ id: string, pharmacy_id: string, role: string, email: string }>} user
 */
async function signJwt(user = {}) {
  return signToken({
    id: user.id ?? USER_ID,
    pharmacy_id: user.pharmacy_id ?? PHARMACY_A,
    role: user.role ?? 'admin',
    email: user.email ?? 'old@jwt.local',
  })
}

describe('resolveAuthSession (unité)', () => {
  it('JWT admin + DB staff → session.role = staff (claims JWT ignorés)', async () => {
    setAuthUserFinderForTests(async (id) => {
      assert.equal(id, USER_ID)
      return {
        id: USER_ID,
        email: 'user@db.local',
        role: 'staff',
        pharmacy_id: PHARMACY_A,
      }
    })
    const token = await signJwt({ role: 'admin' })
    const session = await resolveAuthSession(token)
    assert.deepEqual(session, {
      userId: USER_ID,
      pharmacyId: PHARMACY_A,
      role: 'staff',
      email: 'user@db.local',
    })
  })

  it('JWT valide + utilisateur absent → null (→ 401 côté requireAuth)', async () => {
    setAuthUserFinderForTests(async () => null)
    const token = await signJwt()
    const session = await resolveAuthSession(token)
    assert.equal(session, null)
  })

  it('JWT pharmacy A + DB pharmacy B → session.pharmacyId = B', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'user@db.local',
      role: 'admin',
      pharmacy_id: PHARMACY_B,
    }))
    const token = await signJwt({ pharmacy_id: PHARMACY_A })
    const session = await resolveAuthSession(token)
    assert.equal(session?.pharmacyId, PHARMACY_B)
    assert.notEqual(session?.pharmacyId, PHARMACY_A)
  })

  it('erreur SQL → AuthError 500, aucun fallback JWT', async () => {
    setAuthUserFinderForTests(async () => {
      throw new Error('neon connection refused')
    })
    const token = await signJwt({ role: 'admin', pharmacy_id: PHARMACY_A })
    await assert.rejects(
      () => resolveAuthSession(token),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 500)
        assert.match(err.message, /neon connection refused/i)
        return true
      },
    )
  })

  it('JWT invalide → null sans accès DB', async () => {
    let dbCalls = 0
    setAuthUserFinderForTests(async () => {
      dbCalls += 1
      return {
        id: USER_ID,
        email: 'x@y.z',
        role: 'admin',
        pharmacy_id: PHARMACY_A,
      }
    })
    const session = await resolveAuthSession('not-a-jwt')
    assert.equal(session, null)
    assert.equal(dbCalls, 0)
  })

  it('JWT expiré → null sans accès DB', async () => {
    let dbCalls = 0
    setAuthUserFinderForTests(async () => {
      dbCalls += 1
      throw new Error('DB ne doit pas être appelée')
    })
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const expired = await new SignJWT({
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      email: 'old@jwt.local',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret)

    assert.equal(await verifyToken(expired), null)
    assert.equal(await resolveAuthSession(expired), null)
    assert.equal(dbCalls, 0)
  })

  it('ancien email JWT + nouvel email DB → session.email = email DB', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'new@db.local',
      role: 'admin',
      pharmacy_id: PHARMACY_A,
    }))
    const token = await signJwt({ email: 'old@jwt.local' })
    const session = await resolveAuthSession(token)
    assert.equal(session?.email, 'new@db.local')
  })

  it('recherche users uniquement par sub (pas le pharmacy_id JWT)', async () => {
    /** @type {string[]} */
    const seenIds = []
    setAuthUserFinderForTests(async (id) => {
      seenIds.push(id)
      return {
        id: USER_ID,
        email: 'user@db.local',
        role: 'staff',
        pharmacy_id: PHARMACY_B,
      }
    })
    const token = await signJwt({ pharmacy_id: PHARMACY_A })
    await resolveAuthSession(token)
    assert.deepEqual(seenIds, [USER_ID])
    assert.equal(seenIds.includes(PHARMACY_A), false)
  })
})

describe('requireAuth → resolveAuthSession (HTTP réel)', () => {
  /** @type {import('hono').Hono} */
  let app
  /** @type {typeof import('./app.js').requireAuth} */
  let requireAuth
  /** @type {typeof import('./app.js').requireAdmin} */
  let requireAdmin
  /** @type {typeof import('./app.js').requirePlatformAdmin} */
  let requirePlatformAdmin
  /** @type {typeof import('./app.js').isPlatformAdmin} */
  let isPlatformAdmin

  before(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
    const mod = await import(`./app.js?resolveSession=${Date.now()}`)
    app = mod.default
    requireAuth = mod.requireAuth
    requireAdmin = mod.requireAdmin
    requirePlatformAdmin = mod.requirePlatformAdmin
    isPlatformAdmin = mod.isPlatformAdmin
  })

  /**
   * Harness monté avec les vrais middlewares exportés par app.js.
   */
  function createHarness() {
    const h = new Hono()
    h.get('/probe', requireAuth, (c) => c.json({ auth: c.get('auth') }))
    h.get('/admin-probe', requireAuth, requireAdmin, (c) =>
      c.json({ ok: true, auth: c.get('auth') }),
    )
    h.get('/platform-probe', requireAuth, requirePlatformAdmin, (c) =>
      c.json({ ok: true, auth: c.get('auth') }),
    )
    return h
  }

  it('contrat source : requireAuth appelle resolveAuthSession', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(dir, 'app.js'), 'utf8')
    assert.match(src, /await resolveAuthSession\(/)
    assert.equal(typeof requireAuth, 'function')
    assert.equal(typeof resolveAuthSession, 'function')
  })

  it('1. JWT admin + DB staff → requireAdmin refuse (403)', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'user@db.local',
      role: 'staff',
      pharmacy_id: PHARMACY_A,
    }))
    const token = await signJwt({ role: 'admin' })
    const h = createHarness()
    const res = await h.request('http://localhost/admin-probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 403)
  })

  it('2. JWT valide + utilisateur supprimé → 401', async () => {
    setAuthUserFinderForTests(async () => null)
    const token = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 401)
    // Même branchement sur l’app réelle (/api/auth/me).
    const me = await app.request('http://localhost/api/auth/me', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(me.status, 401)
  })

  it('3. JWT pharmacy A + DB pharmacy B → auth.pharmacyId = B', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'user@db.local',
      role: 'staff',
      pharmacy_id: PHARMACY_B,
    }))
    const token = await signJwt({ pharmacy_id: PHARMACY_A, role: 'admin' })
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.auth.pharmacyId, PHARMACY_B)
    assert.equal(body.auth.role, 'staff')
  })

  it('4. erreur SQL → 500, aucune authentification', async () => {
    setAuthUserFinderForTests(async () => {
      throw new Error('db down')
    })
    const token = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal('auth' in body, false)
    assert.match(String(body.error || ''), /db down/i)
  })

  it('5. JWT expiré → 401 sans appel DB', async () => {
    let dbCalls = 0
    setAuthUserFinderForTests(async () => {
      dbCalls += 1
      return {
        id: USER_ID,
        email: 'x@y.z',
        role: 'admin',
        pharmacy_id: PHARMACY_A,
      }
    })
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const expired = await new SignJWT({
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      email: 'old@jwt.local',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret)

    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${expired}` },
    })
    assert.equal(res.status, 401)
    assert.equal(dbCalls, 0)
  })

  it('6. ancien email JWT + email DB → platform admin via email DB', async () => {
    process.env.ADMIN_EMAIL = 'new@db.local'
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'new@db.local',
      role: 'staff',
      pharmacy_id: PHARMACY_A,
    }))
    const token = await signJwt({ email: 'old@jwt.local', role: 'staff' })
    const session = await resolveAuthSession(token)
    assert.ok(session)
    assert.equal(session.email, 'new@db.local')
    assert.equal(isPlatformAdmin(session), true)
    assert.equal(
      isPlatformAdmin({ userId: USER_ID, email: 'old@jwt.local' }),
      false,
    )

    const h = createHarness()
    const res = await h.request('http://localhost/platform-probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.auth.email, 'new@db.local')
  })

  it('7. cookie HttpOnly valide → auth avec données DB', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'cookie@db.local',
      role: 'admin',
      pharmacy_id: PHARMACY_B,
    }))
    const token = await signJwt({
      role: 'staff',
      pharmacy_id: PHARMACY_A,
      email: 'stale@jwt.local',
    })
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.auth, {
      userId: USER_ID,
      pharmacyId: PHARMACY_B,
      role: 'admin',
      email: 'cookie@db.local',
    })
  })

  it('8. Bearer valide sans cookie → accepté avec relecture DB', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'bearer@db.local',
      role: 'staff',
      pharmacy_id: PHARMACY_B,
    }))
    const token = await signJwt({ role: 'admin', pharmacy_id: PHARMACY_A })
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.auth.role, 'staff')
    assert.equal(body.auth.pharmacyId, PHARMACY_B)
    assert.equal(body.auth.email, 'bearer@db.local')
  })

  it('cookie invalide + Bearer valide → 401 (pas de bascule, inchangé)', async () => {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'x@y.z',
      role: 'admin',
      pharmacy_id: PHARMACY_A,
    }))
    const bearer = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: {
        Cookie: `${TOKEN_COOKIE}=not-a-valid-jwt`,
        Authorization: `Bearer ${bearer}`,
      },
    })
    assert.equal(res.status, 401)
  })
})
