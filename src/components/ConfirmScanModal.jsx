import { useEffect, useId, useState } from 'react'
import ExpiryMonthPicker from './ExpiryMonthPicker.jsx'

/**
 * Modal to confirm / complete product name and expiry before saving a scan.
 *
 * @param {{
 *   open: boolean,
 *   gtin: string,
 *   initialNom: string,
 *   initialDate: string,
 *   nomInconnu: boolean,
 *   zoneName?: string,
 *   saving: boolean,
 *   error: string,
 *   onCancel: () => void,
 *   onConfirm: (values: { nomProduit: string, datePeremption: string }) => void,
 * }} props
 */
export default function ConfirmScanModal({
  open,
  gtin,
  initialNom,
  initialDate,
  nomInconnu,
  zoneName = '',
  saving,
  error,
  onCancel,
  onConfirm,
}) {
  const titleId = useId()
  const [nomProduit, setNomProduit] = useState(initialNom)
  const [datePeremption, setDatePeremption] = useState(initialDate)

  useEffect(() => {
    if (!open) return
    setNomProduit(initialNom)
    setDatePeremption(initialDate)
  }, [open, initialNom, initialDate])

  if (!open) return null

  const needsDate = !/^\d{4}-\d{2}-\d{2}$/.test(initialDate)
  const canSubmit =
    nomProduit.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(datePeremption)

  function handleSubmit(event) {
    event.preventDefault()
    if (!canSubmit || saving) return
    onConfirm({
      nomProduit: nomProduit.trim(),
      datePeremption,
    })
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
            Confirmer le scan
          </h2>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{gtin}</p>
          {zoneName ? (
            <p className="mt-1 text-xs font-medium text-teal-700">
              Zone : {zoneName}
            </p>
          ) : null}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          {nomInconnu ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Produit inconnu — saisissez le nom pour l’enregistrer et le
              reconnaître aux prochains scans.
            </p>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Nom du produit
            </span>
            <input
              type="text"
              value={nomProduit}
              onChange={(e) => setNomProduit(e.target.value)}
              autoFocus={nomInconnu || !initialNom}
              required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              placeholder="Ex. Doliprane 1000 mg"
            />
          </label>

          {needsDate ? (
            <ExpiryMonthPicker
              value={datePeremption}
              onChange={setDatePeremption}
              disabled={saving}
              resetKey={open}
            />
          ) : (
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Date de péremption
              </span>
              <p className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900">
                {formatDisplayDate(datePeremption)}
              </p>
            </div>
          )}

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function formatDisplayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return iso || '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}
