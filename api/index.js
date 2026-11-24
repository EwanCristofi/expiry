import app from '../server/app.js'
import {
  classifyHttpError,
  logHttpError,
} from '../server/httpError.js'

/**
 * Runtime Node.js (requis pour bcryptjs → module `crypto`).
 *
 * Vercel appelle les fonctions Node avec `(IncomingMessage, ServerResponse)`,
 * pas une Web `Request`. On convertit explicitement pour Hono/CORS.
 */
export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Request>}
 */
async function toWebRequest(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const url = `${proto}://${host}${req.url || '/'}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || key === 'http2-settings') continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.set(key, value)
    }
  }

  const method = (req.method || 'GET').toUpperCase()
  /** @type {RequestInit} */
  const init = { method, headers }

  if (method !== 'GET' && method !== 'HEAD') {
    const body = await readBody(req)
    if (body.length > 0) {
      init.body = body
      // Node fetch forbids duplex without this for streams; Buffer is fine as body.
    }
  }

  return new Request(url, init)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 */
async function sendWebResponse(res, response) {
  res.statusCode = response.status

  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    res.setHeader(key, value)
  })

  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  res.end(buffer)
}

/**
 * Handler Vercel Node : IncomingMessage → Web Request → Hono → ServerResponse.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export default async function handler(req, res) {
  try {
    // Déjà une Web Request (certains runtimes / tests locaux)
    if (typeof Request !== 'undefined' && req instanceof Request) {
      const response = await app.fetch(req)
      return response
    }

    const request = await toWebRequest(req)
    const response = await app.fetch(request)
    await sendWebResponse(res, response)
  } catch (err) {
    const classified = classifyHttpError(err)
    logHttpError('api/vercel', err, classified)
    if (!res.headersSent) {
      res.statusCode = classified.status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: classified.message }))
    }
  }
}
