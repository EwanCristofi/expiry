import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

export const CONFIRM_VALUE = 'RESET_TOKEN_HASH'
export const REQUIRED_CONFIRM_ENV = 'CONFIRM'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SQL_FILE = path.join(
  __dirname,
  '..',
  'sql',
  '009_reset_token_hash.sql',
)

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireDatabaseUrl(env = process.env) {
  const raw = env.DATABASE_URL
  if (raw == null || String(raw).trim() === '') {
    throw new Error(
      'DATABASE_URL manquante. Définissez-la (jamais via une variable VITE_*).',
    )
  }
  return String(raw).trim()
}

/**
 * Extrait hostname + nom de base uniquement (jamais user/password/query/URL complète).
 * @param {string} databaseUrl
 * @returns {{ hostname: string, database: string }}
 */
export function parseDatabaseTarget(databaseUrl) {
  let parsed
  try {
    parsed = new URL(String(databaseUrl ?? '').trim())
  } catch {
    throw new Error(
      'DATABASE_URL malformée : URL PostgreSQL absolue attendue (postgresql://…).',
    )
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error(
      'DATABASE_URL malformée : protocole postgres/postgresql attendu.',
    )
  }

  const hostname = String(parsed.hostname || '').trim()
  const database = String(parsed.pathname || '')
    .replace(/^\//, '')
    .split('/')[0]
    .trim()

  if (!hostname || !database) {
    throw new Error(
      'DATABASE_URL malformée : hostname et nom de base obligatoires.',
    )
  }

  return { hostname, database }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function requireMigrationConfirm(env = process.env) {
  const value = env[REQUIRED_CONFIRM_ENV]
  if (value !== CONFIRM_VALUE) {
    throw new Error(
      `Confirmation refusée : définissez ${REQUIRED_CONFIRM_ENV}=${CONFIRM_VALUE} pour exécuter cette migration. Aucune requête SQL n’a été envoyée.`,
    )
  }
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function splitSqlStatements(raw) {
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  const statements = []
  let current = ''

  for (const line of withoutBlockComments.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('--')) continue
    current += `${line}\n`
    if (trimmed.endsWith(';')) {
      const stmt = current.trim()
      if (stmt) statements.push(stmt)
      current = ''
    }
  }

  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   sqlFile?: string,
 *   readSqlFile?: (filePath: string) => string,
 *   createClient?: (databaseUrl: string) => { query: Function, transaction: Function },
 *   log?: (...args: unknown[]) => void,
 *   error?: (...args: unknown[]) => void,
 * }} [options]
 */
export async function runResetTokenHashMigration(options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  const error = options.error ?? console.error
  const sqlFile = options.sqlFile ?? DEFAULT_SQL_FILE
  const readSqlFile = options.readSqlFile ?? ((p) => fs.readFileSync(p, 'utf8'))

  const databaseUrl = requireDatabaseUrl(env)
  const target = parseDatabaseTarget(databaseUrl)

  log('⏳ Migration reset tokens → SHA-256 only (clear plaintext leftovers)')
  log(`   Cible : host=${target.hostname} database=${target.database}`)
  log(
    '   Action : NULL sur users.reset_token / reset_token_expires si présents ; COMMENT sur la colonne.',
  )
  log('   Impact : liens de reset en cours invalidés ; comptes / mots de passe inchangés.')

  requireMigrationConfirm(env)

  log(`✓ Confirmation ${REQUIRED_CONFIRM_ENV}=${CONFIRM_VALUE} acceptée`)

  const raw = readSqlFile(sqlFile)
  const statements = splitSqlStatements(raw)
  if (statements.length === 0) {
    throw new Error('Fichier SQL de migration vide ou sans instruction exécutable')
  }

  const createClient =
    options.createClient ?? ((url) => neon(url))
  const sql = createClient(databaseUrl)

  // @neondatabase/serverless (HTTP) : transactions non-interactives via
  // sql.transaction([ sql.query(...), ... ]) — pas de BEGIN/COMMIT manuels.
  try {
    await sql.transaction(statements.map((statement) => sql.query(statement)))
  } catch (err) {
    const message = err?.message || String(err)
    error('❌ Migration échouée (transaction annulée si supportée par Neon HTTP):')
    error(`   ${message}`)
    throw new Error(`Migration reset_token_hash échouée : ${message}`)
  }

  log('✓ UPDATE + COMMENT exécutés dans une transaction Neon HTTP')
  log('✅ Migration terminée — le code applicatif doit stocker des hashes')
  return { ok: true, target, statementCount: statements.length }
}

function loadEnvFiles() {
  dotenv.config({ path: '.env.local' })
  dotenv.config({ path: '.env' })
}

async function main() {
  loadEnvFiles()
  try {
    await runResetTokenHashMigration()
  } catch (err) {
    console.error(`❌ ${err?.message || err}`)
    process.exit(1)
  }
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  main()
}
