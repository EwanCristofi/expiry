/**
 * Tests de sécurisation des URL de réinitialisation (resolveAppUrl).
 * Exécution : npm test
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  AuthError,
  buildPasswordResetPath,
  normalizeAppUrl,
  resolveAppUrl,
} from './auth.js'

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  APP_URL: process.env.APP_URL,
  VITE_APP_URL: process.env.VITE_APP_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
}

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV

  if (ORIGINAL_ENV.APP_URL === undefined) delete process.env.APP_URL
  else process.env.APP_URL = ORIGINAL_ENV.APP_URL

  if (ORIGINAL_ENV.VITE_APP_URL === undefined) delete process.env.VITE_APP_URL
  else process.env.VITE_APP_URL = ORIGINAL_ENV.VITE_APP_URL

  if (ORIGINAL_ENV.NEXT_PUBLIC_APP_URL === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL
  } else {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_ENV.NEXT_PUBLIC_APP_URL
  }
})

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides)
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

describe('resolveAppUrl — production', () => {
  it('a) accepte une APP_URL HTTPS valide', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com/',
      },
      () => {
        assert.equal(resolveAppUrl(), 'https://expiry.example.com')
      },
    )
  })

  it('b) échoue si APP_URL est absente', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: undefined,
        VITE_APP_URL: undefined,
        NEXT_PUBLIC_APP_URL: undefined,
      },
      () => {
        assert.throws(() => resolveAppUrl(), (err) => {
          assert.ok(err instanceof AuthError)
          assert.equal(err.status, 500)
          assert.match(err.message, /APP_URL manquante/)
          return true
        })
      },
    )
  })

  it('c) échoue si APP_URL est invalide (http, malformée, avec credentials)', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      assert.throws(
        () =>
          withEnv({ APP_URL: 'http://expiry.example.com' }, () =>
            resolveAppUrl(),
          ),
        (err) => {
          assert.ok(err instanceof AuthError)
          assert.match(err.message, /HTTPS obligatoire/)
          return true
        },
      )

      assert.throws(
        () => withEnv({ APP_URL: 'not-a-url' }, () => resolveAppUrl()),
        (err) => {
          assert.ok(err instanceof AuthError)
          assert.match(err.message, /invalide/)
          return true
        },
      )

      assert.throws(
        () =>
          withEnv(
            { APP_URL: 'https://user:pass@expiry.example.com' },
            () => resolveAppUrl(),
          ),
        (err) => {
          assert.ok(err instanceof AuthError)
          assert.match(err.message, /identifiants/)
          return true
        },
      )
    })
  })

  it('d) ignore une falsification via Origin (requête malveillante)', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com',
      },
      () => {
        const url = resolveAppUrl({
          origin: 'https://evil.attacker.tld',
          host: 'evil.attacker.tld',
          proto: 'https',
        })
        assert.equal(url, 'https://expiry.example.com')
        assert.doesNotMatch(url, /evil/)
      },
    )
  })

  it('e) ignore une falsification via Host / x-forwarded-host', () => {
    withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: undefined,
        VITE_APP_URL: 'https://vite-should-not-be-used.example',
        NEXT_PUBLIC_APP_URL: 'https://next-should-not-be-used.example',
      },
      () => {
        assert.throws(
          () =>
            resolveAppUrl({
              origin: 'https://evil.attacker.tld',
              host: 'evil.attacker.tld',
              proto: 'https',
            }),
          (err) => {
            assert.ok(err instanceof AuthError)
            assert.match(err.message, /APP_URL manquante/)
            return true
          },
        )
      },
    )
  })
})

describe('resolveAppUrl — développement local', () => {
  it('f) utilise le fallback localhost si APP_URL absente', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        APP_URL: undefined,
        VITE_APP_URL: 'https://should-not-use.example',
        NEXT_PUBLIC_APP_URL: 'https://should-not-use-either.example',
      },
      () => {
        assert.equal(resolveAppUrl(), 'http://localhost:5173')
      },
    )
  })

  it('f) accepte APP_URL http en développement', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:5173/',
      },
      () => {
        assert.equal(resolveAppUrl(), 'http://localhost:5173')
      },
    )
  })

  it('f) ignore Origin / Host même en développement', () => {
    withEnv(
      {
        NODE_ENV: 'development',
        APP_URL: undefined,
      },
      () => {
        assert.equal(
          resolveAppUrl({
            origin: 'https://evil.attacker.tld',
            host: 'evil.attacker.tld',
          }),
          'http://localhost:5173',
        )
      },
    )
  })
})

describe('buildPasswordResetPath — anti open-redirect', () => {
  it('produit un chemin relatif uniquement', () => {
    const path = buildPasswordResetPath('abc123')
    assert.equal(path.startsWith('/'), true)
    assert.equal(path.includes('://'), false)
    assert.match(path, /^\/reset-password\?token=abc123$/)
  })

  it('encode le jeton', () => {
    assert.equal(
      buildPasswordResetPath('a b/c'),
      '/reset-password?token=a%20b%2Fc',
    )
  })
})

describe('normalizeAppUrl', () => {
  it('conserve un pathname non racine', () => {
    assert.equal(
      normalizeAppUrl('https://expiry.example.com/app/', {
        requireHttps: true,
      }),
      'https://expiry.example.com/app',
    )
  })
})
