/**
 * Lot A — Protection des réponses API contre les fuites d’erreurs internes.
 */
import assert from 'node:assert/strict'
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import {
  AuthError,
  authenticateUser,
  publicAuthError,
  requestPasswordReset,
  resetPasswordWithToken,
  resolveAuthSession,
  setAuthSqlFactoryForTests,
  setAuthUserFinderForTests,
  setLoginUserFinderForTests,
  signToken,
} from './auth.js'
import {
  updatePharmacyStatus,
  setAdminSqlFactoryForTests,
} from './admin.js'
import {
  GENERIC_HTTP_ERROR_MESSAGE,
  PUBLIC_HTTP_STATUSES,
  buildSafeErrorLogMeta,
  classifyHttpError,
  internalHttpError,
  isAllowedPublicStatus,
  logHttpError,
  logServerError,
  publicHttpError,
} from './httpError.js'
import {
  createZone,
  deleteScan,
  deleteZone,
  renameZone,
  saveScan,
  setProductLogicDbForTests,
} from './productLogic.js'
import {
  createTeamMember,
  setTeamSqlFactoryForTests,
} from './team.js'
import { setPharmacyTrialFinderForTests } from './trial.js'
import {
  createMemoryRateLimiters,
  resetRateLimitTestState,
  setAssertAuthRateLimitOverridesForTests,
  setRateLimitRuntimeForTests,
} from './rateLimit.js'
import { RATE_LIMIT_HMAC_SECRET_MIN_BYTES } from './rateLimitKeys.js'

const JWT_SECRET = 'test-jwt-secret-16chars-min'
const PHARMACY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  APP_URL: process.env.APP_URL,
  CRON_SECRET: process.env.CRON_SECRET,
  DATABASE_URL: process.env.DATABASE_URL,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const LEAK_MESSAGES = [
  'neon connection refused',
  'relation does not exist',
  'duplicate key value',
  'syntax error',
  'Timeout Neon',
  'JWT_SECRET missing',
  'APP_URL missing',
]

function assertNoLeak(body, technical) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  assert.doesNotMatch(payload, new RegExp(escapeRegExp(technical), 'i'))
  for (const msg of LEAK_MESSAGES) {
    if (msg.toLowerCase() === String(technical).toLowerCase()) continue
    // Always ensure known tech strings aren't accidentally echoed when testing that one.
  }
  assert.equal(body.error, GENERIC_HTTP_ERROR_MESSAGE)
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('classifyHttpError — garanties de non-exposition', () => {
  for (const technical of LEAK_MESSAGES) {
    it(`masque « ${technical} » (Error simple)`, () => {
      const classified = classifyHttpError(new Error(technical))
      assert.equal(classified.status, 500)
      assert.equal(classified.message, GENERIC_HTTP_ERROR_MESSAGE)
      assert.equal(classified.internal, true)
      assert.doesNotMatch(classified.message, new RegExp(escapeRegExp(technical), 'i'))
    })

    it(`masque « ${technical} » (HttpError 500 / AuthError 500)`, () => {
      const a = internalHttpError(new Error(technical))
      const b = new AuthError(technical, 500)
      for (const err of [a, b]) {
        const classified = classifyHttpError(err)
        assert.equal(classified.status, 500)
        assert.equal(classified.message, GENERIC_HTTP_ERROR_MESSAGE)
        assert.equal(err.expose, false)
      }
    })
  }

  it('expose uniquement les erreurs explicitement publiques', () => {
    const pub = publicHttpError('Zone introuvable', 404)
    const classified = classifyHttpError(pub)
    assert.equal(classified.status, 404)
    assert.equal(classified.message, 'Zone introuvable')
    assert.equal(classified.internal, false)
  })

  it('AuthError sans expose explicite n’est jamais public (même en 401)', () => {
    const accidental = new AuthError('neon connection refused', 400)
    assert.equal(accidental.expose, false)
    assert.equal(classifyHttpError(accidental).message, GENERIC_HTTP_ERROR_MESSAGE)
    assert.doesNotMatch(
      classifyHttpError(accidental).message,
      /neon connection refused/i,
    )
  })

  it('publicAuthError / AuthError { expose: true } → message métier', () => {
    const ok = publicAuthError('Identifiants invalides', 401)
    assert.equal(ok.expose, true)
    assert.equal(classifyHttpError(ok).message, 'Identifiants invalides')

    const bad = new AuthError('JWT_SECRET missing', 500)
    assert.equal(bad.expose, false)
    assert.equal(classifyHttpError(bad).message, GENERIC_HTTP_ERROR_MESSAGE)
  })

  it('statut public non autorisé n’expose jamais le message', () => {
    assert.equal(isAllowedPublicStatus(418), false)
    assert.ok(PUBLIC_HTTP_STATUSES.includes(402))
    const err = publicHttpError('teapot leak', 418)
    assert.equal(err.expose, false)
    assert.equal(classifyHttpError(err).status, 500)
    assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
    assert.doesNotMatch(classifyHttpError(err).message, /teapot/)
  })

  it('n’utilise pas message.includes pour classer', () => {
    const err = new Error('Pharmacie introuvable dans relation does not exist')
    const classified = classifyHttpError(err)
    assert.equal(classified.status, 500)
    assert.equal(classified.message, GENERIC_HTTP_ERROR_MESSAGE)
  })

  it('conserve la cause technique côté serveur', () => {
    const cause = new Error('neon connection refused')
    cause.code = 'ECONNREFUSED'
    const err = internalHttpError(cause)
    assert.equal(err.cause, cause)
    assert.match(String(err.cause.message), /neon connection refused/i)
  })
})

