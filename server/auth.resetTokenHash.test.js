/**
 * Tests finding #2 : tokens de reset stockés en SHA-256 uniquement.
 * Exécution : npm test
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import {
  AuthError,
  requestPasswordReset,
  resetPasswordWithToken,
  resolveAuthSession,
  setAuthUserFinderForTests,
  signToken,
} from './auth.js'
import { generateResetTokenPair, hashResetToken } from './resetToken.js'

const ORIGINAL_APP_URL = process.env.APP_URL
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

before(() => {
  process.env.NODE_ENV = 'development'
  process.env.APP_URL = 'http://localhost:5173'
})

after(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL
  else process.env.APP_URL = ORIGINAL_APP_URL
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV
})

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/**
 * Store mémoire simulant la colonne users.reset_token (empreinte uniquement).
 */
function createMemoryPasswordResetStore(seedUsers = []) {
  /** @type {Map<string, {
   *   id: string,
   *   email: string,
   *   password_hash: string | null,
   *   reset_token: string | null,
   *   reset_token_expires: string | null,
   *   session_version: number,
   * }>} */
  const users = new Map()

  for (const user of seedUsers) {
    users.set(String(user.id), {
      id: String(user.id),
      email: String(user.email).toLowerCase(),
      password_hash: user.password_hash ?? 'existing-hash',
      reset_token: user.reset_token ?? null,
      reset_token_expires: user.reset_token_expires ?? null,
      session_version:
        typeof user.session_version === 'number' ? user.session_version : 0,
    })
  }

  return {
    users,
    async findUserByEmail(email) {
      const normalized = String(email).toLowerCase()
      for (const user of users.values()) {
        if (user.email === normalized) {
          return { id: user.id, email: user.email }
        }
      }
      return null
    },
    async saveResetTokenHash(userId, tokenHash, expiresAt) {
      const user = users.get(String(userId))
      if (!user) throw new Error('user missing')
      user.reset_token = tokenHash
      user.reset_token_expires = expiresAt
    },
    async findUserByResetTokenHash(tokenHash) {
      for (const user of users.values()) {
        if (user.reset_token === tokenHash) {
          return {
            id: user.id,
            reset_token_expires: user.reset_token_expires,
          }
        }
      }
      return null
    },
    async consumeResetToken(userId, passwordHash) {
      const user = users.get(String(userId))
      if (!user) throw new Error('user missing')
      user.password_hash = passwordHash
      user.reset_token = null
      user.reset_token_expires = null
      user.session_version = (user.session_version ?? 0) + 1
    },
  }
}

describe('hashResetToken / generateResetTokenPair', () => {
  it('produit un SHA-256 hex de 64 caractères', () => {
    const digest = hashResetToken('demo-token')
    assert.equal(digest, sha256Hex('demo-token'))
    assert.match(digest, /^[a-f0-9]{64}$/)
  })

  it('ne renvoie jamais le jeton clair comme empreinte', () => {
    const { token, tokenHash } = generateResetTokenPair()
    assert.equal(token.length, 64)
    assert.match(token, /^[a-f0-9]+$/)
    assert.notEqual(token, tokenHash)
    assert.equal(tokenHash, hashResetToken(token))
  })
})

describe('requestPasswordReset — stockage hash uniquement', () => {
  it('ne stocke jamais le token original en base ; stocke SHA-256', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    /** @type {string | null} */
    let emailedToken = null

    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async ({ resetUrl }) => {
        const url = new URL(resetUrl)
        emailedToken = url.searchParams.get('token')
      },
    })

    assert.ok(emailedToken, 'le lien e-mail doit contenir le token clair')
    const row = store.users.get('user-1')
    assert.ok(row)
    assert.notEqual(row.reset_token, emailedToken)
    assert.equal(row.reset_token, hashResetToken(emailedToken))
    assert.equal(row.reset_token, sha256Hex(emailedToken))
    assert.ok(row.reset_token_expires)
  })

  it('ne journalise / n’expose pas l’empreinte dans la réponse API', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    const result = await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async () => {},
    })
    const serialized = JSON.stringify(result)
    assert.equal(result.message.includes('réinitialisation'), true)
    assert.equal(serialized.includes(store.users.get('user-1').reset_token), false)
  })
})

