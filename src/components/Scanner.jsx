import { useCallback, useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { parseGs1 } from '../utils/gs1Parser.js'

const WEDGE_GAP_MS = 80
const CAMERA_ELEMENT_ID = 'expiry-camera-reader'

/** Labels that usually identify the rear / world-facing camera. */
const REAR_CAMERA_LABEL =
  /back|rear|environment|arrière|arriere|trasera|posterior|rück|背面|后置|後置/i

/**
 * Prefer the smartphone rear camera.
 * 1) Match by device label when available
 * 2) Else hard-require facingMode environment
 * 3) Else soft facingMode preference
 *
 * @returns {Promise<string | { facingMode: string | { exact: string } }>}
 */
async function resolveRearCameraConfig() {
  try {
    const cameras = await Html5Qrcode.getCameras()
    if (cameras?.length) {
      const labeledRear = cameras.find((cam) =>
        REAR_CAMERA_LABEL.test(cam.label ?? ''),
      )
      if (labeledRear?.id) return labeledRear.id

      // Only filter by label when the browser actually exposes names
      // (iOS often returns empty labels — then facingMode is safer)
      const withLabels = cameras.filter((cam) => (cam.label ?? '').trim())
      if (withLabels.length) {
        const nonFront = withLabels.find(
          (cam) => !/front|user|face|selfie|avant/i.test(cam.label),
        )
        if (nonFront?.id) return nonFront.id
      }
    }
  } catch {
    // Permission / unsupported — fall through to facingMode
  }

  // exact = refuse front camera if a rear one exists
  return { facingMode: { exact: 'environment' } }
}

/**
 * Dual-mode barcode capture: USB wedge (keydown) + smartphone camera.
 *
 * After a successful camera save, bump `resumeCameraToken` to reopen the
 * camera popup automatically (continuous scanning). Closing the popup ends
 * the session.
 *
 * @param {{
 *   onScan: (
 *     result: { rawCode: string, gtin: string, datePeremption: string },
 *     meta?: { source: 'camera' | 'wedge' },
 *   ) => void,
 *   onManualEntry?: () => void,
 *   disabled?: boolean,
 *   resumeCameraToken?: number,
 * }} props
 */
export default function Scanner({
  onScan,
  onManualEntry,
  disabled = false,
  resumeCameraToken = 0,
}) {
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [lastRaw, setLastRaw] = useState('')
  const bufferRef = useRef('')
  const lastKeyAtRef = useRef(0)
  const scannerRef = useRef(null)
  const handlingRef = useRef(false)
  /** True while the user wants continuous camera scanning (until Fermer). */
  const cameraSessionRef = useRef(false)
  const lastResumeTokenRef = useRef(resumeCameraToken)

  const emitScan = useCallback(
    (raw, source = 'wedge') => {
      const trimmed = String(raw ?? '').trim()
      if (!trimmed || handlingRef.current) return

      handlingRef.current = true
      const parsed = parseGs1(trimmed)
      setLastRaw(parsed.rawCode)
      onScan?.(parsed, { source })

      // Lock anti double-bip (douchette / caméra) le temps de la résolution
      window.setTimeout(() => {
        handlingRef.current = false
      }, 1500)
    },
    [onScan],
  )

  function openCamera() {
    cameraSessionRef.current = true
    setCameraOpen(true)
  }

  function closeCameraSession() {
    cameraSessionRef.current = false
    setCameraOpen(false)
  }

  // Reopen camera after a successful save while the session is still active
  useEffect(() => {
    if (resumeCameraToken === lastResumeTokenRef.current) return
    lastResumeTokenRef.current = resumeCameraToken
    if (resumeCameraToken <= 0 || !cameraSessionRef.current || disabled) return

    const timer = window.setTimeout(() => {
      if (cameraSessionRef.current) setCameraOpen(true)
    }, 280)
    return () => window.clearTimeout(timer)
  }, [resumeCameraToken, disabled])

  // ——— Mode douchette (tablette) ———
  useEffect(() => {
    if (cameraOpen || disabled) return undefined

    function onKeyDown(event) {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      const now = Date.now()
      const gap = now - lastKeyAtRef.current
      lastKeyAtRef.current = now

      if (gap > WEDGE_GAP_MS) {
        bufferRef.current = ''
      }

      if (event.key === 'Enter') {
        if (bufferRef.current.length > 0) {
          event.preventDefault()
          const code = bufferRef.current
          bufferRef.current = ''
          emitScan(code)
        }
        return
      }

      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        bufferRef.current += event.key
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cameraOpen, disabled, emitScan])

  // ——— Mode caméra (smartphone) ———
  useEffect(() => {
    if (!cameraOpen) return undefined

    let cancelled = false
    setCameraError('')

    async function startCamera() {
      const formats = [
        Html5QrcodeSupportedFormats.DATA_MATRIX,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.CODE_128,
      ]

      const html5Qrcode = new Html5Qrcode(CAMERA_ELEMENT_ID, {
        verbose: false,
        formatsToSupport: formats,
      })
      scannerRef.current = html5Qrcode

      const config = {
        fps: 10,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const edge = Math.min(viewfinderWidth, viewfinderHeight) * 0.75
          return { width: edge, height: edge }
        },
        aspectRatio: 1,
      }

      const onSuccess = (decodedText) => {
        if (cancelled) return
        emitScan(decodedText, 'camera')
        // Close briefly to process; session stays active until Fermer
        setCameraOpen(false)
      }

      const onFailure = () => {
        // ignore frame-by-frame "not found" noise
      }

      try {
        const preferred = await resolveRearCameraConfig()
        if (cancelled) return

        const candidates = [
          preferred,
          { facingMode: { exact: 'environment' } },
          { facingMode: 'environment' },
        ]

        let started = false
        let lastError = null
        for (const cameraConfig of candidates) {
          if (cancelled) return
          try {
            await html5Qrcode.start(cameraConfig, config, onSuccess, onFailure)
            started = true
            break
          } catch (err) {
            lastError = err
            // Ensure a clean state before the next attempt
            if (html5Qrcode.isScanning) {
              try {
                await html5Qrcode.stop()
              } catch {
                // ignore
              }
            }
          }
        }

        if (!started && !cancelled) {
          throw (
            lastError ||
            new Error('Aucune caméra arrière disponible sur cet appareil.')
          )
        }
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err?.message ||
              'Impossible d’accéder à la caméra. Vérifiez les permissions.',
          )
        }
      }
    }

    // Defer until the modal DOM node exists
    const timer = window.setTimeout(startCamera, 50)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      const scanner = scannerRef.current
      scannerRef.current = null
      if (scanner?.isScanning) {
        scanner.stop().catch(() => {})
      } else {
        try {
          scanner?.clear()
        } catch {
          // element may already be unmounted
        }
      }
    }
  }, [cameraOpen, emitScan])

  return (
    <div className="w-full max-w-lg space-y-4">
      <div
        className={`rounded-xl border bg-white p-5 shadow-sm ${
          disabled ? 'border-amber-200' : 'border-slate-200'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-slate-500">Mode douchette</p>
          {onManualEntry ? (
            <button
              type="button"
              onClick={onManualEntry}
              className="shrink-0 rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-200 transition hover:bg-sky-100 hover:text-sky-800"
            >
              + Saisie manuelle
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-base text-slate-800">
          Scannez un DataMatrix ou un CIP avec la douchette — le code est capturé
          automatiquement.
        </p>
        {disabled ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Sélectionnez une zone active ci-dessus pour activer les scans.
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
            <span
              className="inline-block h-2 w-2 rounded-full bg-emerald-500"
              aria-hidden
            />
            En écoute clavier
          </div>
        )}
        {lastRaw ? (
          <p className="mt-3 truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
            Dernier scan : {lastRaw}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={openCamera}
        disabled={disabled}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-3.5 text-base font-semibold text-white transition hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Scanner avec la caméra
      </button>

      {cameraOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Scanner caméra"
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-base font-semibold text-slate-900">
                Caméra
              </h2>
              <button
                type="button"
                onClick={closeCameraSession}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Fermer
              </button>
            </div>

            <div className="p-4">
              {cameraError ? (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {cameraError}
                </p>
              ) : (
                <p className="mb-3 text-sm text-slate-500">
                  Cadrez le DataMatrix ou le code-barres dans le viseur.
                </p>
              )}
              <div
                id={CAMERA_ELEMENT_ID}
                className="overflow-hidden rounded-xl bg-slate-900 [&_video]:rounded-xl"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
