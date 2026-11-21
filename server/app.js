import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { resolveCorsAllowOrigin } from './allowedOrigins.js'
import {
  AuthError,
  TOKEN_COOKIE,
  authenticateUser,
  getAuthCookieOptions,
  getUserProfile,
  readBearerToken,
  registerPharmacy,
  requestPasswordReset,
  resetPasswordWithToken,
  signToken,
  verifyToken,
} from './auth.js'
import { buildSessionAuthJson } from './authResponse.js'
import { isTrustedCookieMutationRequest } from './csrfOrigin.js'
import { resolveSessionToken } from './sessionToken.js'
import {
  bulkCreateZones,
  cleanupExpiredScans,
  createZone,
  deleteScan,
  deleteZone,
  listExpiryChecks,
  listLaboratoires,
  listZones,
  renameZone,
  resetAllZonesVerified,
  resolveProductName,
  saveScan,
  searchScans,
  setScanVerified,
  setZoneVerified,
} from './productLogic.js'
import {
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  updateTeamMember,
} from './team.js'
import { getAdminDashboard, updatePharmacyStatus } from './admin.js'
import { getPharmacyTrial } from './trial.js'

const app = new Hono()
const isProd = process.env.NODE_ENV === 'production'

/**
 * Admin plateforme (pas le rôle `admin` d’une officine).
 * Configuré via ADMIN_EMAIL et/ou ADMIN_USER_ID.
 * @param {{ userId?: string, email?: string } | null | undefined} session
 */
function isPlatformAdmin(session) {
  if (!session) return false
  const adminUserId = String(process.env.ADMIN_USER_ID || '').trim()
  const adminEmail = String(process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase()
  if (adminUserId && String(session.userId) === adminUserId) return true
  if (adminEmail && String(session.email || '').trim().toLowerCase() === adminEmail) {
    return true
  }
  return false
}

app.use(
  '*',
  cors({
    // Hono : si la fonction renvoie null/undefined, ACAO n’est pas posé (pas de réflexion).
    origin: (origin) => resolveCorsAllowOrigin(origin),
    credentials: true,
  }),
)

/** Garantit charset=utf-8 sur les réponses JSON (accents médicaments, etc.). */
app.use('*', async (c, next) => {
  await next()
  const contentType = c.res.headers.get('Content-Type')
  if (contentType?.startsWith('application/json') && !/charset=/i.test(contentType)) {
    c.res.headers.set('Content-Type', 'application/json; charset=utf-8')
  }
})

/**
 * CSRF : mutations avec cookie de session uniquement.
 * GET/HEAD/OPTIONS et requêtes sans cookie (login, cron Bearer-only, etc.) : passent.
 */
app.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next()
  }
  const cookieToken = getCookie(c, TOKEN_COOKIE)
  if (!cookieToken) {
    return next()
  }
  if (!isTrustedCookieMutationRequest(c)) {
    return jsonError(c, 403, 'Origine non autorisée')
  }
  return next()
})

function jsonError(c, status, message) {
  return c.json({ error: message }, status)
}

/**
 * @param {import('hono').Context} c
 */
async function requireAuth(c, next) {
  const bearer = readBearerToken(c.req.header('Authorization'))
  const cookieToken = getCookie(c, TOKEN_COOKIE)
  // Cookie prioritaire ; cookie présent mais invalide → 401 (pas de bascule Bearer).
  const session = await verifyToken(resolveSessionToken(cookieToken, bearer))
  if (!session) {
    return jsonError(c, 401, 'Non authentifié')
  }
  c.set('auth', session)
  await next()
}

/**
 * Bloque l’accès métier si l’essai TRIAL est expiré (HTTP 402).
 * @param {import('hono').Context} c
 */
async function requireActiveTrial(c, next) {
  const auth = c.get('auth')
  try {
    const pharmacy = await getPharmacyTrial(auth.pharmacyId)
    if (!pharmacy) {
      return jsonError(c, 401, 'Pharmacie introuvable')
    }
    c.set('pharmacyTrial', pharmacy)
    if (pharmacy.suspended) {
      return jsonError(
        c,
        403,
        'Compte pharmacie suspendu. Contactez le support Expiry.',
      )
    }
    if (pharmacy.trialExpired) {
      return jsonError(
        c,
        402,
        'Période d’essai expirée. Souscrivez pour continuer.',
      )
    }
    await next()
  } catch (err) {
    console.error('[api/trial]', err)
    return jsonError(c, 500, err?.message || 'Vérification abonnement impossible')
  }
}

/**
 * Admin d’une officine (équipe / paramètres).
 * @param {import('hono').Context} c
 */
