/**
 * Tests du runner migrateUsersIsActive (sans connexion Neon).
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
  runUsersIsActiveMigration,
  splitSqlStatements,
} from './migrateUsersIsActive.js'

describe('migrateUsersIsActive — garde-fous', () => {
  it('exige DATABASE_URL', () => {
    assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL manquante/)
    assert.throws(
      () => requireDatabaseUrl({ VITE_DATABASE_URL: 'postgresql://u:p@h/db' }),
      /DATABASE_URL manquante/,
    )
  })

  it('exige CONFIRM=USERS_IS_ACTIVE', () => {
    assert.throws(
      () => requireMigrationConfirm({ CONFIRM: 'YES' }),
      /Confirmation refusée/,
    )
    assert.throws(
      () => requireMigrationConfirm({ CONFIRM: 'SESSION_VERSION' }),
      /Confirmation refusée/,
    )
    assert.doesNotThrow(() =>
      requireMigrationConfirm({ CONFIRM: CONFIRM_VALUE }),
    )
    assert.equal(CONFIRM_VALUE, 'USERS_IS_ACTIVE')
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
        runUsersIsActiveMigration({
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

  it('SQL 012 : colonne is_active idempotente, comptes restent actifs', () => {
    const raw = fs.readFileSync(DEFAULT_SQL_FILE, 'utf8')
    const stmts = splitSqlStatements(raw)
    assert.ok(stmts.length >= 2)
    assert.match(
      raw,
      /ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true/i,
    )
    assert.match(raw, /ALTER COLUMN is_active SET DEFAULT true/i)
    assert.match(raw, /SET is_active = true\s+WHERE is_active IS NULL/i)
    assert.match(raw, /ALTER COLUMN is_active SET NOT NULL/i)
    assert.match(raw, /COMMENT ON COLUMN users\.is_active/i)
    assert.doesNotMatch(raw, /DROP COLUMN/i)
    for (const stmt of stmts) {
      assert.doesNotMatch(stmt, /is_active\s*=\s*false/i)
      assert.doesNotMatch(stmt, /SET\s+is_active\s*=\s*false/i)
    }
  })

  it('exécute avec CONFIRM (client mock)', async () => {
    /** @type {string[]} */
    const executed = []
    const logs = []
    const result = await runUsersIsActiveMigration({
      env: {
        DATABASE_URL:
          'postgresql://u:secret@ep-x.eu-central-1.aws.neon.tech/neondb',
        CONFIRM: CONFIRM_VALUE,
      },
      createClient: () => ({
        query: (statement) => {
          executed.push(statement)
          return statement
        },
        transaction: async (queries) => {
          for (const q of queries) {
            void q
          }
        },
      }),
      log: (...args) => {
        logs.push(args.map(String).join(' '))
      },
      error: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.target.hostname, 'ep-x.eu-central-1.aws.neon.tech')
    assert.ok(result.statementCount >= 2)
    const joinedLogs = logs.join('\n')
    assert.doesNotMatch(joinedLogs, /secret/)
    assert.doesNotMatch(joinedLogs, /postgresql:\/\//)
    assert.match(joinedLogs, /host=ep-x\.eu-central-1\.aws\.neon\.tech/)
  })
})
