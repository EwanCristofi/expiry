import { useEffect, useRef, useState } from 'react'
import {
  bulkCreateZones,
  createZone,
  deleteZone,
  listZones,
  renameZone,
  resetAllZonesVerified,
} from '../../services/productService.js'
import { parseZonesCsv } from '../../utils/parseZonesCsv.js'

/**
 * @param {{ onZonesChange?: (zones: Array<{ id: number, nom_zone: string, is_verified?: boolean }>) => void }} [props]
 */
export default function ZonesSettings({ onZonesChange }) {
  const fileInputRef = useRef(null)
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [importInfo, setImportInfo] = useState('')
  const [campaignInfo, setCampaignInfo] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listZones()
      .then((rows) => {
        if (cancelled) return
        setZones(rows)
        onZonesChange?.(rows)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message || 'Impossible de charger les zones.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [onZonesChange])

  async function refresh() {
    const rows = await listZones()
    setZones(rows)
    onZonesChange?.(rows)
    return rows
  }

  async function handleAdd(event) {
    event.preventDefault()
    const nom = newName.trim()
    if (!nom || busyId) return

    setBusyId('add')
    setError('')
    try {
      await createZone(nom)
      setNewName('')
      await refresh()
    } catch (err) {
      setError(err?.message || 'Échec de la création.')
    } finally {
      setBusyId(null)
    }
  }

  function startRename(zone) {
    setEditingId(zone.id)
    setEditingName(zone.nom_zone)
    setError('')
  }

  async function handleRename(event) {
    event.preventDefault()
    if (!editingId || busyId) return
    const nom = editingName.trim()
    if (!nom) return

    setBusyId(editingId)
    setError('')
    try {
      await renameZone(editingId, nom)
      setEditingId(null)
      setEditingName('')
      await refresh()
    } catch (err) {
      setError(err?.message || 'Échec du renommage.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(zone) {
    if (busyId) return
    const ok = window.confirm(
      `Supprimer la zone « ${zone.nom_zone} » ? Cette action est définitive.`,
    )
    if (!ok) return

    setBusyId(zone.id)
    setError('')
    try {
      await deleteZone(zone.id)
      if (editingId === zone.id) {
        setEditingId(null)
        setEditingName('')
      }
      await refresh()
    } catch (err) {
      setError(err?.message || 'Échec de la suppression.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleCsvFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busyId) return

    setBusyId('import')
    setError('')
    setImportInfo('')
    try {
      const text = await file.text()
      const { zones: parsed, errors } = parseZonesCsv(text)
      if (errors.length) {
        throw new Error(errors[0])
      }
      if (!parsed.length) {
        throw new Error('Aucune zone valide trouvée dans le fichier CSV.')
      }

      const result = await bulkCreateZones(parsed)
      await refresh()
      const parts = [`${result.inserted} zone(s) importée(s)`]
      if (result.skipped > 0) {
        parts.push(`${result.skipped} déjà existante(s) ignorée(s)`)
      }
      setImportInfo(parts.join(' · '))
    } catch (err) {
      setError(err?.message || 'Échec de l’import CSV.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleResetCampaign() {
    if (busyId) return
    const verifiedCount = zones.filter((z) => z.is_verified).length
    if (verifiedCount === 0) {
      setCampaignInfo('Toutes les zones sont déjà à faire.')
      return
    }
    const ok = window.confirm(
      `Réinitialiser le statut de ${verifiedCount} zone(s) vérifiée(s) ?\nToutes repasseront à « à faire » pour une nouvelle campagne de contrôle.`,
    )
    if (!ok) return

    setBusyId('campaign')
    setError('')
    setCampaignInfo('')
    try {
      const result = await resetAllZonesVerified()
      await refresh()
      setCampaignInfo(
        result.updated > 0
          ? `Campagne réinitialisée — ${result.updated} zone(s) remise(s) à faire.`
          : 'Aucune zone à réinitialiser.',
      )
    } catch (err) {
      setError(err?.message || 'Échec de la réinitialisation.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Zones de stockage
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Organisez les emplacements scannés dans votre pharmacie.
        </p>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nouvelle zone (ex. Frigo)"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
        />
        <button
          type="submit"
          disabled={!newName.trim() || Boolean(busyId)}
          className="shrink-0 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
        >
          Ajouter
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={handleCsvFile}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={Boolean(busyId)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {busyId === 'import' ? 'Import…' : 'Importer via CSV'}
        </button>
        <a
          href="/modele_zones.csv"
          download="modele_zones.csv"
          className="text-sm font-medium text-teal-700 hover:text-teal-800 hover:underline"
        >
          Télécharger le modèle CSV
        </a>
      </div>

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {importInfo ? (
        <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
          {importInfo}
        </p>
      ) : null}

      {campaignInfo ? (
        <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">
          {campaignInfo}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Chargement…</p>
      ) : zones.length === 0 ? (
        <p className="rounded-lg bg-white px-3 py-3 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
          Aucune zone pour l’instant. Ajoutez-en une ci-dessus.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {zones.map((zone) => (
            <li key={zone.id} className="px-3 py-3">
              {editingId === zone.id ? (
                <form
                  onSubmit={handleRename}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    autoFocus
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={!editingName.trim() || busyId === zone.id}
                      className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                    >
                      Enregistrer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null)
                        setEditingName('')
                      }}
                      disabled={busyId === zone.id}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      Annuler
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-900">
                    <span
                      className="shrink-0"
                      aria-label={
                        zone.is_verified ? 'Zone vérifiée' : 'Zone à faire'
                      }
                      title={zone.is_verified ? 'Vérifiée' : 'À faire'}
                    >
                      {zone.is_verified ? '🟢' : '⚪'}
                    </span>
                    <span className="truncate">{zone.nom_zone}</span>
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => startRename(zone)}
                      disabled={Boolean(busyId)}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      Renommer
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(zone)}
                      disabled={Boolean(busyId)}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Supprimer
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {zones.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Campagne de contrôle
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Remet toutes les zones à « à faire » pour démarrer un nouveau cycle
            (1 à 2 fois par an).
          </p>
          <button
            type="button"
            onClick={handleResetCampaign}
            disabled={Boolean(busyId)}
            className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busyId === 'campaign'
              ? 'Réinitialisation…'
              : 'Réinitialiser le statut des zones'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
