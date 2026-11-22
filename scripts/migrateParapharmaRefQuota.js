import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import dotenv from 'dotenv'

export const CONFIRM_VALUE = 'PARAPHARMA_REF_QUOTA'
export const REQUIRED_CONFIRM_ENV = 'CONFIRM'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SQL_FILE = path.join(
  __dirname,
  '..',
  'sql',
  '010_parapharma_ref_quota.sql',
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
 * Découpe un script SQL en instructions, en respectant les chaînes `'…'`
 * et les dollar-quotes `$tag$…$tag$` (nécessaire pour PL/pgSQL).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitSqlStatements(raw) {
  const withoutBlockComments = String(raw ?? '').replace(/\/\*[\s\S]*?\*\//g, '\n')
  const statements = []
  let current = ''
  /** @type {string | null} */
  let dollarTag = null
  let inSingleQuote = false

  const lines = withoutBlockComments.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (dollarTag == null && !inSingleQuote && trimmed.startsWith('--')) {
      continue
    }

    current += `${line}\n`

    let idx = 0
    while (idx < line.length) {
      if (dollarTag != null) {
        const close = line.indexOf(dollarTag, idx)
        if (close === -1) break
        idx = close + dollarTag.length
        dollarTag = null
        continue
      }

      const ch = line[idx]

      if (inSingleQuote) {
        if (ch === "'" ) {
          if (line[idx + 1] === "'") {
            idx += 2
            continue
          }
          inSingleQuote = false
        }
        idx += 1
        continue
      }

      if (ch === '-' && line[idx + 1] === '-') {
        break
      }

      if (ch === "'") {
        inSingleQuote = true
        idx += 1
        continue
      }

      if (ch === '$') {
        const match = line.slice(idx).match(/^(\$[A-Za-z0-9_]*\$)/)
        if (match) {
          dollarTag = match[1]
          idx += match[1].length
          continue
        }
      }

      idx += 1
    }

    if (dollarTag == null && !inSingleQuote && trimmed.endsWith(';')) {
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
export async function runParapharmaRefQuotaMigration(options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? console.log
  const error = options.error ?? console.error
  const sqlFile = options.sqlFile ?? DEFAULT_SQL_FILE
  const readSqlFile = options.readSqlFile ?? ((p) => fs.readFileSync(p, 'utf8'))

  const databaseUrl = requireDatabaseUrl(env)
  const target = parseDatabaseTarget(databaseUrl)

  log('⏳ Migration quota parapharma_ref (ledger + try_create_parapharma_ref)')
  log(`   Cible : host=${target.hostname} database=${target.database}`)
  log('   Action : CREATE TABLE ledger + CREATE FUNCTION (pas de backfill)')
  log('   Impact : aucune modification des références historiques')

  requireMigrationConfirm(env)
  log(`✓ Confirmation ${REQUIRED_CONFIRM_ENV}=${CONFIRM_VALUE} acceptée`)

  const raw = readSqlFile(sqlFile)
  const statements = splitSqlStatements(raw)
  if (statements.length === 0) {
    throw new Error('Fichier SQL de migration vide ou sans instruction exécutable')
  }

  const createClient = options.createClient ?? ((url) => neon(url))
  const sql = createClient(databaseUrl)

  try {
    // Neon HTTP : transaction non-interactive. CREATE FUNCTION doit rester
    // une seule instruction (dollar-quotes gérées par splitSqlStatements).
    await sql.transaction(statements.map((statement) => sql.query(statement)))
  } catch (err) {
    const message = err?.message || String(err)
    error('❌ Migration échouée (transaction annulée si supportée par Neon HTTP):')
    error(`   ${message}`)
    throw new Error(`Migration parapharma_ref_quota échouée : ${message}`)
  }

  log(`✓ ${statements.length} instruction(s) exécutée(s)`)
  log('✅ Migration terminée — déployer le code saveScan qui appelle try_create_parapharma_ref')
  return { ok: true, target, statementCount: statements.length }
}

function loadEnvFiles() {
  dotenv.config({ path: '.env.local' })
  dotenv.config({ path: '.env' })
}

async function main() {
  loadEnvFiles()
  try {
    await runParapharmaRefQuotaMigration()
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
