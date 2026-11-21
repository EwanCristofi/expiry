/**
 * Tests du runner sécurisé migrateResetTokenHash (sans connexion Neon).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONFIRM_VALUE,
  parseDatabaseTarget,
  requireDatabaseUrl,
  requireMigrationConfirm,
  runResetTokenHashMigration,
  splitSqlStatements,
} from './migrateResetTokenHash.js'

const SAMPLE_SQL = `
-- comment
UPDATE users SET reset_token = NULL WHERE reset_token IS NOT NULL;
COMMENT ON COLUMN users.reset_token IS 'SHA-256';
`

function createSpyClient() {
  const calls = {
    query: [],
    transaction: [],
  }
  const client = {
    query(statement) {
      calls.query.push(statement)
      return { __query: statement }
    },
    async transaction(queries) {
      calls.transaction.push(queries)
      return queries.map(() => [])
    },
  }
  return { client, calls }
}

describe('requireDatabaseUrl', () => {
  it('arrête si DATABASE_URL est absente', () => {
    assert.throws(
      () => requireDatabaseUrl({}),
      (err) => {
        assert.match(err.message, /DATABASE_URL manquante/)
        assert.doesNotMatch(err.message, /VITE_NEON_DATABASE_URL/)
        return true
      },
    )
  })

  it('ignore VITE_NEON_DATABASE_URL', () => {
    assert.throws(
      () =>
        requireDatabaseUrl({
          VITE_NEON_DATABASE_URL: 'postgresql://u:p@host/db',
        }),
      /DATABASE_URL manquante/,
    )
  })

  it('accepte DATABASE_URL seule', () => {
    assert.equal(
      requireDatabaseUrl({
        DATABASE_URL: '  postgresql://u:p@host/db  ',
      }),
      'postgresql://u:p@host/db',
    )
  })
})

describe('parseDatabaseTarget', () => {
  it('extrait hostname et database sans secrets', () => {
    const target = parseDatabaseTarget(
      'postgresql://neon_user:s3cret@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    )
    assert.deepEqual(target, {
      hostname: 'ep-cool-name.eu-central-1.aws.neon.tech',
      database: 'neondb',
    })
    const serialized = JSON.stringify(target)
    assert.doesNotMatch(serialized, /neon_user/)
    assert.doesNotMatch(serialized, /s3cret/)
    assert.doesNotMatch(serialized, /sslmode/)
    assert.doesNotMatch(serialized, /postgresql:\/\//)
  })

  it('refuse une URL malformée', () => {
    assert.throws(() => parseDatabaseTarget('not-a-url'), /malformée/)
    assert.throws(() => parseDatabaseTarget('https://example.com/db'), /protocole/)
    assert.throws(() => parseDatabaseTarget('postgresql:///'), /hostname/)
  })
})

describe('requireMigrationConfirm', () => {
  it('refuse si CONFIRM absente', () => {
    assert.throws(() => requireMigrationConfirm({}), /Confirmation refusée/)
  })

  it('refuse si CONFIRM incorrecte', () => {
    assert.throws(
      () => requireMigrationConfirm({ CONFIRM: 'yes' }),
      /Confirmation refusée/,
    )
  })

  it('accepte CONFIRM=RESET_TOKEN_HASH', () => {
    assert.doesNotThrow(() =>
      requireMigrationConfirm({ CONFIRM: CONFIRM_VALUE }),
    )
  })
})

describe('runResetTokenHashMigration — garde-fous', () => {
  it('CONFIRM absente : aucune requête SQL', async () => {
    const { client, calls } = createSpyClient()
    const logs = []
    let clientCreated = false

    await assert.rejects(
      () =>
        runResetTokenHashMigration({
          env: {
            DATABASE_URL:
              'postgresql://u:p@ep-dev.example.neon.tech/expiry_dev',
          },
          createClient: () => {
            clientCreated = true
            return client
          },
          readSqlFile: () => SAMPLE_SQL,
          log: (...args) => logs.push(args.join(' ')),
        }),
      /Confirmation refusée/,
    )

    assert.equal(clientCreated, false)
    assert.equal(calls.transaction.length, 0)
    assert.equal(calls.query.length, 0)
    assert.ok(logs.some((line) => line.includes('host=ep-dev.example.neon.tech')))
    assert.ok(logs.some((line) => line.includes('database=expiry_dev')))
    assert.ok(logs.every((line) => !line.includes('postgresql://')))
    assert.ok(logs.every((line) => !line.includes(':p@')))
  })

  it('CONFIRM incorrecte : aucune requête SQL', async () => {
    const { client, calls } = createSpyClient()

    await assert.rejects(
      () =>
        runResetTokenHashMigration({
          env: {
            DATABASE_URL: 'postgresql://u:p@host.example/db',
            CONFIRM: 'RESET_TOKEN',
          },
          createClient: () => client,
          readSqlFile: () => SAMPLE_SQL,
          log: () => {},
        }),
      /Confirmation refusée/,
    )

    assert.equal(calls.transaction.length, 0)
  })

  it('DATABASE_URL absente : arrêt avant SQL', async () => {
    const { client, calls } = createSpyClient()
    await assert.rejects(
      () =>
        runResetTokenHashMigration({
          env: { CONFIRM: CONFIRM_VALUE },
          createClient: () => client,
          readSqlFile: () => SAMPLE_SQL,
          log: () => {},
        }),
      /DATABASE_URL manquante/,
    )
    assert.equal(calls.transaction.length, 0)
  })

  it('DATABASE_URL malformée : arrêt avant SQL', async () => {
    const { client, calls } = createSpyClient()
    await assert.rejects(
      () =>
        runResetTokenHashMigration({
          env: {
            DATABASE_URL: 'not-valid',
            CONFIRM: CONFIRM_VALUE,
          },
          createClient: () => client,
          readSqlFile: () => SAMPLE_SQL,
          log: () => {},
        }),
      /malformée/,
    )
    assert.equal(calls.transaction.length, 0)
  })

  it('ne démarre la migration SQL qu’après confirmation', async () => {
    const { client, calls } = createSpyClient()
    const logs = []
    let clientCreated = false

    const result = await runResetTokenHashMigration({
      env: {
        DATABASE_URL: 'postgresql://u:p@ep-prod.example.neon.tech/neondb',
        CONFIRM: CONFIRM_VALUE,
      },
      createClient: (url) => {
        clientCreated = true
        // Ne jamais laisser fuiter l’URL dans les asserts positifs ci-dessous
        assert.match(url, /^postgresql:\/\//)
        return client
      },
      readSqlFile: () => SAMPLE_SQL,
      log: (...args) => logs.push(args.join(' ')),
    })

    assert.equal(result.ok, true)
    assert.equal(clientCreated, true)
    assert.equal(calls.transaction.length, 1)
    assert.equal(calls.transaction[0].length, 2)

    const confirmIdx = logs.findIndex((l) =>
      l.includes(`Confirmation CONFIRM=${CONFIRM_VALUE} acceptée`),
    )
    const targetIdx = logs.findIndex((l) =>
      l.includes('host=ep-prod.example.neon.tech'),
    )
    assert.ok(targetIdx >= 0)
    assert.ok(confirmIdx > targetIdx)
    assert.ok(logs.every((line) => !line.includes('u:p@')))
    assert.ok(logs.every((line) => !/postgresql:\/\/[^\s]+/.test(line)))
  })
})

describe('splitSqlStatements', () => {
  it('ignore les commentaires et découpe les instructions', () => {
    const stmts = splitSqlStatements(SAMPLE_SQL)
    assert.equal(stmts.length, 2)
    assert.match(stmts[0], /^UPDATE/i)
    assert.match(stmts[1], /^COMMENT/i)
  })
})
