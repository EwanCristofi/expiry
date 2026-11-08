import { useEffect, useId, useState } from 'react'
import {
  createZone,
  deleteZone,
  listZones,
  renameZone,
} from '../services/productService.js'

/**
 * Gestion des zones géographiques de stockage.
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onZonesChange?: (zones: Array<{ id: number, nom_zone: string }>) => void,
 * }} props
 */
export default function SettingsModal({ open, onClose, onZonesChange }) {
  const titleId = useId()
  const [zones, setZones] = useState([])
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setNewName('')
    setEditingId(null)
    setEditingName('')
    setError('')
    setLoading(true)

    listZones()
      .then((rows) => {
        setZones(rows)
        onZonesChange?.(rows)
      })
      .catch((err) => {
        setError(err?.message || 'Impossible de charger les zones.')
      })
      .finally(() => setLoading(false))
  }, [open, onZonesChange])

  if (!open) return null

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              Paramètres
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Zones géographiques de stockage
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Fermer
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
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

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="text-sm text-slate-500">Chargement…</p>
          ) : zones.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-600">
              Aucune zone pour l’instant. Ajoutez-en une ci-dessus.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
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
                      <span className="text-sm font-medium text-slate-900">
                        {zone.nom_zone}
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
        </div>
      </div>
    </div>
  )
}
