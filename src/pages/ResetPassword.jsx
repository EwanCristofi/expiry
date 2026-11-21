import { useId, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { resetPassword } from '../services/authService.js'
import { useAuth } from '../contexts/AuthContext.jsx'

export default function ResetPassword() {
  const passwordId = useId()
  const confirmId = useId()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = String(searchParams.get('token') || '').trim()
  const { isAuthenticated } = useAuth()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return

    if (!token) {
      setError(
        'Ce lien est invalide ou a expiré. Veuillez faire une nouvelle demande.',
      )
      return
    }
    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères')
      return
    }
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas')
      return
    }

    setBusy(true)
    setError('')
    try {
      await resetPassword(token, password)
      setSuccess(true)
      window.setTimeout(() => {
        navigate('/login', { replace: true })
      }, 1800)
    } catch (err) {
      setError(err?.message || 'Réinitialisation impossible')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-gradient-to-br from-slate-100 via-teal-50 to-slate-200 px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.12),_transparent_55%)]" />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-lg backdrop-blur"
      >
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-teal-900">
            Expiry
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Choisissez un nouveau mot de passe
          </p>
        </div>

        {!token ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              Ce lien est invalide ou a expiré. Veuillez faire une nouvelle
              demande.
            </p>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-teal-800 hover:text-teal-900"
            >
              Retour à la connexion
            </Link>
          </div>
        ) : success ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900">
              Mot de passe mis à jour. Redirection vers la connexion…
            </p>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-teal-800 hover:text-teal-900"
            >
              Se connecter maintenant
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor={passwordId}
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Nouveau mot de passe
              </label>
              <input
                id={passwordId}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            <div>
              <label
                htmlFor={confirmId}
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Confirmer le mot de passe
              </label>
              <input
                id={confirmId}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            {error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-teal-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {busy ? 'Enregistrement…' : 'Enregistrer le mot de passe'}
            </button>

            <p className="text-center text-sm text-slate-500">
              <Link
                to="/login"
                className="font-medium text-teal-800 hover:text-teal-900"
              >
                Retour à la connexion
              </Link>
            </p>
          </div>
        )}
      </form>
    </div>
  )
}
