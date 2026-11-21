import { useCallback, useEffect, useRef, useState } from 'react'
import { Bolt, Download, LayoutDashboard, LogOut, Search } from 'lucide-react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import ConfirmScanModal from './components/ConfirmScanModal.jsx'
import ExpiryControlView from './components/ExpiryControlView.jsx'
import ExportPdfModal from './components/ExportPdfModal.jsx'
import LoginForm from './components/LoginForm.jsx'
import ManualEntryModal from './components/ManualEntryModal.jsx'
import Scanner from './components/Scanner.jsx'
import SearchModal from './components/SearchModal.jsx'
import TrialBanner, {
  remainingTrialDays,
} from './components/TrialBanner.jsx'
import ZoneSelector from './components/ZoneSelector.jsx'
import { useAuth } from './contexts/AuthContext.jsx'
import Admin from './pages/Admin.jsx'
import Register from './pages/Register.jsx'
import ResetPassword from './pages/ResetPassword.jsx'
import SettingsLayout from './pages/settings/SettingsLayout.jsx'
import TeamSettings from './pages/settings/TeamSettings.jsx'
import ZonesSettings from './pages/settings/ZonesSettings.jsx'
import {
  deleteScan,
  listZones,
  resolveProductName,
  saveScan,
  setZoneVerified,
} from './services/productService.js'
import { playScanSound } from './utils/scanSound.js'

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