async function requireAdmin(c, next) {
  const auth = c.get('auth')
  const role = String(auth?.role || '').toLowerCase()
  if (role !== 'admin') {
    return jsonError(c, 403, 'Accès réservé aux administrateurs')
  }
  await next()
}

/**
 * Admin plateforme Expiry (suivi multi-pharmacies).
 * @param {import('hono').Context} c
 */
async function requirePlatformAdmin(c, next) {
  const auth = c.get('auth')
  if (!isPlatformAdmin(auth)) {
    return jsonError(c, 403, 'Accès réservé à l’administrateur plateforme')
  }
  await next()
}

app.get('/api/health', (c) => c.json({ ok: true }))

/**
 * Cron Vercel : purge des scans périmés > 3 mois.
 * Protégé par `Authorization: Bearer ${CRON_SECRET}`.
 */
app.get('/api/cron/cleanup', async (c) => {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = c.req.header('Authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return jsonError(c, 401, 'Non autorisé')
  }

  try {
    const result = await cleanupExpiredScans()
    return c.json({ ok: true, deleted: result.deleted })
  } catch (err) {
    console.error('[api/cron/cleanup]', err)
    return jsonError(c, 500, err?.message || 'Purge impossible')
  }
})

/**
 * @param {import('hono').Context} c
 * @param {Awaited<ReturnType<typeof authenticateUser>>} user
 * @param {200 | 201} [status=200]
 */
async function issueAuthResponse(c, user, status = 200) {
  const token = await signToken(user)
  setCookie(c, TOKEN_COOKIE, token, getAuthCookieOptions(isProd))
  // P1/P2 : le JWT n’est plus exposé dans le JSON (cookie HttpOnly uniquement).
  return c.json(buildSessionAuthJson(user, isPlatformAdmin), status)
}

app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json()
    const user = await authenticateUser(body?.email, body?.password)
    return await issueAuthResponse(c, user)
  } catch (err) {
    console.error('[api/auth/login]', err)
    const status =
      err instanceof AuthError
        ? err.status
        : err?.status === 401
          ? 401
          : 500
    return jsonError(c, status, err?.message || 'Connexion impossible')
  }
})

app.post('/api/auth/register', async (c) => {
  try {
    const body = await c.req.json()
    const user = await registerPharmacy({
      nom: body?.nom ?? body?.pharmacyName ?? body?.nomPharmacie,
      email: body?.email,
      password: body?.password,
      siret: body?.siret,
    })
    return await issueAuthResponse(c, user, 201)
  } catch (err) {
    console.error('[api/auth/register]', err)
    const status = err instanceof AuthError ? err.status : 500
    return jsonError(c, status, err?.message || 'Inscription impossible')
  }
})

app.post('/api/auth/logout', async (c) => {
  deleteCookie(c, TOKEN_COOKIE, getAuthCookieOptions(isProd))
  return c.json({ ok: true })
})

app.post('/api/auth/forgot-password', async (c) => {
  try {
    const body = await c.req.json()
    // Ne pas transmettre Origin / Host : l’URL de reset vient uniquement de APP_URL.
    const result = await requestPasswordReset(body?.email)
    return c.json(result)
  } catch (err) {
    console.error('[api/auth/forgot-password]', err)
    const status = err instanceof AuthError ? err.status : 500
    return jsonError(
      c,
      status,
      err?.message || 'Demande de réinitialisation impossible',
    )
  }
})

app.post('/api/auth/reset-password', async (c) => {
  try {
    const body = await c.req.json()
    const result = await resetPasswordWithToken(body?.token, body?.password)
    return c.json(result)
  } catch (err) {
    console.error('[api/auth/reset-password]', err)
    const status = err instanceof AuthError ? err.status : 500
    return jsonError(
      c,
      status,
      err?.message || 'Réinitialisation impossible',
    )
  }
})

app.get('/api/auth/me', requireAuth, async (c) => {
  try {
    const auth = c.get('auth')
    const profile = await getUserProfile(auth.userId)
    if (!profile) return jsonError(c, 401, 'Session invalide')
    return c.json({
      user: {
        ...profile,
        is_platform_admin: isPlatformAdmin({
          userId: profile.id,
          email: profile.email,
        }),
      },
    })
  } catch (err) {
    console.error('[api/auth/me]', err)
    const status = err instanceof AuthError ? err.status : 500
    return jsonError(c, status, err?.message || 'Session invalide')
  }
})

