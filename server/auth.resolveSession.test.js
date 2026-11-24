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
 * @param {Partial<{
 *   id: string,
 *   pharmacy_id: string,
 *   role: string,
 *   email: string,
 *   session_version: number,
 * }>} user
 */
async function signJwt(user = {}) {
  return signToken({
    id: user.id ?? USER_ID,
    pharmacy_id: user.pharmacy_id ?? PHARMACY_A,
    role: user.role ?? 'admin',
    email: user.email ?? 'old@jwt.local',
    session_version: user.session_version ?? 0,
  })
}

/**
 * JWT legacy sans claim session_version (pré-migration).
 * @param {Partial<{ pharmacy_id: string, role: string, email: string }>} [claims]
 */
async function signLegacyJwt(claims = {}) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET)
  return new SignJWT({
    pharmacy_id: claims.pharmacy_id ?? PHARMACY_A,
    role: claims.role ?? 'admin',
    email: claims.email ?? 'old@jwt.local',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)
}

/**
 * @param {Partial<{
 *   id: string,
 *   email: string,
 *   role: string,
 *   pharmacy_id: string,
 *   session_version: number,
 *   is_active: unknown,
 * }>} [overrides]
 */
function dbUser(overrides = {}) {
  return {
    id: overrides.id ?? USER_ID,
    email: overrides.email ?? 'user@db.local',
    role: overrides.role ?? 'staff',
    pharmacy_id: overrides.pharmacy_id ?? PHARMACY_A,
    session_version: overrides.session_version ?? 0,
    is_active: Object.prototype.hasOwnProperty.call(overrides, 'is_active')
      ? overrides.is_active
      : true,
  }
}

