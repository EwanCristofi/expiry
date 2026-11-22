/**
 * Tests P1/P2 : cookie HttpOnly, CORS allowlist, CSRF Origin, dual-read session.
 * Pas de DB requise pour ces assertions.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  listAllowedOrigins,
  originFromUrlString,
  resolveCorsAllowOrigin,
  isOriginAllowed,
} from './allowedOrigins.js'
import {
  AUTH_COOKIE_MAX_AGE_SEC,
  TOKEN_COOKIE,
  getAuthCookieOptions,
  setAuthUserFinderForTests,
  signToken,
  verifyToken,
} from './auth.js'
import { buildSessionAuthJson } from './authResponse.js'
import { isTrustedCookieMutation } from './csrfOrigin.js'
import { resolveSessionToken } from './sessionToken.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  APP_URL: process.env.APP_URL,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  CRON_SECRET: process.env.CRON_SECRET,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

before(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
  process.env.CRON_SECRET = 'test-cron-secret-16chars'
  process.env.APP_URL = 'https://expiry.example.com'
  delete process.env.CORS_ORIGINS
  process.env.NODE_ENV = 'test'
})

after(() => {
  restoreEnv()
})

describe('getAuthCookieOptions', () => {
  it('aligne maxAge sur 7 jours (même durée que le JWT)', () => {
    assert.equal(AUTH_COOKIE_MAX_AGE_SEC, 60 * 60 * 24 * 7)
    const opts = getAuthCookieOptions(false)
    assert.equal(opts.maxAge, AUTH_COOKIE_MAX_AGE_SEC)
    assert.equal(opts.httpOnly, true)
    assert.equal(opts.sameSite, 'Lax')
    assert.equal(opts.path, '/')
    assert.equal(opts.secure, false)
    assert.equal('domain' in opts, false)
  })

  it('active Secure en production', () => {
    assert.equal(getAuthCookieOptions(true).secure, true)
  })

  it('désactive Secure hors production (HTTP local)', () => {
    assert.equal(getAuthCookieOptions(false).secure, false)
  })
})

describe('buildSessionAuthJson', () => {
  it('ne contient jamais la propriété token', () => {
    const body = buildSessionAuthJson(
      {
        id: 'u1',
        email: 'a@b.c',
        nom: 'A',
        role: 'admin',
        pharmacy_id: 'p1',
        pharmacy: { id: 'p1', nom: 'Pharma' },
      },
      () => false,
    )
    assert.equal('token' in body, false)
    assert.equal(body.user.id, 'u1')
    assert.equal(body.user.is_platform_admin, false)
  })
})

describe('resolveSessionToken (cookie prioritaire)', () => {
  it('préfère le cookie au Bearer', () => {
    assert.equal(resolveSessionToken('cookie-jwt', 'bearer-jwt'), 'cookie-jwt')
  })

  it('utilise le Bearer si cookie absent', () => {
    assert.equal(resolveSessionToken(null, 'bearer-jwt'), 'bearer-jwt')
    assert.equal(resolveSessionToken('', 'bearer-jwt'), 'bearer-jwt')
  })

  it('retourne null si aucun jeton', () => {
    assert.equal(resolveSessionToken(null, null), null)
  })
})

describe('allowedOrigins / CORS', () => {
  it('APP_URL HTTPS valide en production : accepté', () => {
    const list = listAllowedOrigins({
      NODE_ENV: 'production',
      APP_URL: 'https://expiry.example.com/',
      CORS_ORIGINS: '',
    })
    assert.deepEqual(list, ['https://expiry.example.com'])
  })

  it('APP_URL absent en production : erreur explicite', () => {
    assert.throws(
      () =>
        listAllowedOrigins({
          NODE_ENV: 'production',
          APP_URL: undefined,
          CORS_ORIGINS: '',
        }),
      /APP_URL manquante en production/,
    )
  })

  it('APP_URL HTTP en production : erreur explicite', () => {
    assert.throws(
      () =>
        listAllowedOrigins({
          NODE_ENV: 'production',
          APP_URL: 'http://expiry.example.com',
          CORS_ORIGINS: '',
        }),
      /HTTPS obligatoire/,
    )
  })

  it('origine localhost autorisée en développement', () => {
    const list = listAllowedOrigins({
      NODE_ENV: 'development',
      APP_URL: '',
      CORS_ORIGINS: '',
    })
    assert.ok(list.includes('http://localhost:5173'))
    assert.ok(list.includes('http://127.0.0.1:5173'))
    assert.equal(
      isOriginAllowed('http://localhost:5173', {
        NODE_ENV: 'development',
      }),
      true,
    )
  })

  it('origine localhost refusée en production par défaut', () => {
    const env = {
      NODE_ENV: 'production',
      APP_URL: 'https://expiry.example.com',
      CORS_ORIGINS: '',
    }
    const list = listAllowedOrigins(env)
    assert.equal(list.includes('http://localhost:5173'), false)
    assert.equal(list.includes('http://127.0.0.1:5173'), false)
    assert.equal(isOriginAllowed('http://localhost:5173', env), false)
    assert.equal(
      resolveCorsAllowOrigin('http://localhost:5173', env),
      null,
    )
  })

  it('origine explicitement ajoutée à CORS_ORIGINS : autorisée', () => {
    const env = {
      NODE_ENV: 'production',
      APP_URL: 'https://expiry.example.com',
      CORS_ORIGINS:
        'https://preview.example.com, https://www.example.com',
    }
    const list = listAllowedOrigins(env)
    assert.ok(list.includes('https://expiry.example.com'))
    assert.ok(list.includes('https://preview.example.com'))
    assert.ok(list.includes('https://www.example.com'))
    assert.equal(
      resolveCorsAllowOrigin('https://preview.example.com', env),
      'https://preview.example.com',
    )
  })

  it('origine inconnue : refusée', () => {
    assert.equal(
      resolveCorsAllowOrigin('https://evil.example', {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com',
      }),
      null,
    )
    assert.equal(
      isOriginAllowed('https://evil.example', {
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:5173',
      }),
      false,
    )
  })

  it('renvoie l’origine exacte si allowlistée', () => {
    assert.equal(
      resolveCorsAllowOrigin('https://expiry.example.com', {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com',
      }),
      'https://expiry.example.com',
    )
  })

  it('refuse Origin vide', () => {
    assert.equal(
      resolveCorsAllowOrigin('', {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com',
      }),
      null,
    )
  })

  it('parse Referer via URL.origin (pas un préfixe)', () => {
    assert.equal(
      originFromUrlString('https://expiry.example.com/path'),
      'https://expiry.example.com',
    )
    assert.equal(
      isOriginAllowed('https://expiry.example.com.evil.example', {
        NODE_ENV: 'production',
        APP_URL: 'https://expiry.example.com',
      }),
      false,
    )
    assert.equal(
      originFromUrlString('https://expiry.example.com.evil.example/x') ===
        'https://expiry.example.com',
      false,
    )
  })
})

describe('isTrustedCookieMutation (CSRF)', () => {
  const env = { APP_URL: 'https://expiry.example.com', CORS_ORIGINS: '' }

  it('accepte Origin allowlisté', () => {
    assert.equal(
      isTrustedCookieMutation({ origin: 'https://expiry.example.com' }, env),
      true,
    )
  })

  it('refuse Origin étranger', () => {
    assert.equal(
      isTrustedCookieMutation({ origin: 'https://evil.example' }, env),
      false,
    )
  })

  it('accepte Origin absent + Sec-Fetch-Site same-origin', () => {
    assert.equal(
      isTrustedCookieMutation(
        { origin: null, secFetchSite: 'same-origin' },
        env,
      ),
      true,
    )
  })

  it('refuse Origin absent + Sec-Fetch-Site cross-site', () => {
    assert.equal(
      isTrustedCookieMutation(
        { origin: null, secFetchSite: 'cross-site' },
        env,
      ),
      false,
    )
  })

  it('accepte Origin absent + Referer allowlisté', () => {
    assert.equal(
      isTrustedCookieMutation(
        {
          origin: null,
          secFetchSite: null,
          referer: 'https://expiry.example.com/dashboard',
        },
        env,
      ),
      true,
    )
  })

  it('refuse Origin absent + Referer étranger (y compris préfixe trompeur)', () => {
    assert.equal(
      isTrustedCookieMutation(
        {
          origin: null,
          referer: 'https://expiry.example.com.evil.example/',
        },
        env,
      ),
      false,
    )
  })

  it('refuse Origin absent sans preuve fiable', () => {
    assert.equal(
      isTrustedCookieMutation({ origin: null, secFetchSite: null, referer: null }, env),
      false,
    )
  })

  it('Sec-Fetch-Site none : n’accepte pas sans Referer allowlisté', () => {
    assert.equal(
      isTrustedCookieMutation(
        { origin: null, secFetchSite: 'none', referer: null },
        env,
      ),
      false,
    )
    assert.equal(
      isTrustedCookieMutation(
        {
          origin: null,
          secFetchSite: 'none',
          referer: 'https://expiry.example.com/',
        },
        env,
      ),
      true,
    )
  })
})

describe('HTTP — CORS, CSRF, cookie logout, requireAuth, cron', () => {
  /** @type {import('hono').Hono} */
  let app

  before(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-16chars-min'
    process.env.CRON_SECRET = 'test-cron-secret-16chars'
    process.env.APP_URL = 'https://expiry.example.com'
    delete process.env.CORS_ORIGINS
    // Recharge l’app avec l’env de test (module déjà potentiellement chargé).
    app = (await import(`./app.js?t=${Date.now()}`)).default
  })

  async function signUserJwt() {
    return signToken({
      id: '11111111-1111-4111-8111-111111111111',
      pharmacy_id: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      email: 'admin@test.local',
      session_version: 0,
    })
  }

  it('CORS : origine autorisée reçoit ACAO + credentials', async () => {
    const res = await app.request('http://expiry.example.com/api/health', {
      headers: { Origin: 'https://expiry.example.com' },
    })
    assert.equal(res.status, 200)
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'https://expiry.example.com',
    )
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true')
  })

  it('CORS : origine inconnue → pas d’ACAO (pas de réflexion)', async () => {
    const res = await app.request('http://expiry.example.com/api/health', {
      headers: { Origin: 'https://evil.attacker.tld' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('logout expire le cookie avec Path=/ ; SameSite=Lax ; HttpOnly', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: `${TOKEN_COOKIE}=stale-value`,
      },
    })
    assert.equal(res.status, 200)
    const setCookie = res.headers.getSetCookie?.() ?? []
    const joined = setCookie.join('\n') || res.headers.get('set-cookie') || ''
    assert.match(joined, new RegExp(`${TOKEN_COOKIE}=`))
    assert.match(joined, /Max-Age=0/i)
    assert.match(joined, /Path=\//i)
    assert.match(joined, /HttpOnly/i)
    assert.match(joined, /SameSite=Lax/i)
  })

  it('CSRF : cookie + Origin étranger → 403', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.attacker.tld',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.match(body.error, /origine/i)
  })

  it('CSRF : cookie + Origin allowlisté → passe', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 200)
  })

  it('CSRF : cookie + Sec-Fetch-Site same-origin sans Origin → passe', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 200)
  })

  it('CSRF : cookie + Sec-Fetch-Site cross-site → 403', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 403)
  })

  it('CSRF : cookie + Referer allowlisté sans Origin → passe', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Referer: 'https://expiry.example.com/settings',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 200)
  })

  it('CSRF : cookie + Referer étranger → 403', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Referer: 'https://evil.example/phish',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 403)
  })

  it('CSRF : cookie sans preuve d’origine → 403', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 403)
  })

  it('CSRF : Sec-Fetch-Site none sans Referer → 403', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'none',
        Cookie: `${TOKEN_COOKIE}=any`,
      },
    })
    assert.equal(res.status, 403)
  })

  it('CSRF : sans cookie → pas de blocage (login/register/cron-like)', async () => {
    const res = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://evil.attacker.tld' },
    })
    assert.equal(res.status, 200)
  })

  it('/api/auth/me sans cookie ni Bearer → 401', async () => {
    const res = await app.request('http://localhost/api/auth/me')
    assert.equal(res.status, 401)
  })

  it('cookie invalide + Bearer valide → 401 (pas de bascule)', async () => {
    const bearer = await signUserJwt()
    const res = await app.request('http://localhost/api/auth/me', {
      headers: {
        Cookie: `${TOKEN_COOKIE}=not-a-valid-jwt`,
        Authorization: `Bearer ${bearer}`,
      },
    })
    assert.equal(res.status, 401)
  })

  it('Bearer valide sans cookie mais user absent en DB → 401 (relecture DB, dual-read)', async () => {
    setAuthUserFinderForTests(async () => null)
    try {
      const bearer = await signUserJwt()
      const res = await app.request('http://localhost/api/auth/me', {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      // JWT crypto OK + dual-read Bearer, mais compte absent → 401 (pas de claims JWT).
      assert.equal(res.status, 401)
    } finally {
      setAuthUserFinderForTests(null)
    }
  })

  it('cookie JWT valide sans Authorization mais user absent en DB → 401', async () => {
    setAuthUserFinderForTests(async () => null)
    try {
      const jwt = await signUserJwt()
      const res = await app.request('http://localhost/api/auth/me', {
        headers: { Cookie: `${TOKEN_COOKIE}=${jwt}` },
      })
      assert.equal(res.status, 401)
    } finally {
      setAuthUserFinderForTests(null)
    }
  })

  it('requireAuth branche resolveAuthSession (contrat source)', () => {
    const src = readFileSync(join(__dirname, 'app.js'), 'utf8')
    assert.match(src, /resolveAuthSession/)
    assert.match(src, /export async function requireAuth/)
    // Plus de construction de session auth depuis verifyToken seul.
    assert.doesNotMatch(
      src,
      /const session = await verifyToken\(resolveSessionToken/,
    )
  })

  it('après logout, cookie expiré → /me en 401', async () => {
    const logoutRes = await app.request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: `${TOKEN_COOKIE}=stale`,
      },
    })
    assert.equal(logoutRes.status, 200)
    const me = await app.request('http://localhost/api/auth/me', {
      headers: {
        // Simule navigateur qui n’envoie plus le cookie après Max-Age=0
      },
    })
    assert.equal(me.status, 401)
  })

  it('cron : CRON_SECRET invalide → 401 sans cookie', async () => {
    const res = await app.request('http://localhost/api/cron/cleanup', {
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(res.status, 401)
  })

  it('cron : CRON_SECRET valide → auth cron OK (≠ 401), indépendant du cookie', async () => {
    const res = await app.request('http://localhost/api/cron/cleanup', {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    })
    assert.notEqual(res.status, 401)
  })

  it('JWT signé : durée de vie cohérente avec le cookie (exp ≈ 7j)', async () => {
    const token = await signUserJwt()
    const claims = await verifyToken(token)
    assert.ok(claims)
    assert.equal(claims.userId, '11111111-1111-4111-8111-111111111111')
    const { jwtVerify } = await import('jose')
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const { payload } = await jwtVerify(token, secret)
    const now = Math.floor(Date.now() / 1000)
    const ttl = Number(payload.exp) - now
    assert.ok(ttl > AUTH_COOKIE_MAX_AGE_SEC - 120)
    assert.ok(ttl <= AUTH_COOKIE_MAX_AGE_SEC + 5)
  })
})

