import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { authApi, AUTH_EXPIRED_EVENT, PASSWORD_CHANGE_EVENT, User } from '../services/api'

interface AuthState {
  user: User | null
  /** True until the first "who am I" check has finished. */
  loading: boolean
  isAdmin: boolean
  login: (username: string, password: string) => Promise<User>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  setUser: (user: User | null) => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await authApi.me()
      setUser(res.user)
    } catch {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // The API client raises these when a request is rejected mid-session.
  useEffect(() => {
    const expired = () => setUser(null)
    const mustChange = () => setUser((u) => (u ? { ...u, must_change_password: true } : u))
    window.addEventListener(AUTH_EXPIRED_EVENT, expired)
    window.addEventListener(PASSWORD_CHANGE_EVENT, mustChange)
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired)
      window.removeEventListener(PASSWORD_CHANGE_EVENT, mustChange)
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password)
    setUser(res.user)
    return res.user
  }, [])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo(
    () => ({ user, loading, isAdmin: user?.role === 'admin', login, logout, refresh, setUser }),
    [user, loading, login, logout, refresh]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
