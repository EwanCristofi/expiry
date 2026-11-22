/**
 * Validation serveur de saveScan (GTIN + nomProduit) et non-régression parapharma_ref.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import {
  saveScan,
  setSaveScanDbForTests,
} from './productLogic.js'
import { PARAPHARMA_REF_STATUS } from './parapharmaRefQuota.js'

const PHARMACY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ZONE_ID = 1
const DATE = '2027-06-01'

/** @type {{ withPharmacy: number, sql: Array<{ text: string, values: unknown[] }>, scanValues: unknown[] | null }} */
let dbCalls

function joinSql(strings) {
  return Array.from(strings).join('?')
}

/**
 * Simule Neon : le tagged-template construit une requête ;
 * elle n'est « exécutée » que via withPharmacy ou await.
 * L'appel quota passe par `try_create_parapharma_ref` (mock ledger en mémoire).
 */
function installDbMock(options = {}) {
  const refStore = options.refStore ?? new Map()
  /** @type {Map<string, { pharmacyId: string, userId: string }>} */
  const ledger = options.ledger ?? new Map()
  const scanNomByCall = options.scanNomByCall ?? []
  const quotaLimit = options.quotaLimit ?? 100
  /** @type {((args: { gtin: string, pharmacyId: string }) => 'created' | 'already_exists' | 'quota_exceeded') | null} */
  const forceStatus = options.forceStatus ?? null

  dbCalls = { withPharmacy: 0, sql: [], scanValues: null }

  setSaveScanDbForTests({
    withPharmacy: async (_pharmacyId, queries) => {
      dbCalls.withPharmacy += 1
      const scanQuery = queries[0]
      dbCalls.scanValues = scanQuery?.values ?? null
      const nom =
        scanNomByCall.length > 0
          ? scanNomByCall.shift()
          : (options.defaultScanNom ??
            scanQuery?.values?.[1] ??
            'Produit test')
      return [
        [
          {
            id: '11111111-1111-4111-8111-111111111111',
            nom_produit: nom,
            date_peremption: DATE,
            quantite: 1,
          },
        ],
      ]
    },
    sql: Object.assign(
      (strings, ...values) => {
        const text = joinSql(strings)
        const query = {
          text,
          values,
          then(resolve, reject) {
            dbCalls.sql.push({ text, values })
            if (text.includes('try_create_parapharma_ref')) {
              const [gtin, nom, pharmacyId, userId, limit] = values
              if (forceStatus) {
                const status = forceStatus({ gtin, pharmacyId, userId, nom })
                return Promise.resolve([{ status, created: status === 'created' }]).then(
                  resolve,
                  reject,
                )
              }
              if (refStore.has(gtin)) {
                return Promise.resolve([
                  { status: 'already_exists', created: false },
                ]).then(resolve, reject)
              }
              const monthCount = [...ledger.values()].filter(
                (row) => row.pharmacyId === pharmacyId,
              ).length
              const max = Number(limit ?? quotaLimit)
              if (monthCount >= max) {
                return Promise.resolve([
                  { status: 'quota_exceeded', created: false },
                ]).then(resolve, reject)
              }
              refStore.set(gtin, nom)
              ledger.set(gtin, { pharmacyId, userId })
              return Promise.resolve([{ status: 'created', created: true }]).then(
                resolve,
                reject,
              )
            }
            return Promise.resolve([]).then(resolve, reject)
          },
        }
        return query
      },
      {
        query: () => {
          throw new Error('sql.query unexpected in saveScan tests')
        },
        transaction: () => {
          throw new Error('sql.transaction unexpected in saveScan tests')
        },
      },
    ),
  })

  return { refStore, ledger }
}

beforeEach(() => {
  installDbMock()
})

afterEach(() => {
  setSaveScanDbForTests(null)
})

async function expectRejection(payload, messagePattern) {
  dbCalls = { withPharmacy: 0, sql: [], scanValues: null }
  await assert.rejects(
    () =>
      saveScan(PHARMACY_ID, {
        datePeremption: DATE,
        zoneId: ZONE_ID,
        typeProduit: 'parapharma',
        userId: USER_ID,
        ...payload,
      }),
    messagePattern,
  )
  assert.equal(dbCalls.withPharmacy, 0, 'withPharmacy ne doit pas être appelé')
  assert.equal(dbCalls.sql.length, 0, 'sql ne doit pas être exécuté')
}

