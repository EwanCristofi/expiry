/**
 * Retours sonores de scan via Web Audio API (sans fichiers externes).
 * Débloque l’AudioContext sur la première interaction utilisateur.
 */

const SOUND_PREF_KEY = 'expiry.scanSoundEnabled'

/** @type {AudioContext | null} */
let audioCtx = null
let unlockAttempted = false

function readSoundPref() {
  try {
    const raw = window.localStorage.getItem(SOUND_PREF_KEY)
    if (raw === null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

let soundEnabled = typeof window !== 'undefined' ? readSoundPref() : true

/**
 * @returns {boolean}
 */
export function isScanSoundEnabled() {
  return soundEnabled
}

/**
 * @param {boolean} enabled
 */
export function setScanSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled)
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, soundEnabled ? '1' : '0')
  } catch {
    // ignore storage errors
  }
}

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new Ctx()
  }
  return audioCtx
}

/**
 * À appeler sur clic / touche / démarrage du scan pour lever le blocage autoplay.
 * @returns {Promise<void>}
 */
export async function unlockScanAudio() {
  unlockAttempted = true
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
  } catch {
    // Navigateur / politique autoplay — silencieux
  }
}

/**
 * Joue une brève note sinusoïdale.
 * @param {AudioContext} ctx
 * @param {{ frequency: number, durationMs: number, gain: number, startAt?: number }} opts
 */
function playTone(ctx, { frequency, durationMs, gain, startAt = 0 }) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  g.gain.value = 0

  osc.connect(g)
  g.connect(ctx.destination)

  const t0 = ctx.currentTime + startAt
  const attack = 0.008
  const release = Math.min(0.04, durationMs / 1000 / 3)
  const t1 = t0 + durationMs / 1000

  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(gain, t0 + attack)
  g.gain.setValueAtTime(gain, Math.max(t0 + attack, t1 - release))
  g.gain.linearRampToValueAtTime(0, t1)

  osc.start(t0)
  osc.stop(t1 + 0.01)
}

/**
 * @param {'inserted' | 'needs_input'} status
 */
export function playScanSound(status) {
  if (!soundEnabled) return

  try {
    const ctx = getAudioContext()
    if (!ctx) return

    const run = () => {
      if (status === 'inserted') {
        playTone(ctx, {
          frequency: 880,
          durationMs: 130,
          gain: 0.15,
        })
        return
      }

      // needs_input : deux bips descendants
      playTone(ctx, {
        frequency: 440,
        durationMs: 110,
        gain: 0.18,
      })
      playTone(ctx, {
        frequency: 330,
        durationMs: 140,
        gain: 0.18,
        startAt: 0.16,
      })
    }

    if (ctx.state === 'suspended') {
      // Tentative de reprise ; si l’utilisateur n’a pas encore interagi, no-op
      if (!unlockAttempted) {
        unlockScanAudio().then(() => {
          if (ctx.state === 'running') run()
        })
        return
      }
      ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running') run()
        })
        .catch(() => {})
      return
    }

    run()
  } catch {
    // Ne jamais faire échouer le flux de scan pour un bip
  }
}
