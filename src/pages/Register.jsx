import { useEffect, useId, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext.jsx'

const SIRET_API =
  'https://recherche-entreprises.api.gouv.fr/search'

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}

/**
 * @param {string} siret
 * @param {AbortSignal} [signal]
 */
async function lookupSiret(siret, signal) {
  const response = await fetch(
    `${SIRET_API}?q=${encodeURIComponent(siret)}`,
    { signal },
  )
  if (!response.ok) {
    throw new Error('Vérification SIRET indisponible')
  }
  const data = await response.json()
  const result = Array.isArray(data?.results) ? data.results[0] : null
  if (!result) {
    throw new Error('SIRET introuvable')
  }

  const matching =
    Array.isArray(result.matching_etablissements) &&
    result.matching_etablissements.find((e) => e?.siret === siret)

  const raisonSociale =
    matching?.liste_enseignes?.[0] ||
    result.nom_raison_sociale ||
    result.nom_complet ||
    ''

  if (!raisonSociale) {
    throw new Error('SIRET introuvable')
  }

  return String(raisonSociale)
}

export default function Register() {
  const siretId = useId()
  const pharmacyId = useId()
  const emailId = useId()
  const passwordId = useId()
  const { register, isAuthenticated } = useAuth()
  const [siret, setSiret] = useState('')
  const [nom, setNom] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [siretStatus, setSiretStatus] = useState('idle')
  const [siretError, setSiretError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lookupSeq = useRef(0)

  const siretDigits = digitsOnly(siret)
  const siretReady = siretStatus === 'valid' && siretDigits.length === 14

  useEffect(() => {
    if (siretDigits.length !== 14) {
      setSiretStatus(siretDigits.length === 0 ? 'idle' : 'incomplete')
      setSiretError(
        siretDigits.length === 0
          ? ''
          : 'Le SIRET doit contenir exactement 14 chiffres',
      )
      return undefined
    }

    const seq = ++lookupSeq.current
    const controller = new AbortController()
    setSiretStatus('loading')
    setSiretError('')

    const timer = window.setTimeout(() => {
      lookupSiret(siretDigits, controller.signal)
        .then((raisonSociale) => {
          if (seq !== lookupSeq.current) return
          setNom(raisonSociale)
          setSiretStatus('valid')
          setSiretError('')
        })
        .catch((err) => {
          if (seq !== lookupSeq.current) return
          if (err?.name === 'AbortError') return
          setSiretStatus('invalid')
          setSiretError(err?.message || 'SIRET invalide ou introuvable')
        })
    }, 300)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [siretDigits])

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return

    if (!siretReady) {
      setError(
        siretError ||
          'Vérifiez le numéro SIRET avant de créer votre espace',
      )
      return
    }

    setBusy(true)
    setError('')
    try {
      await register({
        nom,
        email,
        password,
        siret: siretDigits,
      })
    } catch (err) {
      setError(err?.message || 'Inscription impossible')
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
            Créez l’espace de votre pharmacie — essai 7 jours
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor={siretId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Numéro SIRET (14 chiffres)
            </label>
            <input
              id={siretId}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              required
              maxLength={14}
              pattern="\d{14}"
              value={siret}
              onChange={(e) => setSiret(digitsOnly(e.target.value).slice(0, 14))}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
            {siretStatus === 'loading' ? (
              <p className="mt-1.5 text-xs text-slate-500">
                Vérification du SIRET…
              </p>
            ) : null}
            {siretStatus === 'valid' ? (
              <p className="mt-1.5 text-xs text-emerald-700">
                Établissement trouvé
              </p>
            ) : null}
            {siretError ? (
              <p className="mt-1.5 text-xs text-red-700">{siretError}</p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor={pharmacyId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Nom de la pharmacie
            </label>
            <input
              id={pharmacyId}
              type="text"
              autoComplete="organization"
              required
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
            />
          </div>

          <div>
            <label
              htmlFor={emailId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email administrateur
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
            <label
              htmlFor={passwordId}
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Mot de passe
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
            <p className="mt-1.5 text-xs text-slate-500">
              Au moins 8 caractères
            </p>
          </div>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || !siretReady}
            className="w-full rounded-lg bg-teal-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {busy ? 'Création…' : 'Créer mon espace pharmacie'}
          </button>

          <p className="text-center text-sm text-slate-500">
            Déjà un compte ?{' '}
            <Link
              to="/login"
              className="font-medium text-teal-800 hover:text-teal-900"
            >
              Se connecter
            </Link>
          </p>
        </div>
      </form>
    </div>
  )
}
