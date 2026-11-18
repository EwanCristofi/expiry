import { NavLink, Outlet, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import TrialBanner from '../../components/TrialBanner.jsx'
import { useAuth } from '../../contexts/AuthContext.jsx'

const tabClass = ({ isActive }) =>
  `rounded-lg px-3 py-2 text-sm font-semibold transition ${
    isActive
      ? 'bg-white text-teal-900 shadow-sm'
      : 'text-slate-600 hover:text-slate-900'
  }`

export default function SettingsLayout() {
  const { pharmacy, user } = useAuth()
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin'

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <TrialBanner />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-teal-900">
              Paramètres
            </h1>
            <p className="text-sm text-slate-500">
              {pharmacy?.nom || 'Espace pharmacie'}
            </p>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Retour
          </Link>
        </div>
        <div className="mx-auto max-w-3xl px-4 pb-4">
          <div
            className={`grid gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 ${
              isAdmin ? 'grid-cols-2' : 'grid-cols-1'
            }`}
            role="tablist"
            aria-label="Sections paramètres"
          >
            <NavLink to="/settings/zones" className={tabClass} end>
              Zones
            </NavLink>
            {isAdmin ? (
              <NavLink to="/settings/team" className={tabClass}>
                Équipe
              </NavLink>
            ) : null}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
