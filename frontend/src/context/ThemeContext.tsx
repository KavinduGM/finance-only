import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type Theme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeState | null>(null)

// public/theme.js has already stamped <html data-theme> before the app loaded.
const initial = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial)

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      try {
        localStorage.setItem('theme', next)
      } catch {
        /* storage unavailable: the choice lasts for this visit only */
      }
      return next
    })
  }, [])

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