describe('saveScan — GTIN acceptés', () => {
  for (const gtin of [
    '12345670',
    '123456789012',
    '3400930000000',
    '01234567890128',
  ]) {
    it(`accepte ${gtin.length} chiffres (${gtin})`, async () => {
      const result = await saveScan(PHARMACY_ID, {
        gtin,
        nomProduit: 'Crème hydratante',
        datePeremption: DATE,
        zoneId: ZONE_ID,
        typeProduit: 'parapharma',
        nomManuel: true,
        userId: USER_ID,
      })
      assert.equal(result.id, '11111111-1111-4111-8111-111111111111')
      assert.equal(result.parapharma_ref_status, PARAPHARMA_REF_STATUS.CREATED)
      assert.equal(dbCalls.withPharmacy, 1)
      assert.equal(dbCalls.scanValues[0], gtin)
      assert.equal(dbCalls.sql.length, 1)
      assert.equal(dbCalls.sql[0].values[0], gtin)
      assert.match(dbCalls.sql[0].text, /try_create_parapharma_ref/)
    })
  }

  it('normalise les espaces autour du GTIN', async () => {
    await saveScan(PHARMACY_ID, {
      gtin: '  3400930000000  ',
      nomProduit: 'Test',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(dbCalls.withPharmacy, 1)
    assert.equal(dbCalls.scanValues[0], '3400930000000')
    assert.equal(dbCalls.sql[0].values[0], '3400930000000')
  })
})

describe('saveScan — GTIN rejetés', () => {
  it('rejette une chaîne vide', async () => {
    await expectRejection({ gtin: '' }, /GTIN invalide/)
  })

  it('rejette des espaces seuls', async () => {
    await expectRejection({ gtin: '   ' }, /GTIN invalide/)
  })

  it('rejette des lettres', async () => {
    await expectRejection({ gtin: '340093000000A' }, /GTIN invalide/)
  })

  it('rejette des caractères spéciaux', async () => {
    await expectRejection({ gtin: '34009300-0000' }, /GTIN invalide/)
  })

  it('rejette 7 chiffres', async () => {
    await expectRejection({ gtin: '1234567' }, /GTIN invalide/)
  })

  it('rejette 9 chiffres', async () => {
    await expectRejection({ gtin: '123456789' }, /GTIN invalide/)
  })

  it('rejette 11 chiffres', async () => {
    await expectRejection({ gtin: '12345678901' }, /GTIN invalide/)
  })

  it('rejette 15 chiffres', async () => {
    await expectRejection({ gtin: '123456789012345' }, /GTIN invalide/)
  })

  it('rejette un nombre JSON', async () => {
    await expectRejection({ gtin: 3400930000000 }, /chaîne de caractères/)
  })

  it('rejette null', async () => {
    await expectRejection({ gtin: null }, /chaîne de caractères/)
  })

  it('rejette une valeur absente', async () => {
    await expectRejection({}, /chaîne de caractères/)
  })
})

describe('saveScan — noms', () => {
  it('accepte un nom avec accents', async () => {
    const { refStore } = installDbMock()
    const result = await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: 'Crème hydratée été',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(result.nom_produit, 'Crème hydratée été')
    assert.equal(refStore.get('3400930000000'), 'Crème hydratée été')
  })

  it('applique trim sur le nom', async () => {
    const { refStore } = installDbMock()
    await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: '  Produit trim  ',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(dbCalls.scanValues[1], 'Produit trim')
    assert.equal(refStore.get('3400930000000'), 'Produit trim')
  })

  it('rejette un nom vide avec nomManuel', async () => {
    await expectRejection(
      {
        gtin: '3400930000000',
        nomProduit: '',
        nomManuel: true,
        typeProduit: 'parapharma',
      },
      /obligatoire/,
    )
  })

  it('rejette un nom uniquement espaces avec nomManuel', async () => {
    await expectRejection(
      {
        gtin: '3400930000000',
        nomProduit: '   ',
        nomManuel: true,
        typeProduit: 'inconnu',
      },
      /obligatoire/,
    )
  })

  it('accepte un nom de 255 caractères', async () => {
    const nom = 'é'.repeat(255)
    installDbMock()
    await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: nom,
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(dbCalls.sql[0].values[1], nom)
  })

  it('rejette un nom de 256 caractères', async () => {
    await expectRejection(
      {
        gtin: '3400930000000',
        nomProduit: 'a'.repeat(256),
        nomManuel: true,
        typeProduit: 'parapharma',
      },
      /255/,
    )
  })

  it('rejette une valeur non textuelle', async () => {
    await expectRejection(
      {
        gtin: '3400930000000',
        nomProduit: { label: 'x' },
        nomManuel: false,
      },
      /chaîne de caractères/,
    )
  })

  it('rejette un manuel sans userId', async () => {
    await expectRejection(
      {
        gtin: '3400930000000',
        nomProduit: 'Produit',
        nomManuel: true,
        typeProduit: 'parapharma',
        userId: null,
      },
      /utilisateur manquant/,
    )
  })
})

describe('saveScan — non-régression', () => {
  it('autorise un scan non manuel sans nom', async () => {
    installDbMock({ defaultScanNom: null })
    const result = await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'medicament',
      nomManuel: false,
    })
    assert.equal(result.id, '11111111-1111-4111-8111-111111111111')
    assert.equal(dbCalls.withPharmacy, 1)
    assert.equal(dbCalls.sql.length, 0)
    assert.equal(dbCalls.scanValues[1], undefined)
    assert.equal(result.parapharma_ref_status, null)
    assert.deepEqual(Object.keys(result).sort(), [
      'date_peremption',
      'id',
      'nom_produit',
      'parapharma_ref_status',
      'quantite',
    ])
  })

  it('appelle try_create_parapharma_ref pour un scan manuel valide', async () => {
    const { refStore, ledger } = installDbMock()
    const result = await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: 'Sérum vitamine C',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(refStore.get('3400930000000'), 'Sérum vitamine C')
    assert.equal(ledger.get('3400930000000')?.pharmacyId, PHARMACY_ID)
    assert.equal(result.nom_produit, 'Sérum vitamine C')
    assert.equal(result.parapharma_ref_status, PARAPHARMA_REF_STATUS.CREATED)
    assert.equal(dbCalls.sql.length, 1)
    assert.match(dbCalls.sql[0].text, /try_create_parapharma_ref/)
    assert.doesNotMatch(dbCalls.sql[0].text, /DO UPDATE/)
  })

  it('conserve la première dénomination (already_exists) et le nom du scan saisi', async () => {
    const { refStore } = installDbMock({
      scanNomByCall: ['Nom pharmacie A', 'Nom pharmacie B'],
    })

    await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: 'Nom pharmacie A',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })

    const second = await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: 'Nom pharmacie B',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })

    assert.equal(refStore.get('3400930000000'), 'Nom pharmacie A')
    assert.equal(second.nom_produit, 'Nom pharmacie B')
    assert.equal(second.parapharma_ref_status, PARAPHARMA_REF_STATUS.ALREADY_EXISTS)
    assert.equal(dbCalls.sql.length, 2)
    assert.equal(dbCalls.withPharmacy, 2)
  })

  it('enregistre le scan même si le quota est atteint', async () => {
    installDbMock({
      forceStatus: () => 'quota_exceeded',
    })
    const result = await saveScan(PHARMACY_ID, {
      gtin: '3400930000000',
      nomProduit: 'Produit quota',
      datePeremption: DATE,
      zoneId: ZONE_ID,
      typeProduit: 'parapharma',
      nomManuel: true,
      userId: USER_ID,
    })
    assert.equal(result.id, '11111111-1111-4111-8111-111111111111')
    assert.equal(result.parapharma_ref_status, PARAPHARMA_REF_STATUS.QUOTA_EXCEEDED)
    assert.equal(dbCalls.withPharmacy, 1)
  })
})