function Dashboard() {
  const { pharmacy, user, logout } = useAuth()
  const navigate = useNavigate()
  const suspended = pharmacy?.status === 'SUSPENDED'
  const trialExpired =
    !suspended &&
    pharmacy?.status === 'TRIAL' &&
    remainingTrialDays(pharmacy?.trial_ends_at) <= 0
  const accessBlocked = suspended || trialExpired
  const [lastScan, setLastScan] = useState(null)
  /** Dernier scan enregistré, annulable via DELETE. */
  const [lastScannedItem, setLastScannedItem] = useState(null)
  const [undoingLastScan, setUndoingLastScan] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [isExportOpen, setIsExportOpen] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [flash, setFlash] = useState(false)
  const [modal, setModal] = useState(null)
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState('')
  const [isManualOpen, setIsManualOpen] = useState(false)
  const [zones, setZones] = useState([])
  const [zonesLoading, setZonesLoading] = useState(true)
  const [activeZoneId, setActiveZoneId] = useState(readStoredZoneId)
  /** Alerte visuelle tant que la zone n’a pas été confirmée par un premier scan. */
  const [needsZoneCheck, setNeedsZoneCheck] = useState(true)
  const [viewMode, setViewMode] = useState('scan')
  const [resumeCameraToken, setResumeCameraToken] = useState(0)
  /** Incrémente pour forcer un rechargement du mode Contrôle après annulation. */
  const [controlRefreshKey, setControlRefreshKey] = useState(0)
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
    if (accessBlocked) {
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
  }, [handleZonesChange, accessBlocked])

  useEffect(() => {
    if (!toast) return undefined
    const id = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(id)
  }, [toast])

  function selectZone(zoneId) {
    setActiveZoneId(zoneId)
    setNeedsZoneCheck(true)
    try {
      window.localStorage.setItem(ACTIVE_ZONE_KEY, String(zoneId))
    } catch {
      // ignore storage errors
    }
  }

  const handleToggleZoneVerified = useCallback(async (zoneId, isVerified) => {
    try {
      const zone = await setZoneVerified(zoneId, isVerified)
      setZones((prev) =>
        prev.map((z) =>
          z.id === zone.id ? { ...z, is_verified: zone.is_verified } : z,
        ),
      )
    } catch (err) {
      setToast({
        type: 'error',
        message: err?.message || 'Impossible de mettre à jour la zone.',
      })
    }
  }, [])

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
      const scan = await saveScan({
        gtin,
        nomProduit,
        datePeremption,
        zoneId,
        typeProduit,
        nomManuel,
      })
      const item = {
        id: scan.id,
        nom_produit: scan.nom_produit ?? nomProduit,
        date_peremption: scan.date_peremption ?? datePeremption,
        quantite: scan.quantite ?? 1,
      }
      setLastScannedItem(item)
      setLastScan({
        gtin,
        nomProduit: item.nom_produit,
        datePeremption: item.date_peremption,
        quantite: item.quantite,
        zoneId,
        zoneName,
        saved: true,
      })
      showSuccess(`${item.nom_produit} — ${zoneName}`)
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
      setLastScannedItem(null)
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
          playScanSound('inserted')
          setNeedsZoneCheck(false)
          busyRef.current = false
          requestCameraResume()
          return
        }

        setNeedsZoneCheck(false)
        playScanSound('needs_input')
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
    id,
    gtin,
    nomProduit,
    datePeremption,
    quantite,
    zoneId,
    zoneName,
  }) {
    setLastScannedItem({
      id,
      nom_produit: nomProduit,
      date_peremption: datePeremption,
      quantite: quantite ?? 1,
    })
    setLastScan({
      gtin,
      nomProduit,
      datePeremption,
      quantite: quantite ?? 1,
      zoneId,
      zoneName,
      saved: true,
    })
    showSuccess(`${nomProduit} — ${zoneName}`)
  }

  async function handleUndoLastScan() {
    if (!lastScannedItem?.id || undoingLastScan) return

    setUndoingLastScan(true)
    try {
      await deleteScan(lastScannedItem.id)
      setLastScannedItem(null)
      setLastScan(null)
      setControlRefreshKey((n) => n + 1)
      setToast({ type: 'success', message: 'Scan annulé' })
    } catch (err) {
      setToast({
        type: 'error',
        message: err?.message || 'Impossible d’annuler le scan.',
      })
    } finally {
      setUndoingLastScan(false)
    }
  }

  function handleManualEntry() {
    if (!zones.length) {
      setToast({
        type: 'error',
        message: 'Créez une zone dans Paramètres avant la saisie manuelle.',
      })
      navigate('/settings/zones')
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

  return (
    <div
      className={`relative min-h-dvh bg-slate-50 text-slate-900 transition-[box-shadow] duration-300 ${
        flash ? 'shadow-[inset_0_0_0_4px_rgb(15_118_110)]' : ''
      }`}
    >
      <TrialBanner />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-5">
          <div>
            <h1 className="m-0">
              <img
                src="/expiry%20logo%20titre.png"
                alt="Expiry"
                className="h-[1.333rem] w-auto"
              />
            </h1>
            <p className="text-sm text-slate-500">
              {pharmacy?.nom || 'Suivi des péremptions'}
              {user?.email ? (
                <span className="text-slate-400"> · {user.email}</span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {user?.is_platform_admin ? (
              <button
                type="button"
                onClick={() => navigate('/admin')}
                aria-label="Administration"
                title="Administration"
                className="inline-flex size-10 items-center justify-center rounded-lg border border-teal-200 bg-teal-50 text-teal-800 transition hover:bg-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
              >
                <LayoutDashboard className="size-5" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              aria-label="Recherche"
              title="Recherche"
              disabled={accessBlocked}
              className="inline-flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50"
            >
              <Search className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setIsExportOpen(true)}
              aria-label="Export"
              title="Export"
              disabled={accessBlocked}
              className="inline-flex size-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50"
            >
              <Download className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => navigate('/settings/zones')}
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
        {!accessBlocked ? (
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
        ) : null}
      </header>

      <main className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-8">
        {suspended ? (
          <section className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-red-800">
              Compte suspendu
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              L’accès à cette pharmacie a été suspendu. Contactez le support
              Expiry pour rétablir le service.
            </p>
          </section>
        ) : trialExpired ? (
          <section className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-red-800">
              Essai terminé
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Votre période d’essai est expirée. Les fonctions de scan et de
              contrôle sont suspendues jusqu’à souscription.
            </p>
          </section>
        ) : viewMode === 'scan' ? (
          <>
            <ZoneSelector
              zones={zones}
              activeZoneId={activeZoneId}
              onSelect={selectZone}
              onToggleVerified={handleToggleZoneVerified}
              loading={zonesLoading}
              needsZoneCheck={needsZoneCheck}
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
                {lastScannedItem ? (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <button
                      type="button"
                      onClick={handleUndoLastScan}
                      disabled={undoingLastScan}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {undoingLastScan ? 'Annulation…' : 'Annuler ce scan'}
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        ) : (
          <ExpiryControlView
            key={controlRefreshKey}
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

      <SearchModal
        open={isSearchOpen}
        pharmacyName={pharmacy?.nom || ''}
        zones={zones}
        onClose={() => setIsSearchOpen(false)}
        onError={(message) => setToast({ type: 'error', message })}
        onSuccess={(message) => setToast({ type: 'success', message })}
      />

      <ExportPdfModal
        open={isExportOpen}
        pharmacyName={pharmacy?.nom || ''}
        onClose={() => setIsExportOpen(false)}
        onError={(message) => setToast({ type: 'error', message })}
        onSuccess={(message) => setToast({ type: 'success', message })}
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

function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }
  return children
}

function RequirePlatformAdmin({ children }) {
  const { isAuthenticated, user } = useAuth()
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }
  if (!user?.is_platform_admin) {
    return <Navigate to="/" replace />
  }
  return children
}

export default function App() {
  const { loading: authLoading } = useAuth()

  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 text-sm text-slate-500">
        Chargement de la session…
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginForm />} />
      <Route path="/register" element={<Register />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        path="/admin"
        element={
          <RequirePlatformAdmin>
            <Admin />
          </RequirePlatformAdmin>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="zones" replace />} />
        <Route path="zones" element={<ZonesSettings />} />
        <Route path="alerts" element={<Navigate to="zones" replace />} />
        <Route path="team" element={<TeamSettings />} />
      </Route>
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
