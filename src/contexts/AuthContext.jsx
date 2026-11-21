import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { clearLegacyAuthToken } from '../services/api.js'
import {
  fetchMe,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from '../services/authService.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function boot() {
      clearLegacyAuthToken()
      try {
        // Session via cookie HttpOnly uniquement (credentials: include).
        const profile = await fetchMe()
        if (!cancelled) setUser(profile)
      } catch (err) {
        if (!cancelled) setUser(null)
        // 401 = pas de session ; autres erreurs → utilisateur déconnecté sans boucle.
        if (err?.status && err.status !== 401) {
          console.error('[auth/boot]', err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    boot()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email, password) => {
    await loginRequest(email, password)
    // Valide que le cookie HttpOnly est bien utilisable.
    const profile = await fetchMe()
    setUser(profile)
    return profile
  }, [])

  const register = useCallback(async ({ nom, email, password, siret }) => {
    await registerRequest({ nom, email, password, siret })
    const profile = await fetchMe()
    setUser(profile)
    return profile
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutRequest()
    } finally {
      setUser(null)
    }
  }, [])

  const refreshUser = useCallback(async () => {
    const profile = await fetchMe()
    setUser(profile)
    return profile
  }, [])

  const patchPharmacy = useCallback((pharmacy) => {
    setUser((prev) => (prev ? { ...prev, pharmacy } : prev))
  }, [])

  const value = useMemo(
    () => ({
      user,
      pharmacy: user?.pharmacy ?? null,
      loading,
      isAuthenticated: Boolean(user),
      login,
      register,
      logout,
      refreshUser,
      patchPharmacy,
    }),
    [user, loading, login, register, logout, refreshUser, patchPharmacy],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth doit être utilisé dans AuthProvider')
  }
  return ctx
}
