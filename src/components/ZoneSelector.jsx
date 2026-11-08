/**
 * Sélecteur de zone géographique active (menu déroulant).
 *
 * @param {{
 *   zones: Array<{ id: number, nom_zone: string }>,
 *   activeZoneId: number | null,
 *   onSelect: (zoneId: number) => void,
 *   loading?: boolean,
 * }} props
 */
export default function ZoneSelector({
  zones,
  activeZoneId,
  onSelect,
  loading = false,
}) {
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
    <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">Zone active</p>
        {activeZoneId ? (
          <span className="text-xs font-medium text-teal-700">
            Prête pour les scans
          </span>
        ) : (
          <span className="text-xs font-medium text-amber-700">
            Sélection requise
          </span>
        )}
      </div>
      <p className="mt-1 text-base text-slate-800">
        Choisissez où vous rangez les produits, puis scannez en série.
      </p>
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
              {zone.nom_zone}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
