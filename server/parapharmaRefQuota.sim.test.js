/**
 * Simulateur fidèle de `try_create_parapharma_ref` (PL/pgSQL).
 *
 * LIMITES :
 * - N'exerce pas Neon PostgreSQL réel (pas de pg_advisory_xact_lock natif).
 * - Verrou par pharmacie = Mutex async (sérialisation équivalente à advisory_xact_lock).
 * - Unicité globale GTIN = Mutex global (équivalent ON CONFLICT / UNIQUE).
 * - Bornes de mois Europe/Paris calculées via Intl.
 *
 * Ces tests démontrent l'algorithme et les courses. Un passage sur Neon
 * après migration reste recommandé avant production.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PARAPHARMA_REF_MONTHLY_QUOTA,
  PARAPHARMA_REF_STATUS,
} from './parapharmaRefQuota.js'

class AsyncMutex {
  constructor() {
    /** @type {Promise<void>} */
    this._tail = Promise.resolve()
  }

  /**
   * @template T
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  runExclusive(fn) {
    const run = this._tail.then(() => fn())
    this._tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * @param {Date} now
 * @returns {{ start: Date, end: Date }}
 */
function parisMonthBounds(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  const year = Number(parts.year)
  const month = Number(parts.month)

  /** @param {number} y @param {number} m 1-12 */
  const parisMidnightUtc = (y, m) => {
    // Dichotomie légère : trouver l'instant UTC où Paris affiche y-m-01 00:00:00
    let lo = Date.UTC(y, m - 1, 1, 0, 0, 0) - 12 * 3600_000
    let hi = Date.UTC(y, m - 1, 1, 0, 0, 0) + 12 * 3600_000
    const target = `${y}-${String(m).padStart(2, '0')}-01 00:00:00`
    for (let i = 0; i < 40; i++) {
      const mid = Math.floor((lo + hi) / 2)
      const label = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(mid))
        .reduce((acc, p) => {
          acc[p.type] = p.value
          return acc
        }, /** @type {Record<string,string>} */ ({}))
      const cur = `${label.year}-${label.month}-${label.day} ${label.hour}:${label.minute}:${label.second}`
      if (cur < target) lo = mid
      else hi = mid
    }
    return new Date(hi)
  }

  const start = parisMidnightUtc(year, month)
  const end =
    month === 12
      ? parisMidnightUtc(year + 1, 1)
      : parisMidnightUtc(year, month + 1)
  return { start, end }
}

function createSim(options = {}) {
  const monthlyLimit = options.monthlyLimit ?? PARAPHARMA_REF_MONTHLY_QUOTA
  /** @type {Map<string, string>} */
  const refs = options.refs ?? new Map()
  /** @type {Map<string, { pharmacyId: string, userId: string, createdAt: Date }>} */
  const ledger = options.ledger ?? new Map()
  /** @type {Set<string>} */
  const pharmacies = options.pharmacies ?? new Set()
  /** @type {Map<string, string>} userId → pharmacyId */
  const users = options.users ?? new Map()
  /** @type {Map<string, AsyncMutex>} */
  const pharmacyLocks = new Map()
  const globalRefLock = new AsyncMutex()
  let now = options.now ?? new Date()
  let failNextLedger = false

  function pharmacyLock(pharmacyId) {
    if (!pharmacyLocks.has(pharmacyId)) {
      pharmacyLocks.set(pharmacyId, new AsyncMutex())
    }
    return pharmacyLocks.get(pharmacyId)
  }

  /**
   * @returns {Promise<{ status: string, created: boolean }>}
   */
  async function tryCreate(gtin, nom, pharmacyId, userId) {
    if (pharmacyId == null) throw new Error('pharmacy_id obligatoire')
    if (userId == null) throw new Error('user_id obligatoire')
    if (!pharmacies.has(pharmacyId)) throw new Error('pharmacy_id inconnu')
    if (users.get(userId) !== pharmacyId) {
      throw new Error("user_id n'appartient pas à pharmacy_id")
    }

    return pharmacyLock(pharmacyId).runExclusive(async () => {
      if (refs.has(gtin)) {
        return { status: PARAPHARMA_REF_STATUS.ALREADY_EXISTS, created: false }
      }

      const { start, end } = parisMonthBounds(now)
      let count = 0
      for (const row of ledger.values()) {
        if (
          row.pharmacyId === pharmacyId &&
          row.createdAt >= start &&
          row.createdAt < end
        ) {
          count += 1
        }
      }
      if (count >= monthlyLimit) {
        return { status: PARAPHARMA_REF_STATUS.QUOTA_EXCEEDED, created: false }
      }

      // Unique globale (ON CONFLICT) — sérialise les inserts multi-pharmacies.
      return globalRefLock.runExclusive(() => {
        if (refs.has(gtin)) {
          return {
            status: PARAPHARMA_REF_STATUS.ALREADY_EXISTS,
            created: false,
          }
        }

        // Simule une transaction : ref + ledger commitent ensemble ou pas du tout.
        if (failNextLedger) {
          failNextLedger = false
          throw new Error('ledger insert failed')
        }

        refs.set(gtin, nom)
        ledger.set(gtin, {
          pharmacyId,
          userId,
          createdAt: new Date(now.getTime()),
        })
        return { status: PARAPHARMA_REF_STATUS.CREATED, created: true }
      })
    })
  }

  return {
    refs,
    ledger,
    tryCreate,
    setNow: (d) => {
      now = d
    },
    failNextLedgerOnce: () => {
      failNextLedger = true
    },
    monthCount(pharmacyId) {
      const { start, end } = parisMonthBounds(now)
      let n = 0
      for (const row of ledger.values()) {
        if (
          row.pharmacyId === pharmacyId &&
          row.createdAt >= start &&
          row.createdAt < end
        ) {
          n += 1
        }
      }
      return n
    },
  }
}