app.get('/api/admin/dashboard', requireAuth, requirePlatformAdmin, async (c) => {
  try {
    const dashboard = await getAdminDashboard()
    return c.json(dashboard)
  } catch (err) {
    console.error('[api/admin/dashboard]', err)
    return jsonError(c, 500, err?.message || 'Chargement admin impossible')
  }
})

app.patch(
  '/api/admin/pharmacies/:id/status',
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    try {
      const body = await c.req.json()
      const pharmacy = await updatePharmacyStatus(
        c.req.param('id'),
        body?.status,
      )
      return c.json({ pharmacy })
    } catch (err) {
      console.error('[api/admin/pharmacies/status]', err)
      const status = err?.message?.includes('introuvable') ? 404 : 400
      return jsonError(c, status, err?.message || 'Mise à jour impossible')
    }
  },
)

app.get('/api/products/resolve', requireAuth, requireActiveTrial, async (c) => {
  const code = c.req.query('code')
  const resolved = await resolveProductName(code)
  return c.json({ product: resolved })
})

app.get('/api/zones', requireAuth, requireActiveTrial, async (c) => {
  const auth = c.get('auth')
  const zones = await listZones(auth.pharmacyId)
  return c.json({ zones })
})

app.post('/api/zones', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const zone = await createZone(auth.pharmacyId, body?.nom_zone ?? body?.nomZone)
    return c.json({ zone }, 201)
  } catch (err) {
    const status = err?.message?.includes('existe déjà') ? 409 : 400
    return jsonError(c, status, err?.message || 'Création impossible')
  }
})

app.post('/api/zones/bulk', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const items = Array.isArray(body) ? body : body?.zones
    const result = await bulkCreateZones(auth.pharmacyId, items)
    return c.json(result, 201)
  } catch (err) {
    const status = err?.message?.includes('existe déjà') ? 409 : 400
    return jsonError(c, status, err?.message || 'Import impossible')
  }
})

app.patch('/api/zones/:id', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const id = Number(c.req.param('id'))
    const body = await c.req.json()
    const zone = await renameZone(
      auth.pharmacyId,
      id,
      body?.nom_zone ?? body?.nomZone,
    )
    return c.json({ zone })
  } catch (err) {
    const status = err?.message?.includes('existe déjà')
      ? 409
      : err?.message?.includes('introuvable')
        ? 404
        : 400
    return jsonError(c, status, err?.message || 'Renommage impossible')
  }
})

app.patch(
  '/api/zones/:id/verified',
  requireAuth,
  requireActiveTrial,
  async (c) => {
    try {
      const auth = c.get('auth')
      const id = Number(c.req.param('id'))
      const body = await c.req.json()
      const zone = await setZoneVerified(
        auth.pharmacyId,
        id,
        body?.is_verified ?? body?.isVerified,
      )
      return c.json({ zone })
    } catch (err) {
      const status = err?.message?.includes('introuvable') ? 404 : 400
      return jsonError(c, status, err?.message || 'Mise à jour impossible')
    }
  },
)

app.post(
  '/api/zones/reset-verification',
  requireAuth,
  requireActiveTrial,
  async (c) => {
    try {
      const auth = c.get('auth')
      const result = await resetAllZonesVerified(auth.pharmacyId)
      return c.json(result)
    } catch (err) {
      return jsonError(c, 400, err?.message || 'Réinitialisation impossible')
    }
  },
)

app.delete('/api/zones/:id', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const id = Number(c.req.param('id'))
    await deleteZone(auth.pharmacyId, id)
    return c.json({ ok: true })
  } catch (err) {
    const status = err?.message?.includes('introuvable')
      ? 404
      : err?.message?.includes('Impossible de supprimer')
        ? 409
        : 400
    return jsonError(c, status, err?.message || 'Suppression impossible')
  }
})

app.get('/api/scans/search', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const q = c.req.query('q') || ''
    const zoneRaw = c.req.query('zoneId')
    const zoneId =
      zoneRaw == null || zoneRaw === '' || zoneRaw === 'all'
        ? null
        : Number(zoneRaw)
    const laboratoire = c.req.query('laboratoire') || ''
    const limit = Number(c.req.query('limit') || 100)
    const items = await searchScans(auth.pharmacyId, {
      q,
      zoneId: Number.isFinite(zoneId) ? zoneId : null,
      laboratoire,
      limit: Number.isFinite(limit) ? limit : 100,
    })
    return c.json({ items })
  } catch (err) {
    return jsonError(c, 400, err?.message || 'Recherche impossible')
  }
})

app.get('/api/laboratoires', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const laboratoires = await listLaboratoires(auth.pharmacyId)
    return c.json({ laboratoires })
  } catch (err) {
    return jsonError(c, 400, err?.message || 'Chargement impossible')
  }
})

