import { useId, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'
import { requestPasswordReset } from '../services/authService.js'

export default function LoginForm() {
  const emailId = useId()
  const passwordId = useId()
  const forgotEmailId = useId()
  const { login, isAuthenticated } = useAuth()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  function showForgot() {
    setMode('forgot')
    setError('')
    setInfo('')
    setPassword('')
  }

  function showLogin() {
    setMode('login')
    setError('')
    setInfo('')
  }

  async function handleLogin(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setInfo('')
    try {
      await login(email, password)
    } catch (err) {
      setError(err?.message || 'Connexion impossible')
    } finally {
      setBusy(false)
    }
  }

  async function handleForgot(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setInfo('')
    try {
      const result = await requestPasswordReset(email)
      setInfo(
        result?.message ||
          'Si un compte est associé à cette adresse, un lien de réinitialisation vient d’être envoyé.',
      )
    } catch (err) {
      setError(err?.message || 'Demande impossible')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-gradient-to-br from-slate-100 via-teal-50 to-slate-200 px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.12),_transparent_55%)]" />
      <form
        onSubmit={mode === 'login' ? handleLogin : handleForgot}
        className="relative w-full max-w-sm rounded-2xl border border-slate-200/80 bg-white/95 p-6 shadow-lg backdrop-blur"
      >
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-teal-900">
            Expiry
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'login'
              ? 'Connexion à l’espace de votre pharmacie'
              : 'Réinitialisation du mot de passe'}
          </p>
        </div>

        {mode === 'login' ? (
          <div className="space-y-4">
            <div>
              <label
                htmlFor={emailId}
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Email
              </label>
              <input
                id={emailId}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  htmlFor={passwordId}
                  className="block text-sm font-medium text-slate-700"
                >
                  Mot de passe
                </label>
              </div>
              <input
                id={passwordId}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              />
              <div className="mt-1.5 flex justify-end">
                <button
                  type="button"
                  onClick={showForgot}
                  className="text-xs font-medium text-slate-500 hover:text-teal-800"
                >
                  Mot de passe oublié ?
                </button>
              </div>
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
              {busy ? 'Connexion…' : 'Se connecter'}
            </button>

            <p className="text-center text-sm text-slate-500">
              Nouvelle pharmacie ?{' '}
              <Link
                to="/register"
                className="font-medium text-teal-800 hover:text-teal-900"
              >
                Créer mon espace
              </Link>
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label
                htmlFor={forgotEmailId}
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Email
              </label>
              <input
                id={forgotEmailId}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            {error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            ) : null}

            {info ? (
              <p className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900">
                {info} Pensez à vérifier vos spams.
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-teal-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {busy ? 'Envoi…' : 'Envoyer le lien'}
            </button>

            <p className="text-center text-sm text-slate-500">
              <button
                type="button"
                onClick={showLogin}
                className="font-medium text-teal-800 hover:text-teal-900"
              >
                Retour à la connexion
              </button>
            </p>
          </div>
        )}
      </form>
    </div>
  )
}