describe('Frontend cookie-only (contrats source)', () => {
  it('api.js : credentials include, pas de Bearer ni localStorage JWT', () => {
    const src = readFileSync(join(__dirname, '../src/services/api.js'), 'utf8')
    assert.match(src, /credentials:\s*['"]include['"]/)
    assert.doesNotMatch(src, /Authorization/)
    assert.doesNotMatch(src, /Bearer/)
    assert.doesNotMatch(src, /localStorage\.setItem/)
    assert.doesNotMatch(src, /getStoredToken|setStoredToken/)
    assert.match(src, /expiry\.authToken/)
    assert.match(src, /removeItem/)
  })

  it('authService.js : ne lit plus data.token', () => {
    const src = readFileSync(
      join(__dirname, '../src/services/authService.js'),
      'utf8',
    )
    assert.doesNotMatch(src, /data\.token/)
    assert.doesNotMatch(src, /setStoredToken/)
    assert.match(src, /clearLegacyAuthToken/)
  })

  it('AuthContext : boot via fetchMe sans gate localStorage', () => {
    const src = readFileSync(
      join(__dirname, '../src/contexts/AuthContext.jsx'),
      'utf8',
    )
    assert.doesNotMatch(src, /getStoredToken/)
    assert.match(src, /fetchMe\(\)/)
    assert.match(src, /clearLegacyAuthToken/)
  })

  it('ne purge que expiry.authToken (pas activeZone / son)', () => {
    const src = readFileSync(join(__dirname, '../src/services/api.js'), 'utf8')
    assert.doesNotMatch(src, /activeZoneId/)
    assert.doesNotMatch(src, /sound/i)
  })
})

describe('issueAuthResponse dans app.js', () => {
  it('n’inclut plus token dans le JSON de session', () => {
    const src = readFileSync(join(__dirname, 'app.js'), 'utf8')
    assert.match(src, /buildSessionAuthJson/)
    assert.doesNotMatch(src, /token,\s*user:/)
    assert.doesNotMatch(src, /\btoken:\s*token\b/)
  })
})