describe('resetPasswordWithToken — validation via empreinte', () => {
  it('accepte un token valide et réinitialise le mot de passe', async () => {
    const store = createMemoryPasswordResetStore([
      {
        id: 'user-1',
        email: 'pharma@example.com',
        password_hash: 'old',
        session_version: 0,
      },
    ])
    let plaintext = ''
    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async ({ resetUrl }) => {
        plaintext = new URL(resetUrl).searchParams.get('token') || ''
      },
    })

    const result = await resetPasswordWithToken(plaintext, 'new-password-ok', {
      store,
    })
    assert.deepEqual(result, { ok: true })
    const row = store.users.get('user-1')
    assert.notEqual(row.password_hash, 'old')
    assert.equal(row.reset_token, null)
    assert.equal(row.reset_token_expires, null)
    assert.equal(row.session_version, 1)
  })

  it('8. réinitialisation → session_version incrémentée atomiquement avec le hash', async () => {
    const store = createMemoryPasswordResetStore([
      {
        id: 'user-1',
        email: 'pharma@example.com',
        password_hash: 'old',
        session_version: 4,
      },
    ])
    let plaintext = ''
    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async ({ resetUrl }) => {
        plaintext = new URL(resetUrl).searchParams.get('token') || ''
      },
    })
    await resetPasswordWithToken(plaintext, 'new-password-ok', { store })
    assert.equal(store.users.get('user-1').session_version, 5)
  })

  it('9. ancien JWT refusé après réinitialisation (session_version mismatch)', async () => {
    const prevSecret = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
    const userId = '11111111-1111-4111-8111-111111111111'
    const pharmacyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    try {
      const store = createMemoryPasswordResetStore([
        {
          id: userId,
          email: 'pharma@example.com',
          password_hash: 'old',
          session_version: 0,
        },
      ])
      const oldToken = await signToken({
        id: userId,
        pharmacy_id: pharmacyId,
        role: 'admin',
        email: 'pharma@example.com',
        session_version: 0,
      })

      let plaintext = ''
      await requestPasswordReset('pharma@example.com', {
        store,
        sendEmail: async ({ resetUrl }) => {
          plaintext = new URL(resetUrl).searchParams.get('token') || ''
        },
      })
      await resetPasswordWithToken(plaintext, 'new-password-ok', { store })
      const row = store.users.get(userId)
      assert.equal(row.session_version, 1)

      setAuthUserFinderForTests(async () => ({
        id: userId,
        email: 'pharma@example.com',
        role: 'admin',
        pharmacy_id: pharmacyId,
        session_version: row.session_version,
        is_active: true,
      }))
      assert.equal(await resolveAuthSession(oldToken), null)

      const fresh = await signToken({
        id: userId,
        pharmacy_id: pharmacyId,
        role: 'admin',
        email: 'pharma@example.com',
        session_version: row.session_version,
      })
      assert.ok(await resolveAuthSession(fresh))
    } finally {
      setAuthUserFinderForTests(null)
      if (prevSecret === undefined) delete process.env.JWT_SECRET
      else process.env.JWT_SECRET = prevSecret
    }
  })

  it('contrat source Neon : consumeResetToken incrémente session_version dans le même UPDATE', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'auth.js'),
      'utf8',
    )
    assert.match(
      src,
      /password_hash\s*=\s*\$\{passwordHash\}[\s\S]*?session_version\s*=\s*session_version\s*\+\s*1[\s\S]*?reset_token\s*=\s*NULL|password_hash\s*=\s*\$\{passwordHash\},[\s\S]*?session_version\s*=\s*session_version\s*\+\s*1/,
    )
  })

  it('refuse un token incorrect', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async () => {},
    })

    await assert.rejects(
      () => resetPasswordWithToken('deadbeef'.repeat(8), 'new-password-ok', { store }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.status, 400)
        assert.match(err.message, /invalide ou a expiré/)
        return true
      },
    )
    assert.ok(store.users.get('user-1').reset_token)
  })

  it('refuse un token expiré', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    const issuedAt = Date.UTC(2026, 0, 1, 12, 0, 0)
    let plaintext = ''
    await requestPasswordReset('pharma@example.com', {
      store,
      now: () => issuedAt,
      sendEmail: async ({ resetUrl }) => {
        plaintext = new URL(resetUrl).searchParams.get('token') || ''
      },
    })

    await assert.rejects(
      () =>
        resetPasswordWithToken(plaintext, 'new-password-ok', {
          store,
          now: () => issuedAt + 2 * 60 * 60 * 1000,
        }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.match(err.message, /invalide ou a expiré/)
        return true
      },
    )
  })

  it('refuse un token déjà utilisé (invalidé après succès)', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    let plaintext = ''
    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async ({ resetUrl }) => {
        plaintext = new URL(resetUrl).searchParams.get('token') || ''
      },
    })

    await resetPasswordWithToken(plaintext, 'new-password-ok', { store })

    await assert.rejects(
      () => resetPasswordWithToken(plaintext, 'another-password', { store }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.match(err.message, /invalide ou a expiré/)
        return true
      },
    )
    assert.equal(store.users.get('user-1').reset_token, null)
  })

  it('invalide le token après utilisation réussie', async () => {
    const store = createMemoryPasswordResetStore([
      { id: 'user-1', email: 'pharma@example.com' },
    ])
    let plaintext = ''
    await requestPasswordReset('pharma@example.com', {
      store,
      sendEmail: async ({ resetUrl }) => {
        plaintext = new URL(resetUrl).searchParams.get('token') || ''
      },
    })
    assert.ok(store.users.get('user-1').reset_token)

    await resetPasswordWithToken(plaintext, 'new-password-ok', { store })

    assert.equal(store.users.get('user-1').reset_token, null)
    assert.equal(store.users.get('user-1').reset_token_expires, null)
  })

  it('un ancien token stocké en clair (pré-migration) ne fonctionne plus', async () => {
    const legacyPlain = 'a'.repeat(64)
    const store = createMemoryPasswordResetStore([
      {
        id: 'user-1',
        email: 'pharma@example.com',
        reset_token: legacyPlain,
        reset_token_expires: new Date(Date.now() + 60_000).toISOString(),
      },
    ])

    await assert.rejects(
      () =>
        resetPasswordWithToken(legacyPlain, 'new-password-ok', { store }),
      (err) => {
        assert.ok(err instanceof AuthError)
        assert.match(err.message, /invalide ou a expiré/)
        return true
      },
    )
  })
})
