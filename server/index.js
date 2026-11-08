import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import dotenv from 'dotenv'
import {
  TOKEN_COOKIE,
  authenticateUser,
  getUserProfile,
  readBearerToken,
  signToken,
  verifyToken,
} from './auth.js'
import {
  createZone,
  deleteZone,
  listExpiryChecks,
  listZones,
  renameZone,
  resolveProductName,
  saveScan,
  setScanVerified,
} from './productLogic.js'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const app = new Hono()
const port = Number(process.env.API_PORT || 8787)
const isProd = process.env.NODE_ENV === 'production'

app.use(
  '*',
  cors({
    origin: (origin) => origin || 'http://localhost:5173',
    credentials: true,
  }),
)

function jsonError(c, status, message) {
  return c.json({ error: message }, status)
}

/**
 * @param {import('hono').Context} c
 */
async function requireAuth(c, next) {
  const bearer = readBearerToken(c.req.header('Authorization'))
  const cookieToken = getCookie(c, TOKEN_COOKIE)
  const session = await verifyToken(bearer || cookieToken)
  if (!session) {
    return jsonError(c, 401, 'Non authentifié')
  }
  c.set('auth', session)
  await next()
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.post('/api/auth/login', async (c) => {
  try {
    const body = await c.req.json()
    const user = await authenticateUser(body?.email, body?.password)
    const token = await signToken(user)
    setCookie(c, TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProd,
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })
    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        role: user.role,
        pharmacy_id: user.pharmacy_id,
        pharmacy: user.pharmacy,
      },
    })
  } catch (err) {
    return jsonError(c, 401, err?.message || 'Connexion impossible')
  }
})

app.post('/api/auth/logout', async (c) => {
  deleteCookie(c, TOKEN_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/auth/me', requireAuth, async (c) => {
  const auth = c.get('auth')
  const profile = await getUserProfile(auth.userId)
  if (!profile) return jsonError(c, 401, 'Session invalide')
  return c.json({ user: profile })
})

app.get('/api/products/resolve', requireAuth, async (c) => {
  const code = c.req.query('code')
  const resolved = await resolveProductName(code)
  return c.json({ product: resolved })
})

app.get('/api/zones', requireAuth, async (c) => {
  const auth = c.get('auth')
  const zones = await listZones(auth.pharmacyId)
  return c.json({ zones })
})

app.post('/api/zones', requireAuth, async (c) => {
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

app.patch('/api/zones/:id', requireAuth, async (c) => {
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

app.delete('/api/zones/:id', requireAuth, async (c) => {
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

app.get('/api/expiry-checks', requireAuth, async (c) => {
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

app.patch('/api/scans/:id/verified', requireAuth, async (c) => {
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

app.post('/api/scans', requireAuth, async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json()
    await saveScan(auth.pharmacyId, {
      gtin: body?.gtin,
      nomProduit: body?.nomProduit ?? body?.nom_produit,
      datePeremption: body?.datePeremption ?? body?.date_peremption,
      zoneId: body?.zoneId ?? body?.zone_id,
      typeProduit: body?.typeProduit ?? body?.type_produit ?? 'inconnu',
      nomManuel: Boolean(body?.nomManuel ?? body?.nom_manuel),
    })
    return c.json({ ok: true }, 201)
  } catch (err) {
    return jsonError(c, 400, err?.message || 'Enregistrement impossible')
  }
})

app.onError((err, c) => {
  console.error('[api]', err)
  return jsonError(c, 500, err?.message || 'Erreur serveur')
})

console.log(`API Expiry sur http://localhost:${port}`)
serve({ fetch: app.fetch, port })
