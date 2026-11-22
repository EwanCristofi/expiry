/**
 * Tests du runner migrateSessionVersion (sans connexion Neon).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import {
  CONFIRM_VALUE,
  DEFAULT_SQL_FILE,
  parseDatabaseTarget,
  requireDatabaseUrl,
  requireMigrationConfirm,
  runSessionVersionMigration,
  splitSqlStatements,
} from './migrateSessionVersion.js'

describe('migrateSessionVersion — garde-fous', () => {
  it('exige DATABASE_URL', () => {
    assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL manquante/)
  })

  it('exige CONFIRM=SESSION_VERSION', () => {
    assert.throws(
      () => requireMigrationConfirm({ CONFIRM: 'YES' }),
      /Confirmation refusée/,
    )
    assert.doesNotThrow(() =>
      requireMigrationConfirm({ CONFIRM: CONFIRM_VALUE }),
    )
  })

  it('parse la cible sans secrets', () => {
    const target = parseDatabaseTarget(
      'postgresql://u:secret@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    )
    assert.deepEqual(target, {
      hostname: 'ep-x.eu-central-1.aws.neon.tech',
      database: 'neondb',
    })
    assert.doesNotMatch(JSON.stringify(target), /secret/)
  })

  it('refuse sans confirmation (aucune requête)', async () => {
    let queried = false
    await assert.rejects(
      () =>
        runSessionVersionMigration({
          env: {
            DATABASE_URL:
              'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb',
          },
          createClient: () => ({
            query: () => {
              queried = true
            },
            transaction: async () => {
              queried = true
            },
          }),
          log: () => {},
          error: () => {},
        }),
      /Confirmation refusée/,
    )
    assert.equal(queried, false)
  })

  it('SQL 011 : colonne session_version idempotente', () => {
    const raw = fs.readFileSync(DEFAULT_SQL_FILE, 'utf8')
    const stmts = splitSqlStatements(raw)
    assert.ok(stmts.length >= 2)
    assert.match(raw, /ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0/i)
    assert.match(raw, /SET session_version = 0\s+WHERE session_version IS NULL/i)
    assert.match(raw, /COMMENT ON COLUMN users\.session_version/i)
  })

  it('exécute avec CONFIRM (client mock)', async () => {
    /** @type {string[]} */
    const executed = []
    const result = await runSessionVersionMigration({
      env: {
        DATABASE_URL:
          'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb',
        CONFIRM: CONFIRM_VALUE,
      },
      createClient: () => ({
        query: (statement) => {
          executed.push(statement)
          return statement
        },
        transaction: async (queries) => {
          for (const q of queries) {
            // neon transaction receives QueryResultPromise-like entries
            void q
          }
        },
      }),
      log: () => {},
      error: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.target.hostname, 'ep-x.eu-central-1.aws.neon.tech')
    assert.ok(result.statementCount >= 2)
  })
})
