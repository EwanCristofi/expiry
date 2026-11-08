import { useEffect, useId, useState } from 'react'
import { saveScan } from '../services/productService.js'
import ExpiryMonthPicker from './ExpiryMonthPicker.jsx'

const EMPTY_FORM = {
  gtin: '',
  nomProduit: '',
  datePeremption: '',
  zoneId: '',
}

/**
 * Compact modal for registering a product that the scanner did not resolve.
 *
 * @param {{
 *   open: boolean,
 *   zones: Array<{ id: number, nom_zone: string }>,
 *   activeZoneId?: number | null,
 *   onClose: () => void,
 *   onSaved?: (payload: {
 *     gtin: string,
 *     nomProduit: string,
 *     datePeremption: string,
 *     zoneId: number,
 *     zoneName: string,
 *   }) => void,
 * }} props
 */
export default function ManualEntryModal({
  open,
  zones = [],
  activeZoneId = null,
  onClose,
  onSaved,
}) {
  const titleId = useId()
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setForm({
      ...EMPTY_FORM,
      zoneId: activeZoneId ? String(activeZoneId) : '',
    })
    setError('')
    setSaving(false)
  }, [open, activeZoneId])

  if (!open) return null

  const gtin = form.gtin.trim()
  const nomProduit = form.nomProduit.trim()
  const zoneId = Number(form.zoneId)
  const selectedZone = zones.find((z) => z.id === zoneId)
  const canSubmit =
    gtin.length > 0 &&
    nomProduit.length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.datePeremption) &&
    Number.isFinite(zoneId) &&
    zoneId > 0 &&
    Boolean(selectedZone)

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!canSubmit || saving) return

    setSaving(true)
    setError('')
    try {
      const payload = {
        gtin,
        nomProduit,
        datePeremption: form.datePeremption,
        zoneId,
        zoneName: selectedZone.nom_zone,
      }
      await saveScan({
        ...payload,
        typeProduit: 'parapharma',
        nomManuel: true,
      })
      onSaved?.(payload)
      onClose()
    } catch (err) {
      setError(
        err?.message || 'Échec de l’enregistrement. Vérifiez la connexion.',
      )
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    if (saving) return
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Saisie manuelle
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Pour les produits non reconnus par le scan.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 p-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Code GTIN / EAN / CIP
            </span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.gtin}
              onChange={(e) => updateField('gtin', e.target.value)}
              autoFocus
              required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              placeholder="Ex. 3400930000000"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Nom du produit
            </span>
            <input
              type="text"
              value={form.nomProduit}
              onChange={(e) => updateField('nomProduit', e.target.value)}
              required
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              placeholder="Ex. Crème hydratante 50 ml"
            />
          </label>

          <ExpiryMonthPicker
            value={form.datePeremption}
            onChange={(date) => updateField('datePeremption', date)}
            disabled={saving}
            resetKey={open}
          />

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Zone géographique
            </span>
            <select
              value={form.zoneId}
              onChange={(e) => updateField('zoneId', e.target.value)}
              required
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            >
              <option value="" disabled>
                Sélectionner une zone…
              </option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.nom_zone}
                </option>
              ))}
            </select>
          </label>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleCancel}
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
