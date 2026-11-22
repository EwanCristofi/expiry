/**
 * Tests du runner migrateParapharmaRefQuota (sans connexion Neon).
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
  runParapharmaRefQuotaMigration,
  splitSqlStatements,
} from './migrateParapharmaRefQuota.js'

describe('requireDatabaseUrl / confirm', () => {
  it('exige DATABASE_URL', () => {
    assert.throws(() => requireDatabaseUrl({}), /DATABASE_URL manquante/)
  })

  it('exige CONFIRM=PARAPHARMA_REF_QUOTA', () => {
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
})

describe('splitSqlStatements (dollar-quotes PL/pgSQL)', () => {
  it('conserve le corps de fonction comme une seule instruction', () => {
    const raw = `
CREATE TABLE t (id int);
CREATE OR REPLACE FUNCTION f()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM 1;
  IF true THEN
    PERFORM 2;
  END IF;
END;
$fn$;
GRANT EXECUTE ON FUNCTION f() TO expiry_app;
`
    const stmts = splitSqlStatements(raw)
    assert.equal(stmts.length, 3)
    assert.match(stmts[0], /CREATE TABLE t/)
    assert.match(stmts[1], /CREATE OR REPLACE FUNCTION f/)
    assert.match(stmts[1], /PERFORM 1;/)
    assert.match(stmts[1], /\$fn\$;/)
    assert.match(stmts[2], /GRANT EXECUTE/)
  })

  it('découpe le fichier 010 réel en instructions exécutables', () => {
    const raw = fs.readFileSync(DEFAULT_SQL_FILE, 'utf8')
    const stmts = splitSqlStatements(raw)
    assert.ok(stmts.length >= 3)
    assert.ok(
      stmts.some((s) =>
        /CREATE TABLE IF NOT EXISTS public\.parapharma_ref_creations/i.test(s),
      ),
    )
    assert.ok(
      stmts.some((s) =>
        /CREATE OR REPLACE FUNCTION public\.try_create_parapharma_ref/i.test(s),
      ),
    )
    const fn = stmts.find(
      (s) =>
        /try_create_parapharma_ref/i.test(s) && /LANGUAGE plpgsql/i.test(s),
    )
    assert.ok(fn)
    assert.match(fn, /pg_advisory_xact_lock/)
    assert.match(fn, /ON CONFLICT \(gtin\) DO NOTHING/)
    assert.match(fn, /SECURITY\s+INVOKER/i)
    assert.match(fn, /SET\s+search_path\s*=\s*pg_catalog/i)
    assert.doesNotMatch(fn, /current_setting\s*\(\s*'app\.pharmacy_id'/i)
  })

  it('contrat source 010 : pas de GRANT INSERT ledger / EXECUTE expiry_app', () => {
    // Contrôle du texte de migration uniquement — pas une preuve de privileges Neon.
    const raw = fs.readFileSync(DEFAULT_SQL_FILE, 'utf8')
    assert.doesNotMatch(
      raw,
      /GRANT\s+[^;]*INSERT[^;]*parapharma_ref_creations[^;]*TO\s+expiry_app/i,
    )
    assert.doesNotMatch(
      raw,
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*try_create_parapharma_ref[^;]*TO\s+expiry_app/i,
    )
    assert.match(
      raw,
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.try_create_parapharma_ref[\s\S]*?FROM\s+PUBLIC/i,
    )
    assert.match(
      raw,
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.try_create_parapharma_ref[\s\S]*?FROM\s+expiry_app/i,
    )
    assert.match(
      raw,
      /REVOKE\s+INSERT\s*,\s*UPDATE\s+ON\s+TABLE\s+public\.parapharma_ref\s+FROM\s+expiry_app/i,
    )
  })
})

describe('runParapharmaRefQuotaMigration', () => {
  it('n’envoie aucune requête sans CONFIRM', async () => {
    let queried = false
    await assert.rejects(
      () =>
        runParapharmaRefQuotaMigration({
          env: { DATABASE_URL: 'postgresql://u:p@h/db' },
          log: () => {},
          error: () => {},
          createClient: () => ({
            query: () => {
              queried = true
            },
            transaction: async () => {
              queried = true
            },
          }),
        }),
      /Confirmation refusée/,
    )
    assert.equal(queried, false)
  })

  it('exécute les instructions en transaction Neon HTTP', async () => {
    const calls = { transaction: /** @type {unknown[]} */ ([]) }
    const result = await runParapharmaRefQuotaMigration({
      env: {
        DATABASE_URL: 'postgresql://u:p@h/db',
        CONFIRM: CONFIRM_VALUE,
      },
      log: () => {},
      error: () => {},
      readSqlFile: () => `
        CREATE TABLE IF NOT EXISTS parapharma_ref_creations (gtin TEXT PRIMARY KEY);
        CREATE OR REPLACE FUNCTION try_create_parapharma_ref()
        RETURNS void LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM 1;
        END;
        $fn$;
      `,
      createClient: () => {
        const client = {
          query(statement) {
            return { __query: statement }
          },
          async transaction(queries) {
            calls.transaction.push(queries)
            return queries.map(() => [])
          },
        }
        return client
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls.transaction.length, 1)
    assert.equal(/** @type {unknown[]} */ (calls.transaction[0]).length, 2)
  })
})