const P1 = 'pharmacy-1'
const P2 = 'pharmacy-2'
const U1 = 'user-1'
const U2 = 'user-2'
/** Utilisateur rattaché à P2 (U2 reste sur P1 pour les tests de quota partagé). */
const U3 = 'user-3'

function defaultSim(options = {}) {
  return createSim({
    now: new Date('2026-11-15T12:00:00Z'),
    pharmacies: new Set([P1, P2]),
    users: new Map([
      [U1, P1],
      [U2, P1],
      [U3, P2],
    ]),
    ...options,
  })
}

describe('try_create_parapharma_ref (simulateur)', () => {
  /** @type {ReturnType<typeof createSim>} */
  let sim

  beforeEach(() => {
    sim = defaultSim()
  })

  it('1. première création : référence + attribution', async () => {
    const r = await sim.tryCreate('111', 'Crème', P1, U1)
    assert.equal(r.status, 'created')
    assert.equal(sim.refs.get('111'), 'Crème')
    assert.equal(sim.ledger.get('111')?.pharmacyId, P1)
    assert.equal(sim.ledger.get('111')?.userId, U1)
    assert.equal(sim.monthCount(P1), 1)
  })

  it('2. second appel même GTIN : already_exists, quota inchangé', async () => {
    await sim.tryCreate('111', 'A', P1, U1)
    const r = await sim.tryCreate('111', 'B', P1, U1)
    assert.equal(r.status, 'already_exists')
    assert.equal(sim.refs.get('111'), 'A')
    assert.equal(sim.monthCount(P1), 1)
  })

  it('3. autre pharmacie sur GTIN existant : aucun quota consommé', async () => {
    await sim.tryCreate('111', 'A', P1, U1)
    const r = await sim.tryCreate('111', 'B', P2, U3)
    assert.equal(r.status, 'already_exists')
    assert.equal(sim.monthCount(P2), 0)
    assert.equal(sim.ledger.get('111')?.pharmacyId, P1)
  })

  it('4. quota à 99 : la 100e création est acceptée', async () => {
    for (let i = 0; i < 99; i++) {
      assert.equal(
        (await sim.tryCreate(`g${i}`, `n${i}`, P1, U1)).status,
        'created',
      )
    }
    assert.equal(sim.monthCount(P1), 99)
    const r = await sim.tryCreate('g99', 'n99', P1, U1)
    assert.equal(r.status, 'created')
    assert.equal(sim.monthCount(P1), 100)
  })

  it('5. quota à 100 : la 101e référence n’est pas créée', async () => {
    for (let i = 0; i < 100; i++) {
      await sim.tryCreate(`g${i}`, `n${i}`, P1, U1)
    }
    const r = await sim.tryCreate('g100', 'n100', P1, U1)
    assert.equal(r.status, 'quota_exceeded')
    assert.equal(sim.refs.has('g100'), false)
    assert.equal(sim.ledger.has('g100'), false)
    assert.equal(sim.monthCount(P1), 100)
  })

  it('6. quota atteint : statut sans mutation du référentiel (scan hors scope)', async () => {
    for (let i = 0; i < 100; i++) {
      await sim.tryCreate(`g${i}`, `n${i}`, P1, U1)
    }
    const r = await sim.tryCreate('extra', 'x', P1, U1)
    assert.equal(r.status, 'quota_exceeded')
    assert.equal(r.created, false)
  })

  it('7. deux utilisateurs même pharmacie : quota partagé', async () => {
    for (let i = 0; i < 50; i++) {
      await sim.tryCreate(`a${i}`, `n${i}`, P1, U1)
    }
    for (let i = 0; i < 50; i++) {
      await sim.tryCreate(`b${i}`, `n${i}`, P1, U2)
    }
    assert.equal(sim.monthCount(P1), 100)
    assert.equal(
      (await sim.tryCreate('overflow', 'x', P1, U2)).status,
      'quota_exceeded',
    )
  })

  it('8. créations simultanées près de la limite : aucun dépassement', async () => {
    for (let i = 0; i < 98; i++) {
      await sim.tryCreate(`g${i}`, `n${i}`, P1, U1)
    }
    const results = await Promise.all([
      sim.tryCreate('near1', 'a', P1, U1),
      sim.tryCreate('near2', 'b', P1, U2),
      sim.tryCreate('near3', 'c', P1, U1),
    ])
    const created = results.filter((r) => r.status === 'created')
    const exceeded = results.filter((r) => r.status === 'quota_exceeded')
    assert.equal(created.length, 2)
    assert.equal(exceeded.length, 1)
    assert.equal(sim.monthCount(P1), 100)
  })

  it('9. deux pharmacies, même GTIN en parallèle : une seule ref + attribution', async () => {
    const results = await Promise.all([
      sim.tryCreate('shared', 'Nom A', P1, U1),
      sim.tryCreate('shared', 'Nom B', P2, U3),
    ])
    const created = results.filter((r) => r.status === 'created')
    const exists = results.filter((r) => r.status === 'already_exists')
    assert.equal(created.length, 1)
    assert.equal(exists.length, 1)
    assert.equal(sim.refs.size, 1)
    assert.equal(sim.ledger.size, 1)
    const owner = sim.ledger.get('shared')?.pharmacyId
    assert.ok(owner === P1 || owner === P2)
    assert.equal(sim.monthCount(P1) + sim.monthCount(P2), 1)
  })

  it('9b. user d’une autre pharmacie : rejet (pas de statut métier)', async () => {
    await assert.rejects(
      () => sim.tryCreate('x', 'Nom', P1, U3),
      /user_id n'appartient pas/,
    )
    assert.equal(sim.refs.has('x'), false)
    assert.equal(sim.ledger.has('x'), false)
  })

  it('9c. pharmacy_id inconnu : rejet', async () => {
    await assert.rejects(
      () => sim.tryCreate('x', 'Nom', 'pharmacy-missing', U1),
      /pharmacy_id inconnu/,
    )
  })

  it('9d. user_id obligatoire', async () => {
    await assert.rejects(
      () => sim.tryCreate('x', 'Nom', P1, null),
      /user_id obligatoire/,
    )
  })

  it('10. échec ledger : aucune référence orpheline', async () => {
    sim.failNextLedgerOnce()
    await assert.rejects(() => sim.tryCreate('orphan', 'X', P1, U1), /ledger/)
    assert.equal(sim.refs.has('orphan'), false)
    assert.equal(sim.ledger.has('orphan'), false)
    const r = await sim.tryCreate('orphan', 'X', P1, U1)
    assert.equal(r.status, 'created')
  })

  it('11. nouveau mois : le quota repart à zéro', async () => {
    for (let i = 0; i < 100; i++) {
      await sim.tryCreate(`g${i}`, `n${i}`, P1, U1)
    }
    assert.equal(
      (await sim.tryCreate('blocked', 'x', P1, U1)).status,
      'quota_exceeded',
    )

    sim.setNow(new Date('2026-12-01T10:00:00Z'))
    const r = await sim.tryCreate('new-month', 'Fresh', P1, U1)
    assert.equal(r.status, 'created')
    assert.equal(sim.monthCount(P1), 1)
  })

  it('12. référence historique sans attribution : non comptée', async () => {
    sim.refs.set('legacy', 'Ancien produit')
    assert.equal(sim.ledger.has('legacy'), false)
    assert.equal(sim.monthCount(P1), 0)

    const r = await sim.tryCreate('legacy', 'Tentative', P1, U1)
    assert.equal(r.status, 'already_exists')
    assert.equal(sim.monthCount(P1), 0)
    assert.equal(sim.ledger.has('legacy'), false)

    const r2 = await sim.tryCreate('new-ok', 'Nouveau', P1, U1)
    assert.equal(r2.status, 'created')
    assert.equal(sim.monthCount(P1), 1)
  })
})