describe('resolveAuthSession (unité)', () => {
  it('JWT admin + DB staff → session.role = staff (claims JWT ignorés)', async () => {
    setAuthUserFinderForTests(async (id) => {
      assert.equal(id, USER_ID)
      return dbUser({ role: 'staff', pharmacy_id: PHARMACY_A })
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
    setAuthUserFinderForTests(async () =>
      dbUser({ role: 'admin', pharmacy_id: PHARMACY_B }),
    )
    const token = await signJwt({ pharmacy_id: PHARMACY_A })
    const session = await resolveAuthSession(token)
    assert.equal(session?.pharmacyId, PHARMACY_B)
    assert.notEqual(session?.pharmacyId, PHARMACY_A)
  })

  it('erreur SQL → erreur interne 500, aucun fallback JWT', async () => {
    setAuthUserFinderForTests(async () => {
      throw new Error('neon connection refused')
    })
    const token = await signJwt({ role: 'admin', pharmacy_id: PHARMACY_A })
    await assert.rejects(
      () => resolveAuthSession(token),
      (err) => {
        assert.equal(err.status, 500)
        assert.equal(err.expose, false)
        assert.match(String(err.cause?.message || ''), /neon connection refused/i)
        assert.doesNotMatch(String(err.message), /neon connection refused/i)
        return true
      },
    )
  })

  it('JWT invalide → null sans accès DB', async () => {
    let dbCalls = 0
    setAuthUserFinderForTests(async () => {
      dbCalls += 1
      return dbUser({ role: 'admin' })
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
      session_version: 0,
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
    setAuthUserFinderForTests(async () =>
      dbUser({ email: 'new@db.local', role: 'admin' }),
    )
    const token = await signJwt({ email: 'old@jwt.local' })
    const session = await resolveAuthSession(token)
    assert.equal(session?.email, 'new@db.local')
  })

  it('recherche users uniquement par sub (pas le pharmacy_id JWT)', async () => {
    /** @type {string[]} */
    const seenIds = []
    setAuthUserFinderForTests(async (id) => {
      seenIds.push(id)
      return dbUser({ role: 'staff', pharmacy_id: PHARMACY_B })
    })
    const token = await signJwt({ pharmacy_id: PHARMACY_A })
    await resolveAuthSession(token)
    assert.deepEqual(seenIds, [USER_ID])
    assert.equal(seenIds.includes(PHARMACY_A), false)
  })
})

describe('resolveAuthSession — session_version', () => {
  it('signToken sans session_version → AuthError 500 (fail-closed)', async () => {
    await assert.rejects(
      () =>
        signToken({
          id: USER_ID,
          pharmacy_id: PHARMACY_A,
          role: 'admin',
          email: 'user@db.local',
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 500)
        assert.match(err.message, /session_version/i)
        return true
      },
    )
  })

  it('signToken avec session_version invalide → AuthError 500', async () => {
    for (const bad of [undefined, null, -1, 1.5, '0', true]) {
      await assert.rejects(
        () =>
          signToken({
            id: USER_ID,
            pharmacy_id: PHARMACY_A,
            role: 'admin',
            email: 'user@db.local',
            session_version: /** @type {any} */ (bad),
          }),
        (err) => {
          assert.ok(err instanceof AuthError)
          assert.equal(err.status, 500)
          return true
        },
        `session_version=${String(bad)}`,
      )
    }
  })

  it('1. JWT version 0 + DB version 0 → accepté', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 0 }))
    const token = await signJwt({ session_version: 0 })
    const session = await resolveAuthSession(token)
    assert.ok(session)
    assert.equal(session.userId, USER_ID)
  })

  it('2. JWT sans claim + DB version 0 → accepté (legacy)', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 0 }))
    const token = await signLegacyJwt()
    const claims = await verifyToken(token)
    assert.equal(claims?.sessionVersion, 0)
    const session = await resolveAuthSession(token)
    assert.ok(session)
  })

  it('3. JWT sans claim + DB version 1 → refusé', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 1 }))
    const token = await signLegacyJwt()
    assert.equal(await resolveAuthSession(token), null)
  })

  it('4. JWT version 1 + DB version 2 → refusé', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 2 }))
    const token = await signJwt({ session_version: 1 })
    assert.equal(await resolveAuthSession(token), null)
  })

  it('5. JWT version 1 + DB version 1 → accepté', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 1 }))
    const token = await signJwt({ session_version: 1 })
    const session = await resolveAuthSession(token)
    assert.ok(session)
  })

  it('6. claim JWT invalide → refusé', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 0 }))
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    for (const bad of ['0', -1, 1.5, true, {}]) {
      const token = await new SignJWT({
        pharmacy_id: PHARMACY_A,
        role: 'admin',
        email: 'x@y.z',
        session_version: bad,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(USER_ID)
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(secret)
      assert.equal(await verifyToken(token), null, `claim=${JSON.stringify(bad)}`)
      assert.equal(await resolveAuthSession(token), null)
    }
  })

  it('7. version DB absente ou invalide → refusée', async () => {
    const token = await signJwt({ session_version: 0 })
    for (const bad of [undefined, null, -1, 1.5, '0', true]) {
      setAuthUserFinderForTests(async () => ({
        id: USER_ID,
        email: 'user@db.local',
        role: 'staff',
        pharmacy_id: PHARMACY_A,
        session_version: /** @type {any} */ (bad),
        is_active: true,
      }))
      assert.equal(
        await resolveAuthSession(token),
        null,
        `dbVersion=${String(bad)}`,
      )
    }
  })

  it('12. nouveau login après révocation → nouvelle session acceptée', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 1 }))
    const stale = await signJwt({ session_version: 0 })
    assert.equal(await resolveAuthSession(stale), null)
    const fresh = await signJwt({ session_version: 1 })
    assert.ok(await resolveAuthSession(fresh))
  })

  it('13. régression : rôle et pharmacie lus depuis la DB', async () => {
    setAuthUserFinderForTests(async () =>
      dbUser({
        role: 'staff',
        pharmacy_id: PHARMACY_B,
        email: 'db@local',
        session_version: 3,
      }),
    )
    const token = await signJwt({
      role: 'admin',
      pharmacy_id: PHARMACY_A,
      email: 'jwt@local',
      session_version: 3,
    })
    const session = await resolveAuthSession(token)
    assert.deepEqual(session, {
      userId: USER_ID,
      pharmacyId: PHARMACY_B,
      role: 'staff',
      email: 'db@local',
    })
  })

  it('14. utilisateur supprimé → session refusée', async () => {
    setAuthUserFinderForTests(async () => null)
    const token = await signJwt({ session_version: 5 })
    assert.equal(await resolveAuthSession(token), null)
  })
})