app.get('/api/expiry-checks', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const year = Number(c.req.query('year'))
    const month = Number(c.req.query('month'))
    const zoneRaw = c.req.query('zoneId')
    const zoneId =
      zoneRaw == null || zoneRaw === '' || zoneRaw === 'all'
        ? null
        : Number(zoneRaw)
    const status = c.req.query('status') || 'unverified'
    const sort = c.req.query('sort') || 'date'
    const items = await listExpiryChecks(auth.pharmacyId, {
      year,
      month,
      zoneId: Number.isFinite(zoneId) ? zoneId : null,
      status,
      sort,
    })
    return c.json({ items })
  } catch (err) {
    return jsonError(c, 400, err?.message || 'Chargement impossible')
  }
})

app.patch('/api/scans/:id/verified', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const result = await setScanVerified(
      auth.pharmacyId,
      c.req.param('id'),
      Boolean(body?.is_verified ?? body?.isVerified),
    )
    return c.json(result)
  } catch (err) {
    const status = err?.message?.includes('introuvable') ? 404 : 400
    return jsonError(c, status, err?.message || 'Mise à jour impossible')
  }
})

app.post('/api/scans', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    const scan = await saveScan(auth.pharmacyId, {
      gtin: body?.gtin,
      nomProduit: body?.nomProduit ?? body?.nom_produit,
      datePeremption: body?.datePeremption ?? body?.date_peremption,
      zoneId: body?.zoneId ?? body?.zone_id,
      typeProduit: body?.typeProduit ?? body?.type_produit ?? 'inconnu',
      nomManuel: Boolean(body?.nomManuel ?? body?.nom_manuel),
    })
    return c.json({ ok: true, scan }, 201)
  } catch (err) {
    return jsonError(c, 400, err?.message || 'Enregistrement impossible')
  }
})

app.delete('/api/scans/:id', requireAuth, requireActiveTrial, async (c) => {
  try {
    const auth = c.get('auth')
    const result = await deleteScan(auth.pharmacyId, c.req.param('id'))
    return c.json({ ok: true, ...result })
  } catch (err) {
    const status = err?.message?.includes('introuvable') ? 404 : 400
    return jsonError(c, status, err?.message || 'Suppression impossible')
  }
})

app.get(
  '/api/team/users',
  requireAuth,
  requireActiveTrial,
  requireAdmin,
  async (c) => {
    try {
      const auth = c.get('auth')
      const users = await listTeamMembers(auth.pharmacyId)
      return c.json({ users })
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 500
      return jsonError(c, status, err?.message || 'Chargement impossible')
    }
  },
)

app.post(
  '/api/team/users',
  requireAuth,
  requireActiveTrial,
  requireAdmin,
  async (c) => {
    try {
      const auth = c.get('auth')
      const body = await c.req.json()
      const result = await createTeamMember(auth.pharmacyId, {
        email: body?.email,
        nom: body?.nom ?? body?.name,
        role: body?.role,
        password: body?.password,
      })
      return c.json(result, 201)
    } catch (err) {
      console.error('[api/team/users POST]', err)
      const status = err instanceof AuthError ? err.status : 500
      return jsonError(c, status, err?.message || 'Création impossible')
    }
  },
)

app.patch(
  '/api/team/users/:id',
  requireAuth,
  requireActiveTrial,
  requireAdmin,
  async (c) => {
    try {
      const auth = c.get('auth')
      const body = await c.req.json()
      const user = await updateTeamMember(
        auth.pharmacyId,
        auth.userId,
        c.req.param('id'),
        {
          nom: body?.nom ?? body?.name,
          role: body?.role,
          password: body?.password,
        },
      )
      return c.json({ user })
    } catch (err) {
      console.error('[api/team/users PATCH]', err)
      const status = err instanceof AuthError ? err.status : 500
      return jsonError(c, status, err?.message || 'Mise à jour impossible')
    }
  },
)

app.delete(
  '/api/team/users/:id',
  requireAuth,
  requireActiveTrial,
  requireAdmin,
  async (c) => {
    try {
      const auth = c.get('auth')
      await deleteTeamMember(auth.pharmacyId, auth.userId, c.req.param('id'))
      return c.json({ ok: true })
    } catch (err) {
      console.error('[api/team/users DELETE]', err)
      const status = err instanceof AuthError ? err.status : 500
      return jsonError(c, status, err?.message || 'Suppression impossible')
    }
  },
)

app.onError((err, c) => {
  console.error('[api]', err)
  return jsonError(c, 500, err?.message || 'Erreur serveur')
})

export default app