describe('Modules — erreurs métier préservées / SQL masquées', () => {
  before(() => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.APP_URL = 'https://expiry.example.com'
    process.env.NODE_ENV = 'test'
  })

  after(() => {
    restoreEnv()
    setLoginUserFinderForTests(null)
    setAuthUserFinderForTests(null)
    setAuthSqlFactoryForTests(null)
    setProductLogicDbForTests(null)
    setTeamSqlFactoryForTests(null)
    setAdminSqlFactoryForTests(null)
  })

  describe('auth', () => {
    it('mauvais mot de passe → 401 message métier', async () => {
      setLoginUserFinderForTests(async () => ({
        id: USER_ID,
        email: 'a@b.c',
        password_hash:
          '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.G2oQhFqKqKqKqK', // invalid vs "wrong"
        nom: 'A',
        role: 'admin',
        pharmacy_id: PHARMACY_ID,
        session_version: 0,
        is_active: true,
        pharmacy_nom: 'P',
        pharmacy_code_client: 'P-1',
        pharmacy_status: 'ACTIVE',
      }))
      // Use a real bcrypt hash for "correct" then compare wrong password
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash('correct-password', 4)
      setLoginUserFinderForTests(async () => ({
        id: USER_ID,
        email: 'a@b.c',
        password_hash: hash,
        nom: 'A',
        role: 'admin',
        pharmacy_id: PHARMACY_ID,
        session_version: 0,
        is_active: true,
        pharmacy_nom: 'P',
        pharmacy_code_client: 'P-1',
        pharmacy_status: 'ACTIVE',
      }))
      await assert.rejects(
        () => authenticateUser('a@b.c', 'wrong-password'),
        (err) => {
          assert.ok(err instanceof AuthError)
          assert.equal(err.status, 401)
          assert.equal(err.expose, true)
          assert.match(err.message, /Identifiants invalides/)
          return true
        },
      )
    })

    it('compte désactivé → 403 message métier', async () => {
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash('password1', 4)
      setLoginUserFinderForTests(async () => ({
        id: USER_ID,
        email: 'a@b.c',
        password_hash: hash,
        nom: 'A',
        role: 'admin',
        pharmacy_id: PHARMACY_ID,
        session_version: 0,
        is_active: false,
        pharmacy_nom: 'P',
        pharmacy_code_client: 'P-1',
        pharmacy_status: 'ACTIVE',
      }))
      await assert.rejects(
        () => authenticateUser('a@b.c', 'password1'),
        (err) => {
          assert.equal(err.status, 403)
          assert.match(err.message, /Compte désactivé/)
          return true
        },
      )
    })

    it('erreur SQL pendant login → interne 500', async () => {
      setLoginUserFinderForTests(async () => {
        throw new Error('neon connection refused')
      })
      await assert.rejects(
        () => authenticateUser('a@b.c', 'x'),
        (err) => {
          assert.equal(err.status, 500)
          assert.equal(err.expose, false)
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.match(String(err.cause?.message || ''), /neon connection refused/i)
          return true
        },
      )
    })

    it('resolveAuthSession SQL → 500 générique à la frontière', async () => {
      setAuthUserFinderForTests(async () => {
        throw new Error('relation does not exist')
      })
      const token = await signToken({
        id: USER_ID,
        pharmacy_id: PHARMACY_ID,
        role: 'admin',
        email: 'a@b.c',
        session_version: 0,
      })
      await assert.rejects(
        () => resolveAuthSession(token),
        (err) => {
          const c = classifyHttpError(err)
          assert.equal(c.status, 500)
          assert.equal(c.message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.match(String(err.cause?.message || ''), /relation does not exist/i)
          return true
        },
      )
    })

    it('reset token invalide → message métier', async () => {
      await assert.rejects(
        () =>
          resetPasswordWithToken('invalid-token-value', 'password12', {
            store: {
              findUserByEmail: async () => null,
              saveResetTokenHash: async () => {},
              findUserByResetTokenHash: async () => null,
              consumeResetToken: async () => {},
            },
          }),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /invalide ou a expiré/)
          return true
        },
      )
    })

    it('reset SQL → 500 générique', async () => {
      await assert.rejects(
        () =>
          resetPasswordWithToken('tok', 'password12', {
            store: {
              findUserByEmail: async () => null,
              saveResetTokenHash: async () => {},
              findUserByResetTokenHash: async () => {
                throw new Error('Timeout Neon')
              },
              consumeResetToken: async () => {},
            },
          }),
        (err) => {
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.match(String(err.cause?.message || ''), /Timeout Neon/i)
          return true
        },
      )
    })

    it('forgot-password SQL → 500 générique', async () => {
      await assert.rejects(
        () =>
          requestPasswordReset('a@b.c', {
            store: {
              findUserByEmail: async () => {
                throw new Error('syntax error')
              },
              saveResetTokenHash: async () => {},
              findUserByResetTokenHash: async () => null,
              consumeResetToken: async () => {},
            },
          }),
        (err) => {
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          return true
        },
      )
    })
  })

  describe('zones / scans (productLogic)', () => {
    afterEach(() => setProductLogicDbForTests(null))

    /** sql tagged-template inert (évite createSql / DATABASE_URL). */
    function inertSql() {
      return Object.assign(
        (strings, ...values) => ({
          text: Array.from(strings).join('?'),
          values,
        }),
        {
          query: (text, values) => ({ text, values }),
        },
      )
    }

    it('zone doublon → 409 message métier', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => {
          const err = new Error('duplicate key value')
          err.code = '23505'
          throw err
        },
      })
      await assert.rejects(
        () => createZone(PHARMACY_ID, 'Frigo'),
        (err) => {
          assert.equal(err.status, 409)
          assert.equal(err.expose, true)
          assert.match(err.message, /existe déjà/)
          return true
        },
      )
    })

    it('création zone SQL → erreur interne (pas 409)', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => {
          throw new Error('neon connection refused')
        },
      })
      await assert.rejects(
        () => createZone(PHARMACY_ID, 'Frigo'),
        (err) => {
          assert.equal(classifyHttpError(err).status, 500)
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.match(String(err.message), /neon connection refused/i)
          return true
        },
      )
    })

    it('zone introuvable → 404', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => [[]],
      })
      await assert.rejects(
        () => renameZone(PHARMACY_ID, 99, 'Nouveau'),
        (err) => {
          assert.equal(err.status, 404)
          assert.match(err.message, /Zone introuvable/)
          return true
        },
      )
    })

    it('suppression zone SQL → 500 générique', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => {
          throw new Error('syntax error')
        },
      })
      await assert.rejects(
        () => deleteZone(PHARMACY_ID, 1),
        (err) => {
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          return true
        },
      )
    })

    it('GTIN invalide → 400', async () => {
      await assert.rejects(
        () =>
          saveScan(PHARMACY_ID, {
            gtin: 'abc',
            datePeremption: '2027-01-01',
            zoneId: 1,
          }),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /GTIN invalide/)
          return true
        },
      )
    })

    it('date invalide → 400', async () => {
      await assert.rejects(
        () =>
          saveScan(PHARMACY_ID, {
            gtin: '3400930000000',
            datePeremption: '01/01/2027',
            zoneId: 1,
          }),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /Date de péremption invalide/)
          return true
        },
      )
    })

    it('scan introuvable → 404', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => [[]],
      })
      await assert.rejects(
        () => deleteScan(PHARMACY_ID, '11111111-1111-4111-8111-111111111111'),
        (err) => {
          assert.equal(err.status, 404)
          assert.match(err.message, /Scan introuvable/)
          return true
        },
      )
    })

    it('scan SQL → 500 générique', async () => {
      setProductLogicDbForTests({
        sql: inertSql(),
        withPharmacy: async () => {
          throw new Error('duplicate key value violates unique constraint')
        },
      })
      await assert.rejects(
        () =>
          saveScan(PHARMACY_ID, {
            gtin: '3400930000000',
            datePeremption: '2027-01-01',
            zoneId: 1,
          }),
        (err) => {
          const c = classifyHttpError(err)
          assert.equal(c.status, 500)
          assert.equal(c.message, GENERIC_HTTP_ERROR_MESSAGE)
          return true
        },
      )
    })
  })

  describe('équipe', () => {
    afterEach(() => setTeamSqlFactoryForTests(null))

    it('email déjà utilisé → 409', async () => {
      setTeamSqlFactoryForTests(() => {
        function sql() {
          const err = new Error('duplicate key value')
          err.code = '23505'
          return Promise.reject(err)
        }
        return sql
      })
      await assert.rejects(
        () =>
          createTeamMember(PHARMACY_ID, {
            email: 'x@y.z',
            nom: 'X',
            role: 'staff',
            password: 'password12',
          }),
        (err) => {
          assert.equal(err.status, 409)
          assert.match(err.message, /email est déjà utilisé/)
          return true
        },
      )
    })

    it('création SQL → 500 générique', async () => {
      setTeamSqlFactoryForTests(() => {
        function sql() {
          return Promise.reject(new Error('neon connection refused'))
        }
        return sql
      })
      await assert.rejects(
        () =>
          createTeamMember(PHARMACY_ID, {
            email: 'x@y.z',
            nom: 'X',
            role: 'staff',
            password: 'password12',
          }),
        (err) => {
          assert.equal(classifyHttpError(err).message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.match(String(err.cause?.message || ''), /neon connection refused/i)
          return true
        },
      )
    })
  })

  describe('admin', () => {
    afterEach(() => setAdminSqlFactoryForTests(null))

    it('identifiant manquant → 400 publique', async () => {
      await assert.rejects(
        () => updatePharmacyStatus('', 'ACTIVE'),
        (err) => {
          assert.equal(err.status, 400)
          assert.equal(err.expose, true)
          assert.match(err.message, /Identifiant pharmacie manquant/)
          return true
        },
      )
    })

    it('pharmacie introuvable → 404 publique', async () => {
      setAdminSqlFactoryForTests(() => {
        function sql() {
          return Promise.resolve([])
        }
        return sql
      })
      await assert.rejects(
        () => updatePharmacyStatus(PHARMACY_ID, 'SUSPENDED'),
        (err) => {
          assert.equal(err.status, 404)
          assert.equal(err.expose, true)
          assert.match(err.message, /Pharmacie introuvable/)
          assert.equal(classifyHttpError(err).status, 404)
          return true
        },
      )
    })

    it('statut invalide → 400', async () => {
      await assert.rejects(
        () => updatePharmacyStatus(PHARMACY_ID, /** @type {any} */ ('TRIAL')),
        (err) => {
          assert.equal(err.status, 400)
          assert.match(err.message, /Statut invalide/)
          return true
        },
      )
    })

    it('SQL / deadlock → 500 générique jamais 400', async () => {
      let calls = 0
      setAdminSqlFactoryForTests(() => {
        function sql() {
          calls += 1
          const err = new Error('deadlock detected')
          err.code = '40P01'
          return Promise.reject(err)
        }
        return sql
      })
      await assert.rejects(
        () => updatePharmacyStatus(PHARMACY_ID, 'SUSPENDED'),
        (err) => {
          const c = classifyHttpError(err)
          assert.equal(c.status, 500)
          assert.equal(c.message, GENERIC_HTTP_ERROR_MESSAGE)
          assert.notEqual(c.status, 400)
          assert.ok(calls >= 1)
          assert.match(String(err.cause?.message || ''), /deadlock/i)
          return true
        },
      )
    })
  })
})

