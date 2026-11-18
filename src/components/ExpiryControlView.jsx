import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownAZ,
  Check,
  Eye,
  EyeOff,
  CalendarClock,
  RotateCcw,
} from 'lucide-react'
import {
  listExpiryChecks,
  setScanVerified,
} from '../services/productService.js'

const MONTH_LABELS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
]

function currentControlMonth(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function formatExpiryDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate ?? '')) return isoDate || '—'
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

function compareItems(a, b, sort) {
  const byVerified = Number(a.is_verified) - Number(b.is_verified)
  if (byVerified !== 0) return byVerified

  if (sort === 'name') {
    const byName = a.nom_produit.localeCompare(b.nom_produit, 'fr')
    if (byName !== 0) return byName
    return String(b.date_scan ?? '').localeCompare(String(a.date_scan ?? ''))
  }

  const byScan = String(a.date_scan ?? '').localeCompare(
    String(b.date_scan ?? ''),
  )
  if (byScan !== 0) return byScan
  return a.nom_produit.localeCompare(b.nom_produit, 'fr')
}

/**
 * Contrôle terrain simplifié : mois → zone → liste.
 *
 * @param {{
 *   zones: Array<{ id: number, nom_zone: string }>,
 *   zonesLoading?: boolean,
 *   initialZoneId?: number | null,
 *   onError?: (message: string) => void,
 * }} props
 */
