/**
 * Identification admin plateforme (ADMIN_EMAIL / ADMIN_USER_ID).
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, after } from 'node:test'
import { isPlatformAdmin } from './platformAdmin.js'

const ORIGINAL = {
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_USER_ID
})

after(() => {
  restoreEnv()
})

describe('isPlatformAdmin', () => {
  it('refuse sans session', () => {
    assert.equal(isPlatformAdmin(null), false)
    assert.equal(isPlatformAdmin(undefined), false)
  })

  it('identifie via ADMIN_EMAIL (casse / espaces ignorés)', () => {
    process.env.ADMIN_EMAIL = 'Admin@Expiry.local'
    assert.equal(
      isPlatformAdmin({ userId: 'x', email: ' admin@expiry.local ' }),
      true,
    )
    assert.equal(
      isPlatformAdmin({ userId: 'x', email: 'other@expiry.local' }),
      false,
    )
  })

  it('identifie via ADMIN_USER_ID', () => {
    process.env.ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111'
    assert.equal(
      isPlatformAdmin({
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'a@b.c',
      }),
      true,
    )
    assert.equal(
      isPlatformAdmin({
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'a@b.c',
      }),
      false,
    )
  })

  it('ne s’élargit pas sans variables d’environnement', () => {
    assert.equal(
      isPlatformAdmin({
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'admin@expiry.local',
      }),
      false,
    )
  })

  it('app.js réexporte le même isPlatformAdmin (contrat source)', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const appSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'app.js'),
      'utf8',
    )
    assert.match(appSrc, /export \{ isPlatformAdmin \} from '\.\/platformAdmin\.js'/)
    assert.doesNotMatch(
      appSrc,
      /export function isPlatformAdmin|function isPlatformAdmin\(/,
    )
  })
})
