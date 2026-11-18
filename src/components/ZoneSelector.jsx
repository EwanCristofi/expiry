import { useState } from 'react'

/**
 * Pastille visuelle dans le menu (texte de statut volontairement omis).
 * @param {boolean} verified
 */
function zoneOptionLabel(zone) {
  const pill = zone.is_verified ? '🟢' : '⚪'
  return `${pill} ${zone.nom_zone}`
}

/**
 * Sélecteur de zone géographique active (menu déroulant).
 *
 * @param {{
 *   zones: Array<{ id: number, nom_zone: string, is_verified?: boolean }>,
 *   activeZoneId: number | null,
 *   onSelect: (zoneId: number) => void,
 *   onToggleVerified?: (zoneId: number, isVerified: boolean) => Promise<void> | void,
 *   loading?: boolean,
 *   needsZoneCheck?: boolean,
 * }} props
 */
export default function ZoneSelector({
  zones,
  activeZoneId,
  onSelect,
  onToggleVerified,
  loading = false,
  needsZoneCheck = false,
}) {
  const [busy, setBusy] = useState(false)
  const activeZone = zones.find((z) => z.id === activeZoneId) ?? null
  const isVerified = Boolean(activeZone?.is_verified)

  async function handleToggleVerified() {
    if (!activeZone || !onToggleVerified || busy) return
    setBusy(true)
    try {
      await onToggleVerified(activeZone.id, !isVerified)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-500">Chargement des zones…</p>
      </div>
    )
  }

  if (!zones.length) {
    return (
      <div className="w-full max-w-lg rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
        <p className="text-sm font-medium text-amber-900">
          Aucune zone de stockage
        </p>
        <p className="mt-1 text-sm text-amber-800">
          Créez une zone dans Paramètres avant de scanner.
        </p>
      </div>
    )
  }

  return (
    <div
      className={`w-full max-w-lg rounded-xl border bg-white p-5 shadow-sm transition-[box-shadow,border-color] ${
        needsZoneCheck
          ? 'border-teal-400 ring-4 ring-teal-500/15 animate-pulse'
          : 'border-slate-200'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">Zone de travail</p>
        {!activeZoneId ? (
          <span className="text-xs font-medium text-amber-700">
            Sélection requise
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-base text-slate-800">
        Choisissez votre zone, puis scannez.
      </p>
      {needsZoneCheck ? (
        <p className="mt-2 text-xs text-slate-500" role="status">
          Si la zone ci-dessous est correcte, vous pouvez commencer à scanner en
          série.
        </p>
      ) : null}
      <label className="mt-4 block space-y-1.5">
        <span className="sr-only">Zone de stockage</span>
        <select
          value={activeZoneId ?? ''}
          onChange={(e) => {
            const id = Number(e.target.value)
            if (Number.isFinite(id) && id > 0) onSelect(id)
          }}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
        >
          <option value="" disabled>
            Sélectionner une zone…
          </option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zoneOptionLabel(zone)}
            </option>
          ))}
        </select>
      </label>

      {activeZone && onToggleVerified ? (
        <div className="mt-3">
          {isVerified ? (
            <button
              type="button"
              onClick={handleToggleVerified}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-50 disabled:opacity-50"
            >
              <span aria-hidden="true">✓</span>
              Zone vérifiée
              <span className="font-normal text-slate-400">· annuler</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleToggleVerified}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-100 disabled:opacity-50"
            >
              <span aria-hidden="true">✓</span>
              Marquer la zone comme vérifiée
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
