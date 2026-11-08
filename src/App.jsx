import { useCallback, useEffect, useRef, useState } from 'react'
import { Bolt, LogOut } from 'lucide-react'
import ConfirmScanModal from './components/ConfirmScanModal.jsx'
import ExpiryControlView from './components/ExpiryControlView.jsx'
import LoginForm from './components/LoginForm.jsx'
import ManualEntryModal from './components/ManualEntryModal.jsx'
import Scanner from './components/Scanner.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import ZoneSelector from './components/ZoneSelector.jsx'
import { useAuth } from './contexts/AuthContext.jsx'
import {
  listZones,
  resolveProductName,
  saveScan,
} from './services/productService.js'

const ACTIVE_ZONE_KEY = 'expiry.activeZoneId'

function readStoredZoneId() {
  try {
    const raw = window.localStorage.getItem(ACTIVE_ZONE_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export default function App() {
  const { isAuthenticated, loading: authLoading, pharmacy, user, logout } =
    useAuth()
  const [lastScan, setLastScan] = useState(null)
  const [resolving, setResolving] = useState(false)
  const [toast, setToast] = useState(null)
  const [flash, setFlash] = useState(false)
  const [modal, setModal] = useState(null)
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState('')
  const [isManualOpen, setIsManualOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [zones, setZones] = useState([])
  const [zonesLoading, setZonesLoading] = useState(true)
  const [activeZoneId, setActiveZoneId] = useState(readStoredZoneId)
  const [viewMode, setViewMode] = useState('scan')
  const [resumeCameraToken, setResumeCameraToken] = useState(0)
  const busyRef = useRef(false)
  const lastScanSourceRef = useRef('wedge')

  const requestCameraResume = useCallback(() => {
    if (lastScanSourceRef.current !== 'camera') return
    setResumeCameraToken((n) => n + 1)
  }, [])

  const activeZone = zones.find((z) => z.id === activeZoneId) ?? null

  const showSuccess = useCallback((message) => {
    setToast({ type: 'success', message })
    setFlash(true)
    window.setTimeout(() => setFlash(false), 450)
  }, [])

  const handleZonesChange = useCallback((rows) => {
    setZones(rows)
    setActiveZoneId((prev) => {
      if (prev && rows.some((z) => z.id === prev)) return prev
      const next = rows[0]?.id ?? null
      try {
        if (next == null) window.localStorage.removeItem(ACTIVE_ZONE_KEY)
        else window.localStorage.setItem(ACTIVE_ZONE_KEY, String(next))
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) {
      setZones([])
      setZonesLoading(false)
      return undefined
    }

    let cancelled = false
    setZonesLoading(true)
    listZones()
      .then((rows) => {
        if (cancelled) return
        handleZonesChange(rows)
      })
      .catch((err) => {
        if (cancelled) return
        setToast({
          type: 'error',
          message: err?.message || 'Impossible de charger les zones.',
        })
      })
      .finally(() => {
        if (!cancelled) setZonesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [handleZonesChange, isAuthenticated])

  useEffect(() => {
    if (!toast) return undefined
    const id = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(id)
  }, [toast])

  function selectZone(zoneId) {
    setActiveZoneId(zoneId)
    try {
      window.localStorage.setItem(ACTIVE_ZONE_KEY, String(zoneId))
    } catch {
      // ignore storage errors
    }
  }

  const persistScan = useCallback(
    async ({
      gtin,
      nomProduit,
      datePeremption,
      zoneId,
      zoneName,
      typeProduit,
      nomManuel,
    }) => {
      await saveScan({
        gtin,
        nomProduit,
        datePeremption,
        zoneId,
        typeProduit,
        nomManuel,
      })
      setLastScan({
        gtin,
        nomProduit,
        datePeremption,
        zoneId,
        zoneName,
        saved: true,
      })
      showSuccess(`${nomProduit} — ${zoneName}`)
    },
    [showSuccess],
  )

  const handleScan = useCallback(
    async (parsed, meta) => {
      if (!parsed?.gtin || busyRef.current) return

      lastScanSourceRef.current =
        meta?.source === 'camera' ? 'camera' : 'wedge'

      if (!activeZone) {
        setToast({
          type: 'error',
          message: 'Sélectionnez une zone de stockage avant de scanner.',
        })
        return
      }

      busyRef.current = true
      setResolving(true)
      setModalError('')
      setLastScan({
        gtin: parsed.gtin,
        datePeremption: parsed.datePeremption || '',
        rawCode: parsed.rawCode,
        nomProduit: null,
        zoneName: activeZone.nom_zone,
        saved: false,
      })

      try {
        const resolved = await resolveProductName(parsed.gtin)
        const nomProduit = resolved?.nomProduit ?? ''
        const typeProduit = resolved?.typeProduit ?? 'inconnu'
        const datePeremption = parsed.datePeremption || ''
        const nomInconnu = !resolved

        setLastScan((prev) => ({
          ...prev,
          nomProduit: nomProduit || null,
        }))

        if (!nomInconnu && datePeremption) {
          await persistScan({
            gtin: parsed.gtin,
            nomProduit,
            datePeremption,
            zoneId: activeZone.id,
            zoneName: activeZone.nom_zone,
            typeProduit,
            nomManuel: false,
          })
          busyRef.current = false
          requestCameraResume()
          return
        }

        setModal({
          gtin: parsed.gtin,
          initialNom: nomProduit,
          initialDate: datePeremption,
          nomInconnu,
          typeProduit: nomInconnu ? 'parapharma' : typeProduit,
          zoneId: activeZone.id,
          zoneName: activeZone.nom_zone,
        })
        // Keep busy while the confirmation modal is open
      } catch (err) {
        busyRef.current = false
        setToast({
          type: 'error',
          message:
            err?.message ||
            'Impossible de résoudre le produit. Réessayez.',
        })
      } finally {
        setResolving(false)
      }
    },
    [activeZone, persistScan, requestCameraResume],
  )

  async function handleConfirmModal({ nomProduit, datePeremption }) {
    if (!modal) return
    setSaving(true)
    setModalError('')
    try {
      await persistScan({
        gtin: modal.gtin,
        nomProduit,
        datePeremption,
        zoneId: modal.zoneId,
        zoneName: modal.zoneName,
        typeProduit: modal.typeProduit,
        nomManuel: modal.nomInconnu,
      })
      setModal(null)
      busyRef.current = false
      requestCameraResume()
    } catch (err) {
      setModalError(
        err?.message || 'Échec de l’enregistrement. Vérifiez la connexion.',
      )
    } finally {
      setSaving(false)
    }
  }

  function handleCancelModal() {
    if (saving) return
    setModal(null)
    setModalError('')
    busyRef.current = false
  }

  function handleManualSaved({
    gtin,
    nomProduit,
    datePeremption,
    zoneId,
    zoneName,
  }) {
    setLastScan({
      gtin,
      nomProduit,
      datePeremption,
      zoneId,
      zoneName,
      saved: true,
    })
    showSuccess(`${nomProduit} — ${zoneName}`)
  }

  function handleManualEntry() {
    if (!zones.length) {
      setToast({
        type: 'error',
        message: 'Créez une zone dans Paramètres avant la saisie manuelle.',
      })
      setIsSettingsOpen(true)
      return
    }
    setIsManualOpen(true)
  }

  async function handleLogout() {
    try {
      await logout()
    } catch (err) {
      setToast({
        type: 'error',
        message: err?.message || 'Déconnexion impossible.',
      })
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 text-sm text-slate-500">
        Chargement de la session…
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginForm />
  }

  return (
    <div
      className={`relative min-h-dvh bg-slate-50 text-slate-900 transition-[box-shadow] duration-300 ${
        flash ? 'shadow-[inset_0_0_0_4px_rgb(15_118_110)]' : ''
      }`}
    >
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-teal-900">
              Expiry
            </h1>
            <p className="text-sm text-slate-500">
              {pharmacy?.nom || 'Suivi des péremptions'}
              {user?.email ? (
                <span className="text-slate-400"> · {user.email}</span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Paramètres"
              title="Paramètres"
              className="inline-flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              <Bolt className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={handleLogout}
              aria-label="Se déconnecter"
              title="Se déconnecter"
              className="inline-flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              <LogOut className="size-5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="mx-auto max-w-3xl px-4 pb-4">
          <div
            className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1"
            role="tablist"
            aria-label="Mode d’utilisation"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'scan'}
              onClick={() => setViewMode('scan')}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
                viewMode === 'scan'
                  ? 'bg-white text-teal-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Scanner
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'control'}
              onClick={() => setViewMode('control')}
              className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
                viewMode === 'control'
                  ? 'bg-white text-teal-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Contrôle
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-8">
        {viewMode === 'scan' ? (
          <>
            <ZoneSelector
              zones={zones}
              activeZoneId={activeZoneId}
              onSelect={selectZone}
              loading={zonesLoading}
            />

            <Scanner
              onScan={handleScan}
              onManualEntry={handleManualEntry}
              disabled={!activeZone}
              resumeCameraToken={resumeCameraToken}
            />

            {resolving ? (
              <p className="text-sm text-slate-500" aria-live="polite">
                Recherche du produit…
              </p>
            ) : null}

            {lastScan ? (
              <section className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-sm font-medium text-slate-500">
                  Résultat du scan
                </h2>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">GTIN / CIP</dt>
                    <dd className="font-mono text-slate-900">
                      {lastScan.gtin || '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Produit</dt>
                    <dd className="text-right text-slate-900">
                      {lastScan.nomProduit || (
                        <span className="text-amber-700">Inconnu</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Péremption</dt>
                    <dd className="font-mono text-slate-900">
                      {lastScan.datePeremption || (
                        <span className="text-amber-700">À saisir</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Zone</dt>
                    <dd className="text-slate-900">
                      {lastScan.zoneName || '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Statut</dt>
                    <dd
                      className={
                        lastScan.saved
                          ? 'font-medium text-emerald-700'
                          : 'text-slate-500'
                      }
                    >
                      {lastScan.saved ? 'Enregistré' : 'En attente'}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}
          </>
        ) : (
          <ExpiryControlView
            zones={zones}
            zonesLoading={zonesLoading}
            initialZoneId={activeZoneId}
            onError={(message) => setToast({ type: 'error', message })}
          />
        )}
      </main>

      <ConfirmScanModal
        open={Boolean(modal)}
        gtin={modal?.gtin ?? ''}
        initialNom={modal?.initialNom ?? ''}
        initialDate={modal?.initialDate ?? ''}
        nomInconnu={Boolean(modal?.nomInconnu)}
        zoneName={modal?.zoneName ?? ''}
        saving={saving}
        error={modalError}
        onCancel={handleCancelModal}
        onConfirm={handleConfirmModal}
      />

      <ManualEntryModal
        open={isManualOpen}
        zones={zones}
        activeZoneId={activeZoneId}
        onClose={() => setIsManualOpen(false)}
        onSaved={handleManualSaved}
      />

      <SettingsModal
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onZonesChange={handleZonesChange}
      />

      {toast ? (
        <div
          className={`fixed bottom-6 left-1/2 z-[60] max-w-sm -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
            toast.type === 'success'
              ? 'bg-teal-800 text-white'
              : 'bg-red-700 text-white'
          }`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}