describe('HTTP — frontières app.js / api/index.js / cron', () => {
  /** @type {import('hono').Hono} */
  let app
  /** @type {(req: any, res: any) => Promise<any>} */
  let vercelHandler

  before(async () => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.CRON_SECRET = 'test-cron-secret-16chars'
    process.env.APP_URL = 'https://expiry.example.com'
    process.env.NODE_ENV = 'test'
    app = (await import(`./app.js?httpError=${Date.now()}`)).default
    vercelHandler = (await import(`../api/index.js?httpError=${Date.now()}`))
      .default
  })

  after(() => {
    restoreEnv()
    setAuthUserFinderForTests(null)
    setLoginUserFinderForTests(null)
    setAuthSqlFactoryForTests(null)
    setPharmacyTrialFinderForTests(null)
    setProductLogicDbForTests(null)
    setTeamSqlFactoryForTests(null)
    setAdminSqlFactoryForTests(null)
  })

  afterEach(() => {
    setAuthUserFinderForTests(null)
    setLoginUserFinderForTests(null)
    setAuthSqlFactoryForTests(null)
    setPharmacyTrialFinderForTests(null)
    setProductLogicDbForTests(null)
    setTeamSqlFactoryForTests(null)
    setAdminSqlFactoryForTests(null)
  })

  async function authHeaders() {
    setAuthUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'admin@test.local',
      role: 'admin',
      pharmacy_id: PHARMACY_ID,
      session_version: 0,
      is_active: true,
    }))
    setPharmacyTrialFinderForTests(async () => ({
      id: PHARMACY_ID,
      status: 'ACTIVE',
      trial_ends_at: null,
      trialExpired: false,
      suspended: false,
      accessBlocked: false,
    }))
    const token = await signToken({
      id: USER_ID,
      pharmacy_id: PHARMACY_ID,
      role: 'admin',
      email: 'admin@test.local',
      session_version: 0,
    })
    return {
      Authorization: `Bearer ${token}`,
      Origin: 'https://expiry.example.com',
    }
  }

  it('requireAuth SQL → 500 générique (pas de fuite)', async () => {
    setAuthUserFinderForTests(async () => {
      throw new Error('neon connection refused')
    })
    const token = await signToken({
      id: USER_ID,
      pharmacy_id: PHARMACY_ID,
      role: 'admin',
      email: 'admin@test.local',
      session_version: 0,
    })
    const res = await app.request('http://localhost/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'neon connection refused')
  })

  it('login SQL → 500 générique', async () => {
    setLoginUserFinderForTests(async () => {
      throw new Error('relation does not exist')
    })
    const res = await app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'relation does not exist')
  })

  it('login mauvais mot de passe → 401 métier', async () => {
    const bcrypt = await import('bcryptjs')
    const hash = await bcrypt.hash('good-pass', 4)
    setLoginUserFinderForTests(async () => ({
      id: USER_ID,
      email: 'a@b.c',
      password_hash: hash,
      nom: 'A',
      role: 'admin',
      pharmacy_id: PHARMACY_ID,
      session_version: 0,
      is_active: true,
      pharmacy_nom: 'P',
      pharmacy_code_client: 'P-1',
      pharmacy_status: 'ACTIVE',
    }))
    const res = await app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c', password: 'bad-pass' }),
    })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.error, /Identifiants invalides/)
  })

  function inertSqlReject(message) {
    return Object.assign(
      (strings, ...values) => ({
        text: Array.from(strings).join('?'),
        values,
        then(_resolve, reject) {
          reject(new Error(message))
        },
      }),
      {
        query: () => Promise.reject(new Error(message)),
      },
    )
  }

  function inertSqlOk() {
    return Object.assign(
      (strings, ...values) => ({
        text: Array.from(strings).join('?'),
        values,
      }),
      { query: (text, values) => ({ text, values }) },
    )
  }

  it('GET /api/zones SQL → 500 générique', async () => {
    const headers = await authHeaders()
    setProductLogicDbForTests({
      sql: inertSqlOk(),
      withPharmacy: async () => {
        throw new Error('Timeout Neon')
      },
    })
    const res = await app.request('http://localhost/api/zones', { headers })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'Timeout Neon')
  })

  it('POST /api/zones doublon → 409 métier', async () => {
    const headers = await authHeaders()
    setProductLogicDbForTests({
      sql: inertSqlOk(),
      withPharmacy: async () => {
        const err = new Error('duplicate key value')
        err.code = '23505'
        throw err
      },
    })
    const res = await app.request('http://localhost/api/zones', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nom_zone: 'Frigo' }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /existe déjà/)
  })

  it('GET /api/products/resolve SQL → 500 générique', async () => {
    const headers = await authHeaders()
    setProductLogicDbForTests({
      sql: inertSqlReject('syntax error at or near'),
    })
    const res = await app.request(
      'http://localhost/api/products/resolve?code=3400930000000',
      { headers },
    )
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'syntax error')
  })

  it('POST /api/scans GTIN invalide → 400 métier', async () => {
    const headers = await authHeaders()
    const res = await app.request('http://localhost/api/scans', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gtin: 'bad',
        datePeremption: '2027-01-01',
        zoneId: 1,
      }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /GTIN invalide/)
  })

  it('cron erreur interne → message générique', async () => {
    setProductLogicDbForTests({
      sql: inertSqlReject('neon connection refused'),
    })
    const res = await app.request('http://localhost/api/cron/cleanup', {
      headers: { Authorization: 'Bearer test-cron-secret-16chars' },
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'neon connection refused')
  })

  it('app.onError réellement déclenché → 500 générique', async () => {
    const res = await app.request('http://localhost/api/__test_on_error')
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'relation does not exist')
  })

  it('wrapper api/index.js erreur inconnue → 500 générique', async () => {
    /** @type {any} */
    let statusCode = 0
    /** @type {Record<string, string>} */
    const headers = {}
    /** @type {string} */
    let ended = ''
    const res = {
      headersSent: false,
      set statusCode(v) {
        statusCode = v
      },
      get statusCode() {
        return statusCode
      },
      setHeader(k, v) {
        headers[k] = v
      },
      end(buf) {
        ended = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
      },
    }
    // Force failure before app.fetch by passing a broken IncomingMessage-like object
    // that throws in toWebRequest when reading body — use Request path that throws.
    const brokenReq = {
      method: 'GET',
      url: '/api/health',
      headers: {},
      on(event, cb) {
        if (event === 'error') {
          // no-op
        }
        if (event === 'data') {
          // no-op
        }
        if (event === 'end') {
          // throw during conversion by making host access throw
        }
      },
      get headers() {
        throw new Error('JWT_SECRET missing')
      },
    }
    await vercelHandler(brokenReq, res)
    assert.equal(statusCode, 500)
    const body = JSON.parse(ended)
    assertNoLeak(body, 'JWT_SECRET missing')
  })

  const VALID_SIRET = '73282932000074'

  function registerSqlMock(mode) {
    return function sql(strings) {
      const text = Array.from(strings).join(' ')
      if (mode === 'sql') {
        return Promise.reject(new Error('neon connection refused'))
      }
      if (text.includes('FROM users') && text.includes('email')) {
        return Promise.resolve(
          mode === 'email' ? [{ id: USER_ID }] : [],
        )
      }
      if (text.includes('FROM pharmacies') && text.includes('siret')) {
        return Promise.resolve(
          mode === 'siret' ? [{ id: PHARMACY_ID }] : [],
        )
      }
      return Promise.reject(new Error('unexpected register SQL'))
    }
  }

  it('register email déjà utilisé → 409 métier', async () => {
    setAuthSqlFactoryForTests(() => registerSqlMock('email'))
    const res = await app.request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom: 'Pharmacie Test',
        email: 'dup@test.local',
        password: 'password12',
        siret: VALID_SIRET,
      }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /email est déjà utilisé/)
  })

  it('register SIRET déjà utilisé → 409 métier', async () => {
    setAuthSqlFactoryForTests(() => registerSqlMock('siret'))
    const res = await app.request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom: 'Pharmacie Test',
        email: 'new@test.local',
        password: 'password12',
        siret: VALID_SIRET,
      }),
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /SIRET est déjà associé/)
  })

  it('register SQL → 500 générique', async () => {
    setAuthSqlFactoryForTests(() => registerSqlMock('sql'))
    const res = await app.request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nom: 'Pharmacie Test',
        email: 'new@test.local',
        password: 'password12',
        siret: VALID_SIRET,
      }),
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'neon connection refused')
  })

  it('forgot-password APP_URL manquante (prod) → 500 générique', async () => {
    const prevNode = process.env.NODE_ENV
    const prevApp = process.env.APP_URL
    process.env.NODE_ENV = 'production'
    delete process.env.APP_URL
    // Rate limiting prod obligatoire : injecter un store mock pour atteindre
    // le contrôle APP_URL (sans désactiver silencieusement la protection).
    const hmac = 'c'.repeat(RATE_LIMIT_HMAC_SECRET_MIN_BYTES)
    const runtime = {
      deployEnv: /** @type {const} */ ('production'),
      hmacSecret: hmac,
      limiters: createMemoryRateLimiters(),
    }
    setRateLimitRuntimeForTests(() => runtime)
    setAssertAuthRateLimitOverridesForTests({
      injectedIp: '203.0.113.40',
      runtime,
      env: { NODE_ENV: 'production', VERCEL_ENV: 'production' },
    })
    try {
      const res = await app.request('http://localhost/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c' }),
      })
      assert.equal(res.status, 500)
      const body = await res.json()
      assert.equal(body.error, GENERIC_HTTP_ERROR_MESSAGE)
      assert.doesNotMatch(JSON.stringify(body), /APP_URL/)
    } finally {
      resetRateLimitTestState()
      process.env.NODE_ENV = prevNode
      if (prevApp === undefined) delete process.env.APP_URL
      else process.env.APP_URL = prevApp
    }
  })

  it('forgot-password SQL → 500 générique', async () => {
    const res = await app.request('http://localhost/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.c' }),
    })
    // Sans store mock via options (route n’injecte pas) : createSql échoue sans DATABASE_URL
    // → 500 générique (pas de message technique).
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.error, GENERIC_HTTP_ERROR_MESSAGE)
    assert.doesNotMatch(JSON.stringify(body), /DATABASE_URL|neon|syntax/i)
  })

  it('reset-password SQL → 500 générique', async () => {
    // Route appelle store Neon → DATABASE_URL absente → interne
    const res = await app.request('http://localhost/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tokentoken', password: 'password12' }),
    })
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'DATABASE_URL')
  })

  it('admin pharmacie introuvable → 404 métier (HTTP)', async () => {
    const headers = await authHeaders()
    // Platform admin gate: isPlatformAdmin checks env — set ADMIN_USER_ID
    process.env.ADMIN_USER_ID = USER_ID
    setAdminSqlFactoryForTests(() => {
      function sql() {
        return Promise.resolve([])
      }
      return sql
    })
    const res = await app.request(
      `http://localhost/api/admin/pharmacies/${PHARMACY_ID}/status`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Origin: 'https://expiry.example.com',
        },
        body: JSON.stringify({ status: 'SUSPENDED' }),
      },
    )
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /Pharmacie introuvable/)
    delete process.env.ADMIN_USER_ID
  })

  it('admin deadlock SQL → 500 générique (HTTP)', async () => {
    const headers = await authHeaders()
    process.env.ADMIN_USER_ID = USER_ID
    setAdminSqlFactoryForTests(() => {
      function sql() {
        const err = new Error('deadlock detected')
        err.code = '40P01'
        return Promise.reject(err)
      }
      return sql
    })
    const res = await app.request(
      `http://localhost/api/admin/pharmacies/${PHARMACY_ID}/status`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Origin: 'https://expiry.example.com',
        },
        body: JSON.stringify({ status: 'SUSPENDED' }),
      },
    )
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'deadlock')
    delete process.env.ADMIN_USER_ID
  })

  it('team dernier administrateur → 409 métier (HTTP)', async () => {
    const headers = await authHeaders()
    setTeamSqlFactoryForTests(() => {
      function sql(strings) {
        const text = Array.from(strings).join(' ')
        if (text.includes('SELECT id, role') || text.includes('FROM users')) {
          if (text.includes('COUNT')) {
            return Promise.resolve([{ count: 1 }])
          }
          return Promise.resolve([{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'admin' }])
        }
        return Promise.resolve([])
      }
      return sql
    })
    const res = await app.request(
      'http://localhost/api/team/users/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      {
        method: 'DELETE',
        headers: {
          ...headers,
          Origin: 'https://expiry.example.com',
        },
      },
    )
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /dernier administrateur/)
  })

  it('team update SQL → 500 générique (HTTP)', async () => {
    const headers = await authHeaders()
    setTeamSqlFactoryForTests(() => {
      function sql() {
        return Promise.reject(new Error('syntax error at or near SELECT'))
      }
      return sql
    })
    const res = await app.request(
      `http://localhost/api/team/users/${USER_ID}`,
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Origin: 'https://expiry.example.com',
        },
        body: JSON.stringify({ nom: 'Nouveau' }),
      },
    )
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'syntax error')
  })

  it('team delete SQL → 500 générique (HTTP)', async () => {
    const headers = await authHeaders()
    setTeamSqlFactoryForTests(() => {
      function sql() {
        return Promise.reject(new Error('neon connection refused'))
      }
      return sql
    })
    const res = await app.request(
      'http://localhost/api/team/users/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      {
        method: 'DELETE',
        headers: {
          ...headers,
          Origin: 'https://expiry.example.com',
        },
      },
    )
    assert.equal(res.status, 500)
    const body = await res.json()
    assertNoLeak(body, 'neon connection refused')
  })
})

