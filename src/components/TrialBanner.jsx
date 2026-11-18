import { useAuth } from '../contexts/AuthContext.jsx'

/**
 * @param {string | null | undefined} trialEndsAt
 */
export function remainingTrialDays(trialEndsAt) {
  if (!trialEndsAt) return 0
  const ms = new Date(trialEndsAt).getTime() - Date.now()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

export default function TrialBanner() {
  const { pharmacy } = useAuth()

  if (!pharmacy || pharmacy.status !== 'TRIAL') return null

  const days = remainingTrialDays(pharmacy.trial_ends_at)
  const expired = days <= 0

  return (
    <div
      className={`sticky top-0 z-40 border-b px-4 py-2.5 text-center text-sm font-medium shadow-sm ${
        expired
          ? 'border-red-200 bg-red-700 text-white'
          : 'border-amber-200 bg-amber-50 text-amber-950'
      }`}
      role="status"
      aria-live="polite"
    >
      {expired ? (
        <span>
          Votre période d’essai a expiré. Souscrivez pour retrouver l’accès à
          Expiry.
        </span>
      ) : (
        <span>
          Essai gratuit —{' '}
          {days === 1
            ? '1 jour restant'
            : `${days} jours restants`}
          .
        </span>
      )}
    </div>
  )
}
