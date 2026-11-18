import { useEffect, useId, useState } from 'react'
import {
  fetchExportItems,
  generateExpiryPdf,
  horizonReportTitle,
  resolveExportMonths,
} from '../utils/exportExpiryPdf.js'

const MONTH_OPTIONS = [
  { value: 1, label: 'Janvier' },
  { value: 2, label: 'Février' },
  { value: 3, label: 'Mars' },
  { value: 4, label: 'Avril' },
  { value: 5, label: 'Mai' },
  { value: 6, label: 'Juin' },
  { value: 7, label: 'Juillet' },
  { value: 8, label: 'Août' },
  { value: 9, label: 'Septembre' },
  { value: 10, label: 'Octobre' },
  { value: 11, label: 'Novembre' },
  { value: 12, label: 'Décembre' },
]

const HORIZON_OPTIONS = [
  { value: 'current', label: 'Mois en cours uniquement' },
  { value: '3', label: 'Les 3 prochains mois' },
  { value: '6', label: 'Les 6 prochains mois' },
  { value: 'specific', label: 'Un mois précis' },
]

/**
 * Modale rapide pour configurer et générer l’export PDF des péremptions.
 *
 * @param {{
 *   open: boolean,
 *   pharmacyName?: string,
 *   onClose: () => void,
 *   onError?: (message: string) => void,
 *   onSuccess?: (message: string) => void,
 * }} props
 */
function currentYearMonth() {
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth() + 1 }
}

export default function ExportPdfModal({
  open,
  pharmacyName = '',
  onClose,
  onError,
  onSuccess,
}) {
  const titleId = useId()
  const [horizon, setHorizon] = useState('6')
  const [specificMonth, setSpecificMonth] = useState(
    () => currentYearMonth().month,
  )
  const [specificYear, setSpecificYear] = useState(
    () => currentYearMonth().year,
  )
  const [yearOptions, setYearOptions] = useState(() => {
    const year = currentYearMonth().year
    return Array.from({ length: 6 }, (_, i) => year + i)
  })
  const [excludeVerified, setExcludeVerified] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const { year, month } = currentYearMonth()
    setHorizon('6')
    setSpecificMonth(month)
    setSpecificYear(year)
    setYearOptions(Array.from({ length: 6 }, (_, i) => year + i))
    setExcludeVerified(true)
    setGenerating(false)
    setError('')
  }, [open])

  if (!open) return null

  async function handleGenerate(event) {
    event.preventDefault()
    if (generating) return

    if (
      horizon === 'specific' &&
      (!specificMonth || !specificYear)
    ) {
      setError('Choisissez un mois et une année.')
      return
    }

    setGenerating(true)
    setError('')

    const options = {
      horizon,
      specificYear,
      specificMonth,
    }

    try {
      const months = resolveExportMonths(options)
      const items = await fetchExportItems({
        months,
        excludeVerified,
      })
      const { count } = generateExpiryPdf({
        pharmacyName,
        items,
        reportTitle: horizonReportTitle(options),
      })
      onSuccess?.(
        count
          ? `PDF généré — ${count} référence${count === 1 ? '' : 's'}.`
          : 'PDF généré — aucune référence pour cet horizon.',
      )
      onClose()
    } catch (err) {
      const message = err?.message || 'Impossible de générer le PDF.'
      setError(message)
      onError?.(message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Exporter les péremptions
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Génère un PDF imprimable pour le contrôle en officine.
          </p>
        </div>

        <form onSubmit={handleGenerate} className="space-y-4 p-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">
              Horizon à exporter
            </legend>
            <div className="space-y-1.5">
              {HORIZON_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition ${
                    horizon === option.value
                      ? 'border-teal-600 bg-teal-50 text-teal-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="horizon"
                    value={option.value}
                    checked={horizon === option.value}
                    onChange={() => setHorizon(option.value)}
                    className="size-4 accent-teal-700"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          {horizon === 'specific' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Mois</span>
                <select
                  value={specificMonth}
                  onChange={(e) => setSpecificMonth(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                >
                  {MONTH_OPTIONS.map((month) => (
                    <option key={month.value} value={month.value}>
                      {month.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Année
                </span>
                <select
                  value={specificYear}
                  onChange={(e) => setSpecificYear(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                >
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={excludeVerified}
              onChange={(e) => setExcludeVerified(e.target.checked)}
              className="mt-0.5 size-4 accent-teal-700"
            />
            <span>
              Exclure les produits déjà contrôlés
              <span className="mt-0.5 block text-xs text-slate-500">
                Ne conserve que les références encore à vérifier.
              </span>
            </span>
          </label>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={generating}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={generating}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {generating ? 'Génération…' : 'Générer le PDF'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