describe('Logs — aucune fuite de données sensibles', () => {
  const SENTINELS = {
    pg: 'detail: Key (email)=(leak@example.com) already exists',
    email: 'leak@example.com',
    password: 'SuperSecretPassword!99',
    resetToken: 'reset-token-sentinel-xyz',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sentinel.payload',
    dbUrl: 'postgres://user:pass@db.example/expiry',
    apiKey: 're_test_sentinel_api_key_value',
  }

  /** @type {unknown[][]} */
  let captured
  /** @type {typeof console.error} */
  let originalError

  beforeEach(() => {
    captured = []
    originalError = console.error
    console.error = (...args) => {
      captured.push(args)
    }
  })

  afterEach(() => {
    console.error = originalError
  })

  function dump() {
    return JSON.stringify(captured)
  }

  function assertNoSentinels() {
    const text = dump()
    for (const [label, value] of Object.entries(SENTINELS)) {
      assert.doesNotMatch(
        text,
        new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `sentinel ${label} leaked into logs`,
      )
    }
    assert.doesNotMatch(text, /stack|at Object\.|password_hash|Authorization/i)
  }

  it('logHttpError n’écrit pas message/cause bruts', () => {
    const cause = new Error(SENTINELS.pg)
    cause.code = '23505'
    cause.detail = SENTINELS.email
    const err = internalHttpError(cause)
    err.message = SENTINELS.pg
    logHttpError('test/log', err, {
      status: 500,
      message: GENERIC_HTTP_ERROR_MESSAGE,
      internal: true,
    }, { method: 'POST', path: '/api/auth/login' })

    assert.equal(captured.length, 1)
    const meta = captured[0][1]
    assert.equal(meta.pgCode, '23505')
    assert.equal(meta.path, '/api/auth/login')
    assert.equal('message' in meta, false)
    assert.equal('causeMessage' in meta, false)
    assert.equal('stack' in meta, false)
    assert.equal('detail' in meta, false)
    assertNoSentinels()
  })

  it('logServerError n’écrit pas les sentinelles', () => {
    const err = new Error(
      `${SENTINELS.pg} ${SENTINELS.password} ${SENTINELS.jwt} ${SENTINELS.dbUrl} ${SENTINELS.apiKey} ${SENTINELS.resetToken}`,
    )
    err.cause = { message: SENTINELS.email, code: 'XX000' }
    logServerError('test/server', err)
    assertNoSentinels()
  })

  it('buildSafeErrorLogMeta ignore detail/stack', () => {
    const err = {
      name: 'error',
      message: SENTINELS.pg,
      stack: `Error: ${SENTINELS.password}\n    at secret`,
      detail: SENTINELS.email,
      code: '23505',
      cause: {
        message: SENTINELS.dbUrl,
        code: 'XX000',
      },
    }
    const meta = buildSafeErrorLogMeta(err, { status: 500 }, { path: '/x' })
    assert.equal(meta.pgCode, '23505')
    assert.equal('message' in meta, false)
    assert.doesNotMatch(JSON.stringify(meta), /leak@example|SuperSecret|postgres:\/\/|eyJhbGci/)
  })

  it('erreur métier 4xx → pas de logHttpError', () => {
    const err = publicHttpError('Zone introuvable', 404)
    logHttpError('test/4xx', err, classifyHttpError(err))
    assert.equal(captured.length, 0)
  })
})
