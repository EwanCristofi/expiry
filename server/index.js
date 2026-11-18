import './loadEnv.js'
import { serve } from '@hono/node-server'
import app from './app.js'

const port = Number(process.env.API_PORT || 8787)

console.log(`API Expiry sur http://localhost:${port}`)
serve({ fetch: app.fetch, port })