export default function ExpiryControlView({
  zones,
  zonesLoading = false,
  initialZoneId = null,
  onError,
}) {
  const nowMonth = useMemo(() => currentControlMonth(), [])
  const [year, setYear] = useState(nowMonth.year)
  const [month, setMonth] = useState(nowMonth.month)
  /** `null` = toutes les zones ; sinon id de zone. */
  const [zoneId, setZoneId] = useState(null)
  const [showVerified, setShowVerified] = useState(false)
  const [sort, setSort] = useState('date')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const [zoneReady, setZoneReady] = useState(false)
  const didApplyInitialZone = useRef(false)

  useEffect(() => {
    if (zonesLoading) return
    setZoneReady(true)
  }, [zonesLoading])

  function goToMonth(nextMonth, nextYear) {
    setMonth(nextMonth)
    setYear(nextYear)
    setSort('date')
  }

  const loadItems = useCallback(async () => {
    if (!zoneReady || zonesLoading) return
    if (!zones.length) {
      setItems([])
      return
    }

    setLoading(true)
    try {
      const rows = await listExpiryChecks({
        year,
        month,
        zoneId: null,
        status: 'all',
        sort,
      })
      setItems([...rows].sort((a, b) => compareItems(a, b, sort)))
    } catch (err) {
      setItems([])
      onError?.(err?.message || 'Impossible de charger les produits.')
    } finally {
      setLoading(false)
    }
  }, [year, month, sort, zoneReady, zonesLoading, zones.length, onError])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  const zonesWithProducts = useMemo(() => {
    const zoneNameById = new Map(zones.map((z) => [z.id, z.nom_zone]))
    /** @type {Map<number, { id: number, nom_zone: string, total: number, pending: number }>} */
    const byId = new Map()

    for (const item of items) {
      if (item.zone_id == null) continue
      const existing = byId.get(item.zone_id)
      if (existing) {
        existing.total += 1
        if (!item.is_verified) existing.pending += 1
      } else {
        byId.set(item.zone_id, {
          id: item.zone_id,
          nom_zone:
            item.nom_zone ||
            zoneNameById.get(item.zone_id) ||
            `Zone ${item.zone_id}`,
          total: 1,
          pending: item.is_verified ? 0 : 1,
        })
      }
    }

    return [...byId.values()].sort((a, b) =>
      a.nom_zone.localeCompare(b.nom_zone, 'fr'),
    )
  }, [items, zones])

  const totalForMonth = items.length

  // Appliquer une fois la zone active du scan, si elle a des produits ce mois.
  useEffect(() => {
    if (!zoneReady || loading || didApplyInitialZone.current) return
    didApplyInitialZone.current = true
    if (
      initialZoneId &&
      zonesWithProducts.some((z) => z.id === initialZoneId)
    ) {
      setZoneId(initialZoneId)
    }
  }, [zoneReady, loading, zonesWithProducts, initialZoneId])

  // Si la zone choisie n’a plus de produit ce mois-là, revenir à « Toutes ».
  useEffect(() => {
    if (!zoneReady || loading) return
    setZoneId((prev) => {
      if (prev == null) return null
      if (zonesWithProducts.some((z) => z.id === prev)) return prev
      return null
    })
  }, [zonesWithProducts, zoneReady, loading])

  const scopedItems = useMemo(() => {
    const inZone =
      zoneId == null
        ? items
        : items.filter((item) => item.zone_id === zoneId)
    const visible = showVerified
      ? inZone
      : inZone.filter((item) => !item.is_verified)
    return [...visible].sort((a, b) => compareItems(a, b, sort))
  }, [items, zoneId, showVerified, sort])

  const pendingCount = useMemo(() => {
    const inZone =
      zoneId == null
        ? items
        : items.filter((item) => item.zone_id === zoneId)
    return inZone.filter((item) => !item.is_verified).length
  }, [items, zoneId])

  const yearOptions = useMemo(() => {
    const years = new Set(
      Array.from({ length: 8 }, (_, i) => nowMonth.year - 1 + i),
    )
    years.add(year)
    return [...years].sort((a, b) => a - b)
  }, [nowMonth.year, year])

  async function handleToggle(item) {
    if (pendingIds.has(item.id)) return

    const nextVerified = !item.is_verified
    setPendingIds((prev) => new Set(prev).add(item.id))

    setItems((prev) =>
      prev
        .map((row) =>
          row.id === item.id ? { ...row, is_verified: nextVerified } : row,
        )
        .sort((a, b) => compareItems(a, b, sort)),
    )

    try {
      await setScanVerified(item.id, nextVerified)
    } catch (err) {
      setItems((prev) =>
        prev
          .map((row) =>
            row.id === item.id
              ? { ...row, is_verified: item.is_verified }
              : row,
          )
          .sort((a, b) => compareItems(a, b, sort)),
      )
      onError?.(err?.message || 'Échec de la mise à jour.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  const showZoneOnRows = zoneId == null
  const hasProductsThisMonth = totalForMonth > 0

  return (
    <div className="flex w-full max-w-3xl flex-col gap-3">
      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        {/* Ligne 1 — en-tête */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-base font-semibold text-teal-900 sm:text-lg">
            Contrôle des péremptions
          </h2>
          <span
            className="shrink-0 rounded-full bg-teal-700 px-2.5 py-1 text-xs font-semibold tabular-nums text-white"
            aria-label={`${pendingCount} à faire`}
          >
            {pendingCount} à faire
          </span>
        </div>

        {/* Ligne 2 — mois / année */}
        <div className="mt-3 flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (month === 1) goToMonth(12, year - 1)
              else goToMonth(month - 1, year)
            }}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-lg font-medium text-slate-600 hover:bg-slate-100 active:bg-slate-200"
            aria-label="Mois précédent"
          >
            ‹
          </button>
          <select
            value={month}
            onChange={(e) => goToMonth(Number(e.target.value), year)}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            aria-label="Mois"
          >
            {MONTH_LABELS.map((label, index) => (
              <option key={label} value={index + 1}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => goToMonth(month, Number(e.target.value))}
            className="w-[5.75rem] shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-2.5 text-sm font-medium tabular-nums text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            aria-label="Année"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              if (month === 12) goToMonth(1, year + 1)
              else goToMonth(month + 1, year)
            }}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-lg font-medium text-slate-600 hover:bg-slate-100 active:bg-slate-200"
            aria-label="Mois suivant"
          >
            ›
          </button>
        </div>

        {/* Ligne 3 — zones (uniquement celles avec produits ce mois) */}
        <div className="mt-2">
          <label className="sr-only" htmlFor="control-zone-select">
            Zone
          </label>
          <select
            id="control-zone-select"
            value={zoneId == null ? '' : String(zoneId)}
            disabled={zonesLoading || !hasProductsThisMonth}
            onChange={(e) => {
              const value = e.target.value
              setZoneId(value === '' ? null : Number(value))
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-50 disabled:text-slate-400"
          >
            {hasProductsThisMonth ? (
              <>
                <option value="">
                  Toutes les zones ({totalForMonth})
                </option>
                {zonesWithProducts.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.nom_zone} ({zone.total})
                  </option>
                ))}
              </>
            ) : (
              <option value="">Aucune zone pour ce mois</option>
            )}
          </select>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {/* Barre d’actions discrète */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <button
            type="button"
            onClick={() => setShowVerified((v) => !v)}
            aria-pressed={showVerified}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
              showVerified
                ? 'bg-slate-100 text-slate-800'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
            }`}
            title={
              showVerified
                ? 'Masquer les produits contrôlés'
                : 'Afficher les produits contrôlés'
            }
          >
            {showVerified ? (
              <Eye className="size-3.5" aria-hidden />
            ) : (
              <EyeOff className="size-3.5" aria-hidden />
            )}
            {showVerified ? 'Contrôlés visibles' : 'Contrôlés masqués'}
          </button>

          <button
            type="button"
            onClick={() => setSort((s) => (s === 'date' ? 'name' : 'date'))}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
            title="Changer le tri"
          >
            {sort === 'date' ? (
              <CalendarClock className="size-3.5" aria-hidden />
            ) : (
              <ArrowDownAZ className="size-3.5" aria-hidden />
            )}
            {sort === 'date' ? 'Tri : Date de saisie' : 'Tri : A → Z'}
          </button>
        </div>

        {zonesLoading || !zoneReady || loading ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            Chargement…
          </p>
        ) : !zones.length ? (
          <p className="px-4 py-8 text-center text-sm text-amber-800">
            Créez une zone dans Paramètres pour démarrer un contrôle.
          </p>
        ) : !hasProductsThisMonth ? (
          <div className="px-4 py-10 text-center">
            <p className="text-base font-medium text-teal-800">
              Aucun produit ce mois-ci
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Aucun scan enregistré pour {MONTH_LABELS[month - 1]} {year}.
            </p>
          </div>
        ) : scopedItems.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-base font-medium text-teal-800">
              Rien à contrôler
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Tous les produits de cette sélection sont déjà contrôlés.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {scopedItems.map((item) => {
              const pending = pendingIds.has(item.id)
              const verified = item.is_verified
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleToggle(item)}
                    className={`flex w-full items-center gap-3 px-4 py-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700 disabled:opacity-60 active:bg-teal-50 sm:gap-4 sm:px-5 ${
                      verified
                        ? 'bg-slate-50 hover:bg-slate-100'
                        : 'bg-white hover:bg-teal-50/60'
                    }`}
                    aria-label={
                      verified
                        ? `Dé-flaguer ${item.nom_produit}`
                        : `Marquer ${item.nom_produit} comme vérifié`
                    }
                  >
                    <span
                      className={`flex size-11 shrink-0 items-center justify-center rounded-full border-2 transition ${
                        verified
                          ? 'border-slate-300 bg-slate-200 text-slate-500'
                          : 'border-teal-600 bg-teal-50 text-teal-700'
                      }`}
                      aria-hidden
                    >
                      {verified ? (
                        <RotateCcw className="size-4" />
                      ) : (
                        <Check className="size-5" strokeWidth={2.5} />
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-[15px] font-semibold leading-snug sm:text-base ${
                          verified
                            ? 'text-slate-400 line-through'
                            : 'text-slate-900'
                        }`}
                      >
                        {item.nom_produit}
                      </span>
                      <span
                        className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs sm:text-sm ${
                          verified ? 'text-slate-400' : 'text-slate-500'
                        }`}
                      >
                        {showZoneOnRows && item.nom_zone ? (
                          <>
                            <span className="font-medium text-teal-800/80">
                              {item.nom_zone}
                            </span>
                            <span aria-hidden>·</span>
                          </>
                        ) : null}
                        <span className="font-mono tracking-tight">
                          {item.code_gtin}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="font-medium tabular-nums text-slate-700">
                          {formatExpiryDate(item.date_peremption)}
                        </span>
                        {item.quantite > 1 ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>×{item.quantite}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
