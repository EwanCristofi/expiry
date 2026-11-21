import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, LogOut, RefreshCw, Search } from 'lucide-react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import {
  fetchAdminDashboard,
  updatePharmacyStatus,
} from '../services/adminService.js'

/** @typedef {'TRIAL' | 'ACTIVE' | 'SUSPENDED'} PharmacyStatus */

/**
 * @param {string | null | undefined} iso
 */
function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * @param {string | null | undefined} iso
 */
function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * @param {string | null | undefined} iso
 */
function relativeActivity(iso) {
  if (!iso) return { label: 'Jamais', days: Infinity }
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return { label: '—', days: 0 }
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days <= 0) return { label: 'Aujourd’hui', days: 0 }
  if (days === 1) return { label: 'Hier', days: 1 }
  if (days < 7) return { label: `Il y a ${days} j`, days }
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return { label: `Il y a ${weeks} sem.`, days }
  }
  const months = Math.floor(days / 30)
  return { label: `Il y a ${months} mois`, days }
}

/**
 * @param {PharmacyStatus} status
 */
function statusBadgeClass(status) {
  switch (status) {
    case 'TRIAL':
      return 'bg-amber-50 text-amber-800 ring-amber-200'
    case 'SUSPENDED':
      return 'bg-red-50 text-red-800 ring-red-200'
    default:
      return 'bg-teal-50 text-teal-800 ring-teal-200'
  }
}

/**
 * @param {PharmacyStatus} status
 */
function statusLabel(status) {
  switch (status) {
    case 'TRIAL':
      return 'Essai'
    case 'SUSPENDED':
      return 'Suspendu'
    default:
      return 'Actif'
  }
}