describe('SQL migration — contrat atomique et durcissement (texte source)', () => {
  /**
   * Ces assertions vérifient le contenu du fichier de migration, pas les
   * privileges PostgreSQL réels (non vérifiables sans connexion Neon).
   */
  const sqlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'sql',
    '010_parapharma_ref_quota.sql',
  )

  it('définit advisory lock, ON CONFLICT DO NOTHING et ledger sans backfill', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8')
    assert.match(sql, /parapharma_ref_creations/)
    assert.match(sql, /try_create_parapharma_ref/)
    assert.match(sql, /pg_advisory_xact_lock/)
    assert.match(sql, /ON CONFLICT \(gtin\) DO NOTHING/)
    assert.match(sql, /Europe\/Paris/)
    assert.match(sql, /p_monthly_limit INT DEFAULT 100/)
    assert.doesNotMatch(sql, /DO UPDATE/)
    assert.doesNotMatch(sql, /INSERT INTO parapharma_ref_creations\s*\([\s\S]*SELECT/i)
  })

  it('durcit permissions expiry_app et EXECUTE (contrat source)', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8')
    assert.match(
      sql,
      /REVOKE\s+INSERT\s*,\s*UPDATE\s+ON\s+TABLE\s+public\.parapharma_ref\s+FROM\s+expiry_app/i,
    )
    assert.match(
      sql,
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.parapharma_ref\s+TO\s+expiry_app/i,
    )
    assert.match(
      sql,
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.parapharma_ref_creations\s+TO\s+expiry_app/i,
    )
    assert.doesNotMatch(
      sql,
      /GRANT\s+[^;]*INSERT[^;]*parapharma_ref_creations[^;]*expiry_app/i,
    )
    assert.doesNotMatch(
      sql,
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*try_create_parapharma_ref[^;]*TO\s+expiry_app/i,
    )
    assert.match(
      sql,
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.try_create_parapharma_ref\s*\(\s*TEXT\s*,\s*TEXT\s*,\s*UUID\s*,\s*UUID\s*,\s*INT\s*\)\s+FROM\s+PUBLIC/i,
    )
    assert.match(
      sql,
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.try_create_parapharma_ref\s*\(\s*TEXT\s*,\s*TEXT\s*,\s*UUID\s*,\s*UUID\s*,\s*INT\s*\)\s+FROM\s+expiry_app/i,
    )
  })

  it('sécurise search_path, INVOKER, identité user/pharmacie, sans app.pharmacy_id', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8')
    assert.match(sql, /SECURITY\s+INVOKER/i)
    assert.match(sql, /SET\s+search_path\s*=\s*pg_catalog/i)
    assert.match(sql, /FROM\s+public\.pharmacies/i)
    assert.match(sql, /FROM\s+public\.users/i)
    assert.match(sql, /user_id obligatoire/)
    assert.match(sql, /pharmacy_id inconnu/)
    assert.match(sql, /user_id n''appartient pas à pharmacy_id/)
    assert.match(sql, /status := 'created'/)
    assert.match(sql, /status := 'already_exists'/)
    assert.match(sql, /status := 'quota_exceeded'/)
    assert.doesNotMatch(sql, /current_setting\s*\(\s*'app\.pharmacy_id'/i)
    assert.doesNotMatch(sql, /SET\s+search_path\s*=\s*public/i)
  })
})
