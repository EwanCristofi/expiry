import { useEffect, useState } from 'react'

const MONTHS = [
  { value: 1, label: 'JANV' },
  { value: 2, label: 'FÉVR' },
  { value: 3, label: 'MARS' },
  { value: 4, label: 'AVR' },
  { value: 5, label: 'MAI' },
  { value: 6, label: 'JUIN' },
  { value: 7, label: 'JUIL' },
  { value: 8, label: 'AOÛT' },
  { value: 9, label: 'SEPT' },
  { value: 10, label: 'OCT' },
  { value: 11, label: 'NOV' },
  { value: 12, label: 'DÉC' },
]

/** Année suivant celle de la saisie (ex. 2026 → 2027). */
export function defaultExpiryYear(now = new Date()) {
  return now.getFullYear() + 1
}

/**
 * @param {number} year
 * @param {number} month 1–12
 */
export function toFirstOfMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function parseIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return null
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  if (!year || month < 1 || month > 12) return null
  return { year, month }
}

/**
 * Saisie rapide de péremption : année N+1 proposée, mois en un clic, jour = 01.
 *
 * @param {{
 *   value: string,
 *   onChange: (isoDate: string) => void,
 *   disabled?: boolean,
 *   resetKey?: string | number | boolean,
 * }} props
 */
export default function ExpiryMonthPicker({
  value,
  onChange,
  disabled = false,
  resetKey,
}) {
  const parsed = parseIsoDate(value)
  const [year, setYear] = useState(
    () => parsed?.year ?? defaultExpiryYear(),
  )

  useEffect(() => {
    const next = parseIsoDate(value)
    if (next) {
      setYear(next.year)
      return
    }
    setYear(defaultExpiryYear())
  }, [resetKey, value])

  const selectedMonth = parsed?.month ?? null

  function changeYear(delta) {
    const nextYear = year + delta
    setYear(nextYear)
    if (selectedMonth) {
      onChange(toFirstOfMonth(nextYear, selectedMonth))
    }
  }

  function selectMonth(month) {
    onChange(toFirstOfMonth(year, month))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">
          Date de péremption
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => changeYear(-1)}
            className="rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Année précédente"
          >
            ‹
          </button>
          <span className="min-w-[3.5rem] text-center text-sm font-semibold tabular-nums text-teal-800">
            {year}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => changeYear(1)}
            className="rounded-md px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Année suivante"
          >
            ›
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Jour fixé au 1<sup>er</sup> — choisissez le mois
      </p>

      <div
        className="grid grid-cols-4 gap-2 sm:grid-cols-6"
        role="listbox"
        aria-label="Mois de péremption"
      >
        {MONTHS.map((month) => {
          const selected = selectedMonth === month.value
          return (
            <button
              key={month.value}
              type="button"
              role="option"
              aria-selected={selected}
              disabled={disabled}
              onClick={() => selectMonth(month.value)}
              className={`rounded-lg px-1.5 py-2.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50 ${
                selected
                  ? 'bg-teal-700 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {month.label}
            </button>
          )
        })}
      </div>

      {selectedMonth ? (
        <p className="text-sm font-medium text-teal-800">
          → 01/{String(selectedMonth).padStart(2, '0')}/{year}
        </p>
      ) : null}
    </div>
  )
}