export default function Admin() {
  const { user, logout, isAuthenticated } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [kpis, setKpis] = useState(null)
  const [pharmacies, setPharmacies] = useState([])
  const [health, setHealth] = useState(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortKey, setSortKey] = useState('last_activity_at')
  const [sortDir, setSortDir] = useState('desc')
  const [busyId, setBusyId] = useState(null)
  const [toast, setToast] = useState(null)

  const isPlatformAdmin = Boolean(user?.is_platform_admin)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchAdminDashboard()
      setKpis(data.kpis)
      setPharmacies(Array.isArray(data.pharmacies) ? data.pharmacies : [])
      setHealth(data.health)
    } catch (err) {
      setError(err?.message || 'Impossible de charger le tableau de bord')
      if (err?.status === 403) {
        setError('Accès refusé')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated || !isPlatformAdmin) return
    load()
  }, [isAuthenticated, isPlatformAdmin, load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = pharmacies
    if (statusFilter !== 'all') {
      rows = rows.filter((p) => p.status === statusFilter)
    }
    if (q) {
      rows = rows.filter((p) => {
        const hay = `${p.nom || ''} ${p.contact_email || ''} ${p.code_client || ''}`.toLowerCase()
        return hay.includes(q)
      })
    }

    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv), 'fr') * dir
    })
    return sorted
  }, [pharmacies, query, statusFilter, sortKey, sortDir])

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'nom' ? 'asc' : 'desc')
    }
  }

  async function handleToggleStatus(pharmacy) {
    const next =
      pharmacy.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED'
    const action =
      next === 'SUSPENDED'
        ? `Suspendre « ${pharmacy.nom} » ?`
        : `Réactiver « ${pharmacy.nom} » ?`
    if (!window.confirm(action)) return

    setBusyId(pharmacy.id)
    try {
      const updated = await updatePharmacyStatus(pharmacy.id, next)
      setPharmacies((prev) =>
        prev.map((p) =>
          p.id === pharmacy.id
            ? {
                ...p,
                status: updated.status,
                status_label: updated.status_label,
              }
            : p,
        ),
      )
      setToast({
        type: 'success',
        message:
          next === 'SUSPENDED'
            ? `${pharmacy.nom} suspendue`
            : `${pharmacy.nom} activée`,
      })
    } catch (err) {
      setToast({
        type: 'error',
        message: err?.message || 'Mise à jour impossible',
      })
    } finally {
      setBusyId(null)
      window.setTimeout(() => setToast(null), 2800)
    }
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!isPlatformAdmin) {
    return <Navigate to="/" replace />
  }

  const manualRate =
    kpis?.manual_rate_pct == null
      ? null
      : Number(kpis.manual_rate_pct)

  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-50 via-teal-50/40 to-slate-100 text-slate-900">
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              Expiry
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-teal-950">
              Administration
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Suivi des pharmacies clientes et de l’activité
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw
                className={`size-4 ${loading ? 'animate-spin' : ''}`}
                aria-hidden
              />
              Actualiser
            </button>
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <ArrowLeft className="size-4" aria-hidden />
              App
            </Link>
            <button
              type="button"
              onClick={() => logout()}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <LogOut className="size-4" aria-hidden />
              Déconnexion
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Pharmacies actives (7j)"
            value={
              kpis
                ? `${kpis.pharmacies_active_7d} / ${kpis.pharmacies_total}`
                : '—'
            }
            hint="Au moins un scan ou ajout sur 7 jours"
            loading={loading}
          />
          <KpiCard
            label="Scans / ajouts (7j)"
            value={kpis ? String(kpis.scans_7d) : '—'}
            hint="Lignes touchées toutes officines"
            loading={loading}
          />
          <KpiCard
            label="Lignes actives en base"
            value={kpis ? String(kpis.active_lines) : '—'}
            hint={
              kpis
                ? `Moy. ${kpis.active_lines_avg_per_pharmacy} / pharmacie · fenêtre 15 mois`
                : 'Fenêtre glissante 15 mois'
            }
            loading={loading}
          />
          <KpiCard
            label="Taux de saisie manuelle"
            value={
              manualRate == null
                ? kpis
                  ? `${kpis.manual_entries} manuels`
                  : '—'
                : `${manualRate} %`
            }
            hint={
              kpis
                ? `${kpis.manual_entries} / ${kpis.scans_total} lignes (is_manual)`
                : 'Nom ou date saisis manuellement'
            }
            loading={loading}
          />
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white/95 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Pharmacies
              </h2>
              <p className="text-sm text-slate-500">
                {filtered.length} résultat{filtered.length > 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="relative block min-w-[220px]">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Rechercher nom ou email…"
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pr-3 pl-9 text-sm outline-none ring-teal-700/20 focus:ring-2"
                />
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-teal-700/20 focus:ring-2"
              >
                <option value="all">Tous les statuts</option>
                <option value="TRIAL">Essai</option>
                <option value="ACTIVE">Actif</option>
                <option value="SUSPENDED">Suspendu</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <SortTh
                    label="Pharmacie"
                    active={sortKey === 'nom'}
                    dir={sortDir}
                    onClick={() => toggleSort('nom')}
                  />
                  <SortTh
                    label="Statut"
                    active={sortKey === 'status'}
                    dir={sortDir}
                    onClick={() => toggleSort('status')}
                  />
                  <SortTh
                    label="Dernière activité"
                    active={sortKey === 'last_activity_at'}
                    dir={sortDir}
                    onClick={() => toggleSort('last_activity_at')}
                  />
                  <SortTh
                    label="Activité récente"
                    active={sortKey === 'scans_7d'}
                    dir={sortDir}
                    onClick={() => toggleSort('scans_7d')}
                  />
                  <SortTh
                    label="Périmés actifs"
                    active={sortKey === 'active_lines'}
                    dir={sortDir}
                    onClick={() => toggleSort('active_lines')}
                  />
                  <SortTh
                    label="À traiter (< 3 mois)"
                    active={sortKey === 'due_90d'}
                    dir={sortDir}
                    onClick={() => toggleSort('due_90d')}
                  />
                  <th className="px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && pharmacies.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-slate-500"
                    >
                      Chargement…
                    </td>
                  </tr>
                ) : null}
                {!loading && filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-4 py-10 text-center text-slate-500"
                    >
                      Aucune pharmacie ne correspond aux filtres.
                    </td>
                  </tr>
                ) : null}
                {filtered.map((p) => {
                  const activity = relativeActivity(p.last_activity_at)
                  const stale =
                    activity.days > 14
                      ? activity.days > 30
                        ? 'text-red-700'
                        : 'text-amber-700'
                      : 'text-slate-700'
                  return (
                    <tr key={p.id} className="align-top hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">
                          {p.nom}
                        </div>
                        <div className="text-xs text-slate-500">
                          {p.contact_email || '—'}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          Créée le {formatDate(p.created_at)}
                          {p.code_client ? ` · ${p.code_client}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${statusBadgeClass(p.status)}`}
                        >
                          {p.status_label || statusLabel(p.status)}
                        </span>
                      </td>
                      <td className={`px-4 py-3 ${stale}`}>
                        <div className="font-medium">{activity.label}</div>
                        <div className="text-xs text-slate-400">
                          {formatDateTime(p.last_activity_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-800">
                        <div>
                          <span className="font-semibold">{p.scans_7d}</span>
                          <span className="text-slate-400"> / 7j</span>
                        </div>
                        <div className="text-xs text-slate-500">
                          {p.scans_30d} / 30j
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 tabular-nums">
                          <span className="font-semibold text-slate-900">
                            {p.active_lines}
                          </span>
                          {p.active_lines < 50 ? (
                            <span
                              className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-800 uppercase"
                              title="Moins de 50 lignes — démarrage possible incomplet"
                            >
                              Faible
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums font-medium text-slate-800">
                        {p.due_90d}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          disabled={busyId === p.id}
                          onClick={() => handleToggleStatus(p)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${
                            p.status === 'SUSPENDED'
                              ? 'bg-teal-800 text-white hover:bg-teal-900'
                              : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {busyId === p.id
                            ? '…'
                            : p.status === 'SUSPENDED'
                              ? 'Activer'
                              : 'Suspendre'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200/70 bg-white/70 px-4 py-4 text-sm text-slate-600">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Santé & maintenance
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-slate-500">Plus ancienne péremption en base</p>
              <p className="font-medium text-slate-800">
                {health?.oldest_expiry_date
                  ? formatDate(health.oldest_expiry_date)
                  : '—'}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                La purge cron retire les lignes périmées depuis plus de 3 mois.
              </p>
            </div>
            <div>
              <p className="text-slate-500">Volume des tables principales</p>
              <ul className="mt-1 space-y-0.5 tabular-nums text-slate-800">
                <li>
                  pharmacies · {health?.table_counts?.pharmacies ?? '—'}
                </li>
                <li>users · {health?.table_counts?.users ?? '—'}</li>
                <li>
                  zones_stockage · {health?.table_counts?.zones_stockage ?? '—'}
                </li>
                <li>scans · {health?.table_counts?.scans ?? '—'}</li>
              </ul>
              {health?.oldest_scan_at ? (
                <p className="mt-2 text-xs text-slate-400">
                  Plus ancien scan : {formatDateTime(health.oldest_scan_at)}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      {toast ? (
        <div
          className={`fixed bottom-6 left-1/2 z-[60] max-w-sm -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
            toast.type === 'success'
              ? 'bg-teal-800 text-white'
              : 'bg-red-700 text-white'
          }`}
          role="status"
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}

function KpiCard({ label, value, hint, loading }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white/95 p-4 shadow-sm">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-teal-950 tabular-nums">
        {loading ? '…' : value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}

function SortTh({ label, active, dir, onClick }) {
  return (
    <th className="px-4 py-3">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 font-semibold tracking-wide uppercase transition ${
          active ? 'text-teal-800' : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {label}
        {active ? (
          <span aria-hidden className="text-[10px]">
            {dir === 'asc' ? '▲' : '▼'}
          </span>
        ) : null}
      </button>
    </th>
  )
}
