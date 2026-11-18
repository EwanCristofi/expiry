import { useEffect, useId, useRef, useState } from 'react'
import { FileDown, Search, X } from 'lucide-react'
import {
  listLaboratoires,
  searchScans,
} from '../services/productService.js'
import { generateSearchPdf } from '../utils/exportExpiryPdf.js'

const DEBOUNCE_MS = 200
const MIN_QUERY_LENGTH = 2

function formatExpiry(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate ?? '')) return isoDate || '—'
  return `${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`
}

/**
 * Modale de recherche globale (stock scanné) avec filtres Zone / Laboratoire
 * et export PDF de la liste affichée.
 *
 * @param {{
 *   open: boolean,
 *   pharmacyName?: string,
 *   zones?: Array<{ id: number, nom_zone: string }>,
 *   onClose: () => void,
 *   onError?: (message: string) => void,
 *   onSuccess?: (message: string) => void,
 * }} props
 */
export default function SearchModal({
  open,
  pharmacyName = '',
  zones = [],
  onClose,
  onError,
  onSuccess,
}) {
  const titleId = useId()
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [laboratoire, setLaboratoire] = useState('')
  const [laboratoires, setLaboratoires] = useState([])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebouncedQuery('')
    setZoneId('')
    setLaboratoire('')
    setItems([])
    setLoading(false)
    setExporting(false)
    setError('')

    let cancelled = false
    listLaboratoires()
      .then((rows) => {
        if (!cancelled) setLaboratoires(rows)
      })
      .catch(() => {
        if (!cancelled) setLaboratoires([])
      })

    const focusId = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 50)

    return () => {
      cancelled = true
      window.clearTimeout(focusId)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const id = window.setTimeout(() => {
      setDebouncedQuery(query.trim())
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query, open])

  useEffect(() => {
    if (!open) return undefined

    const hasQuery = debouncedQuery.length >= MIN_QUERY_LENGTH
    const hasZone = zoneId !== ''
    const hasLab = laboratoire !== ''

    if (!hasQuery && !hasZone && !hasLab) {
      setItems([])
      setLoading(false)
      setError('')
      return undefined
    }

    const controller = new AbortController()
    setLoading(true)
    setError('')

    searchScans({
      q: hasQuery ? debouncedQuery : '',
      zoneId: hasZone ? Number(zoneId) : null,
      laboratoire: hasLab ? laboratoire : '',
      signal: controller.signal,
    })
      .then((rows) => {
        setItems(rows)
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return
        const message = err?.message || 'Recherche impossible.'
        setError(message)
        setItems([])
        onError?.(message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [open, debouncedQuery, zoneId, laboratoire, onError])

  if (!open) return null

  const hasActiveFilter =
    debouncedQuery.length >= MIN_QUERY_LENGTH ||
    zoneId !== '' ||
    laboratoire !== ''

  function filtersSummary() {
    const parts = []
    if (debouncedQuery.length >= MIN_QUERY_LENGTH) {
      parts.push(`Mot-clé : « ${debouncedQuery} »`)
    }
    if (zoneId !== '') {
      const zone = zones.find((z) => String(z.id) === zoneId)
      parts.push(`Zone : ${zone?.nom_zone || zoneId}`)
    }
    if (laboratoire) parts.push(`Laboratoire : ${laboratoire}`)
    return parts.join(' · ')
  }

  function handleExportPdf() {
    if (exporting) return
    setExporting(true)
    try {
      const { count } = generateSearchPdf({
        pharmacyName,
        items,
        filtersSummary: filtersSummary(),
      })
      onSuccess?.(
        count
          ? `PDF généré — ${count} référence${count === 1 ? '' : 's'}.`
          : 'PDF généré — aucun résultat.',
      )
    } catch (err) {
      const message = err?.message || 'Impossible de générer le PDF.'
      setError(message)
      onError?.(message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[min(92dvh,40rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              Recherche
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Produit, CIP, zone ou laboratoire — dès 2 caractères.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <div className="space-y-3 border-b border-slate-100 px-4 py-3">
          <label className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nom du produit ou CIP…"
              autoComplete="off"
              className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600">Zone</span>
              <select
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              >
                <option value="">Toutes</option>
                {zones.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.nom_zone}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600">
                Laboratoire
              </span>
              <select
                value={laboratoire}
                onChange={(e) => setLaboratoire(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              >
                <option value="">Tous</option>
                {laboratoires.map((lab) => (
                  <option key={lab} value={lab}>
                    {lab}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {!hasActiveFilter ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Saisissez un mot-clé ou choisissez un filtre.
            </p>
          ) : loading ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Recherche…
            </p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              Aucun résultat.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100" role="list">
              {items.map((item) => (
                <li key={item.id} className="py-3 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium text-slate-900">
                    {item.nom_produit || '—'}
                  </p>
                  <dl className="mt-1 grid grid-cols-3 gap-2 text-xs text-slate-500">
                    <div>
                      <dt className="sr-only">Laboratoire</dt>
                      <dd>{item.laboratoire || '—'}</dd>
                    </div>
                    <div>
                      <dt className="sr-only">Zone</dt>
                      <dd>{item.nom_zone || '—'}</dd>
                    </div>
                    <div className="text-right">
                      <dt className="sr-only">Péremption</dt>
                      <dd className="font-mono text-slate-700">
                        {formatExpiry(item.date_peremption)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
          <p className="text-xs text-slate-500">
            {hasActiveFilter && !loading
              ? `${items.length} résultat${items.length === 1 ? '' : 's'}`
              : '\u00a0'}
          </p>
          <button
            type="button"
            onClick={handleExportPdf}
            disabled={exporting || !hasActiveFilter || loading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
          >
            <FileDown className="size-4" aria-hidden />
            {exporting ? 'Export…' : 'Exporter en PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