describe('resolveAuthSession — is_active', () => {
  it('is_active=true → session acceptée', async () => {
    setAuthUserFinderForTests(async () => dbUser({ is_active: true }))
    const token = await signJwt({ session_version: 0 })
    const session = await resolveAuthSession(token)
    assert.ok(session)
    assert.equal(session.userId, USER_ID)
  })

  it('is_active=false → session refusée', async () => {
    setAuthUserFinderForTests(async () => dbUser({ is_active: false }))
    const token = await signJwt({ session_version: 0 })
    assert.equal(await resolveAuthSession(token), null)
  })

  it('is_active absent ou invalide → session refusée (fail-closed)', async () => {
    const token = await signJwt({ session_version: 0 })
    for (const bad of [undefined, null, 0, 1, 'true', 'false', 't', {}]) {
      setAuthUserFinderForTests(async () => dbUser({ is_active: bad }))
      assert.equal(
        await resolveAuthSession(token),
        null,
        `is_active=${JSON.stringify(bad)}`,
      )
    }
  })

  it('is_active=false prime sur session_version match', async () => {
    setAuthUserFinderForTests(async () =>
      dbUser({ is_active: false, session_version: 2 }),
    )
    const token = await signJwt({ session_version: 2 })
    assert.equal(await resolveAuthSession(token), null)
  })

  it('contrat source : resolveAuthSession ne lit pas pharmacies.status', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'auth.js'),
      'utf8',
    )
    const fnStart = src.indexOf('export async function resolveAuthSession')
    assert.ok(fnStart >= 0)
    const brace = src.indexOf('{', fnStart)
    let depth = 0
    let end = brace
    for (; end < src.length; end += 1) {
      if (src[end] === '{') depth += 1
      else if (src[end] === '}') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    const body = src.slice(fnStart, end)
    assert.match(body, /parseDbIsActive/)
    assert.doesNotMatch(body, /pharmacy_status|pharmacies\.status|SUSPENDED/)
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
    setAuthUserFinderForTests(async () =>
      dbUser({ role: 'staff', pharmacy_id: PHARMACY_A }),
    )
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
    const me = await app.request('http://localhost/api/auth/me', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(me.status, 401)
  })

  it('3. JWT pharmacy A + DB pharmacy B → auth.pharmacyId = B', async () => {
    setAuthUserFinderForTests(async () =>
      dbUser({ role: 'staff', pharmacy_id: PHARMACY_B }),
    )
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
    // Frontière HTTP : message technique jamais exposé.
    assert.equal(body.error, 'Erreur serveur')
    assert.doesNotMatch(String(body.error || ''), /db down/i)
  })

  it('5. JWT expiré → 401 sans appel DB', async () => {
    let dbCalls = 0
    setAuthUserFinderForTests(async () => {
      dbCalls += 1
      return dbUser({ role: 'admin' })
    })
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const expired = await new SignJWT({
      pharmacy_id: PHARMACY_A,
      role: 'admin',
      email: 'old@jwt.local',
      session_version: 0,
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
    setAuthUserFinderForTests(async () =>
      dbUser({ email: 'new@db.local', role: 'staff' }),
    )
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
    setAuthUserFinderForTests(async () =>
      dbUser({
        email: 'cookie@db.local',
        role: 'admin',
        pharmacy_id: PHARMACY_B,
      }),
    )
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
    setAuthUserFinderForTests(async () =>
      dbUser({
        email: 'bearer@db.local',
        role: 'staff',
        pharmacy_id: PHARMACY_B,
      }),
    )
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
    setAuthUserFinderForTests(async () => dbUser({ role: 'admin' }))
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

  it('session_version mismatch → requireAuth 401', async () => {
    setAuthUserFinderForTests(async () => dbUser({ session_version: 2 }))
    const token = await signJwt({ session_version: 1 })
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 401)
  })

  it('is_active=false → requireAuth 401', async () => {
    setAuthUserFinderForTests(async () => dbUser({ is_active: false }))
    const token = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 401)
  })

  it('admin plateforme : route /platform-probe accessible (is_active=true)', async () => {
    process.env.ADMIN_USER_ID = USER_ID
    setAuthUserFinderForTests(async () =>
      dbUser({ email: 'platform@db.local', role: 'staff', is_active: true }),
    )
    const token = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/platform-probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 200)
  })

  it('admin plateforme désactivé → 401 même sur route plateforme', async () => {
    process.env.ADMIN_USER_ID = USER_ID
    setAuthUserFinderForTests(async () =>
      dbUser({ email: 'platform@db.local', is_active: false }),
    )
    const token = await signJwt()
    const h = createHarness()
    const res = await h.request('http://localhost/platform-probe', {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    })
    assert.equal(res.status, 401)
  })

  it('contrat source : /api/admin/* sans requireActiveTrial', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'app.js'),
      'utf8',
    )
    assert.match(
      src,
      /app\.get\(\s*'\/api\/admin\/dashboard',\s*requireAuth,\s*requirePlatformAdmin/,
    )
    assert.match(
      src,
      /app\.patch\(\s*'\/api\/admin\/pharmacies\/:id\/status',\s*requireAuth,\s*requirePlatformAdmin/,
    )
    assert.match(src, /async function requireActiveTrial/)
    assert.match(src, /pharmacy\.suspended/)
  })
})
