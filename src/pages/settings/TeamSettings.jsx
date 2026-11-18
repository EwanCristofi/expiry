import { useEffect, useId, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext.jsx'
import {
  createTeamUser,
  deleteTeamUser,
  listTeamUsers,
  updateTeamUser,
} from '../../services/teamService.js'

const ROLE_OPTIONS = [
  { value: 'STAFF', label: 'STAFF' },
  { value: 'ADMIN', label: 'ADMIN' },
]

export default function TeamSettings() {
  const emailId = useId()
  const nomId = useId()
  const roleId = useId()
  const passwordId = useId()
  const { user } = useAuth()
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin'

  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdPassword, setCreatedPassword] = useState('')

  const [email, setEmail] = useState('')
  const [nom, setNom] = useState('')
  const [role, setRole] = useState('STAFF')
  const [password, setPassword] = useState('')

  const [editingId, setEditingId] = useState(null)
  const [editNom, setEditNom] = useState('')
  const [editRole, setEditRole] = useState('STAFF')

  useEffect(() => {
    if (!isAdmin) return undefined
    let cancelled = false
    setLoading(true)
    listTeamUsers()
      .then((rows) => {
        if (!cancelled) setMembers(rows)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Chargement impossible')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  if (!isAdmin) {
    return <Navigate to="/settings/zones" replace />
  }

  async function refresh() {
    const rows = await listTeamUsers()
    setMembers(rows)
    return rows
  }

  async function handleCreate(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setCreatedPassword('')
    try {
      const result = await createTeamUser({
        email,
        nom,
        role,
        password: password || undefined,
      })
      setEmail('')
      setNom('')
      setRole('STAFF')
      setPassword('')
      if (result?.temporaryPassword) {
        setCreatedPassword(result.temporaryPassword)
      }
      await refresh()
    } catch (err) {
      setError(err?.message || 'Création impossible')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(member) {
    setEditingId(member.id)
    setEditNom(member.nom || '')
    setEditRole(member.role || 'STAFF')
    setError('')
  }

  async function handleUpdate(event) {
    event.preventDefault()
    if (!editingId || busy) return
    setBusy(true)
    setError('')
    try {
      await updateTeamUser(editingId, {
        nom: editNom,
        role: editRole,
      })
      setEditingId(null)
      await refresh()
    } catch (err) {
      setError(err?.message || 'Mise à jour impossible')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(member) {
    if (busy) return
    const ok = window.confirm(
      `Supprimer le compte « ${member.email} » ? Cette action est définitive.`,
    )
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      await deleteTeamUser(member.id)
      if (editingId === member.id) setEditingId(null)
      await refresh()
    } catch (err) {
      setError(err?.message || 'Suppression impossible')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Équipe</h2>
        <p className="mt-1 text-sm text-slate-500">
          Invitez des collaborateurs rattachés à votre pharmacie.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      >
        <h3 className="text-sm font-semibold text-slate-800">
          Ajouter un membre
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label
              htmlFor={emailId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email
            </label>
            <input
              id={emailId}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </div>
          <div>
            <label
              htmlFor={nomId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Nom
            </label>
            <input
              id={nomId}
              type="text"
              required
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </div>
          <div>
            <label
              htmlFor={roleId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Rôle
            </label>
            <select
              id={roleId}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor={passwordId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Mot de passe (optionnel)
            </label>
            <input
              id={passwordId}
              type="text"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Généré automatiquement si vide"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {busy ? 'Création…' : 'Créer le compte'}
        </button>
      </form>

      {createdPassword ? (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Compte créé. Mot de passe temporaire :{' '}
          <span className="font-mono font-semibold">{createdPassword}</span>
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Chargement…</p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {members.map((member) => (
            <li key={member.id} className="px-3 py-3">
              {editingId === member.id ? (
                <form
                  onSubmit={handleUpdate}
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-medium text-slate-500">
                      Nom
                    </label>
                    <input
                      type="text"
                      required
                      value={editNom}
                      onChange={(e) => setEditNom(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">
                      Rôle
                    </label>
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
                    >
                      {ROLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                    >
                      Enregistrer
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      Annuler
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {member.nom || 'Sans nom'}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {member.email}
                    </p>
                    <p className="mt-1 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-slate-700">
                      {member.role}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(member)}
                      disabled={busy}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      Modifier
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(member)}
                      disabled={busy || member.id === user?.id}
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
    </section>
  )
}
