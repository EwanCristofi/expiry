import { useCallback, useEffect, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
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

/** Valeur sentinelle du sélecteur : toutes les zones. */
const ALL_ZONES = 'all'

function currentControlMonth(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function formatDay(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate ?? '')) return isoDate || '—'
  const [, , day] = isoDate.split('-')
  return `jour ${Number(day)}`
}

function compareItems(a, b, sort) {
  const byVerified = Number(a.is_verified) - Number(b.is_verified)
  if (byVerified !== 0) return byVerified

  if (sort === 'name') {
    const byName = a.nom_produit.localeCompare(b.nom_produit, 'fr')
    if (byName !== 0) return byName
    return String(b.date_scan ?? '').localeCompare(String(a.date_scan ?? ''))
  }

  // Plus récent → plus ancien (date_scan)
  const byScan = String(b.date_scan ?? '').localeCompare(
    String(a.date_scan ?? ''),
  )
  if (byScan !== 0) return byScan
  return a.nom_produit.localeCompare(b.nom_produit, 'fr')
}

/**
 * Flux de contrôle terrain : mois + zone + état + tri.
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
  const initial = currentControlMonth()
  const [year, setYear] = useState(initial.year)
  const [month, setMonth] = useState(initial.month)
  /** `null` = toutes les zones ; sinon id de zone. */
  const [zoneId, setZoneId] = useState(null)
  const [status, setStatus] = useState('unverified')
  const [sort, setSort] = useState('date')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const [zoneReady, setZoneReady] = useState(false)

  useEffect(() => {
    if (zonesLoading) return

    setZoneId((prev) => {
      // Déjà initialisé (y compris « Toutes les zones »)
      if (zoneReady) {
        if (prev == null) return null
        if (zones.some((z) => z.id === prev)) return prev
        return null
      }

      if (initialZoneId && zones.some((z) => z.id === initialZoneId)) {
        return initialZoneId
      }
      return null
    })
    setZoneReady(true)
  }, [zones, zonesLoading, initialZoneId, zoneReady])

  function goToMonth(nextMonth, nextYear) {
    setMonth(nextMonth)
    setYear(nextYear)
    // Tri chronologique progressif à chaque changement de mois
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
        zoneId,
        status,
        sort,
      })
      setItems(rows)
    } catch (err) {
      setItems([])
      onError?.(err?.message || 'Impossible de charger les produits.')
    } finally {
      setLoading(false)
    }
  }, [year, month, zoneId, status, sort, zoneReady, zonesLoading, zones.length, onError])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  async function handleToggle(item) {
    if (pendingIds.has(item.id)) return

    const nextVerified = !item.is_verified

    setPendingIds((prev) => new Set(prev).add(item.id))

    if (status === 'unverified' && nextVerified) {
      setItems((prev) => prev.filter((row) => row.id !== item.id))
    } else {
      setItems((prev) =>
        prev
          .map((row) =>
            row.id === item.id ? { ...row, is_verified: nextVerified } : row,
          )
          .sort((a, b) => compareItems(a, b, sort)),
      )
    }

    try {
      await setScanVerified(item.id, nextVerified)
    } catch (err) {
      if (status === 'unverified' && nextVerified) {
        setItems((prev) =>
          [...prev, item].sort((a, b) => compareItems(a, b, sort)),
        )
      } else {
        setItems((prev) =>
          prev
            .map((row) =>
              row.id === item.id
                ? { ...row, is_verified: item.is_verified }
                : row,
            )
            .sort((a, b) => compareItems(a, b, sort)),
        )
      }
      onError?.(err?.message || 'Échec de la mise à jour.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  const monthLabel = `${MONTH_LABELS[month - 1]} ${year}`
  const zoneLabel =
    zoneId == null
      ? 'Toutes les zones'
      : (zones.find((z) => z.id === zoneId)?.nom_zone ?? '')
  const verifiedCount = items.filter((i) => i.is_verified).length
  const pendingCount = items.filter((i) => !i.is_verified).length
  const showZoneOnRows = zoneId == null

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-teal-900">
              Contrôle des péremptions
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Touchez un produit pour le marquer comme contrôlé.
            </p>
          </div>
          <p className="text-sm font-medium tabular-nums text-slate-600">
            {status === 'unverified'
              ? `${items.length} à faire`
              : `${pendingCount} restant · ${verifiedCount} fait`}
          </p>
        </div>

        <div className="mt-5 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Mois / Année
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    if (month === 1) goToMonth(12, year - 1)
                    else goToMonth(month - 1, year)
                  }}
                  className="rounded-lg px-2.5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
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
                  className="w-[5.5rem] rounded-lg border border-slate-300 bg-white px-2 py-2.5 text-sm font-medium tabular-nums text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                  aria-label="Année"
                >
                  {Array.from({ length: 8 }, (_, i) => initial.year - 1 + i).map(
                    (y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ),
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (month === 12) goToMonth(1, year + 1)
                    else goToMonth(month + 1, year)
                  }}
                  className="rounded-lg px-2.5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
                  aria-label="Mois suivant"
                >
                  ›
                </button>
              </div>
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Zone
              </span>
              <select
                value={zoneId == null ? ALL_ZONES : String(zoneId)}
                disabled={zonesLoading || !zones.length}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === ALL_ZONES) {
                    setZoneId(null)
                    return
                  }
                  const id = Number(value)
                  if (Number.isFinite(id) && id > 0) setZoneId(id)
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 disabled:opacity-50"
              >
                {!zones.length ? (
                  <option value={ALL_ZONES}>Aucune zone</option>
                ) : (
                  <>
                    <option value={ALL_ZONES}>Toutes les zones</option>
                    {zones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.nom_zone}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="block space-y-1.5">
              <legend className="text-xs font-medium uppercase tracking-wide text-slate-500">
                État
              </legend>
              <div
                className="grid grid-cols-2 gap-1 rounded-lg border border-slate-300 bg-slate-50 p-1"
                role="radiogroup"
                aria-label="État de vérification"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={status === 'unverified'}
                  onClick={() => setStatus('unverified')}
                  className={`rounded-md px-2 py-2 text-sm font-semibold transition ${
                    status === 'unverified'
                      ? 'bg-teal-700 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-white'
                  }`}
                >
                  Non vérifiés
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={status === 'all'}
                  onClick={() => setStatus('all')}
                  className={`rounded-md px-2 py-2 text-sm font-semibold transition ${
                    status === 'all'
                      ? 'bg-teal-700 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-white'
                  }`}
                >
                  Tous
                </button>
              </div>
            </fieldset>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Tri
              </span>
              <select
                value={sort}
                onChange={(e) =>
                  setSort(e.target.value === 'name' ? 'name' : 'date')
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              >
                <option value="date">Par date de saisie (récent → ancien)</option>
                <option value="name">Alphabétique (A → Z)</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-medium text-slate-700">
            {monthLabel}
            {zoneLabel ? ` · ${zoneLabel}` : ''}
          </p>
        </div>

        {zonesLoading || !zoneReady || loading ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            Chargement…
          </p>
        ) : !zones.length ? (
          <p className="px-4 py-8 text-center text-sm text-amber-800">
            Créez une zone dans Paramètres pour démarrer un contrôle.
          </p>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-base font-medium text-teal-800">
              {status === 'unverified'
                ? 'Rien à contrôler'
                : 'Aucun produit pour ce filtre'}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {status === 'unverified'
                ? 'Tous les produits de ce mois / ce filtre sont vérifiés.'
                : 'Aucun scan enregistré pour ce mois et ce filtre.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => {
              const pending = pendingIds.has(item.id)
              const verified = item.is_verified
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleToggle(item)}
                    className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700 disabled:opacity-60 sm:gap-4 sm:px-5 sm:py-4 ${
                      verified
                        ? 'bg-slate-50 hover:bg-slate-100'
                        : 'bg-white hover:bg-teal-50/60 active:bg-teal-50'
                    }`}
                    aria-label={
                      verified
                        ? `Dé-flaguer ${item.nom_produit}`
                        : `Marquer ${item.nom_produit} comme vérifié`
                    }
                  >
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-full border-2 transition ${
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
                        className={`block truncate text-sm font-semibold sm:text-base ${
                          verified
                            ? 'text-slate-400 line-through'
                            : 'text-slate-900'
                        }`}
                      >
                        {item.nom_produit}
                      </span>
                      <span
                        className={`mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs sm:text-sm ${
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
                        <span className="font-mono">{item.code_gtin}</span>
                        <span aria-hidden>·</span>
                        <span>{formatDay(item.date_peremption)}</span>
                        {item.quantite > 1 ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>×{item.quantite}</span>
                          </>
                        ) : null}
                        {verified ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-medium">Vérifié</span>
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
