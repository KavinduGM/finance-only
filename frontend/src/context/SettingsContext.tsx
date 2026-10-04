import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { settingsApi, Settings } from '../services/api'
import { formatCompact, formatMoney } from '../lib/format'
import { useAuth } from './AuthContext'

interface SettingsState {
  settings: Settings | null
  /** Company base currency; totals and reports are expressed in it. */
  baseCurrency: string
  companyName: string
  /** Formats an amount in the base currency unless another currency is given. */
  money: (amount: unknown, currency?: string | null) => string
  moneyCompact: (amount: unknown, currency?: string | null) => string
  refreshSettings: () => Promise<void>
}

const SettingsContext = createContext<SettingsState | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState<Settings | null>(null)
  const ready = !!user && !user.must_change_password

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await settingsApi.get())
    } catch {
      /* keep the last known settings */
    }
  }, [])

  useEffect(() => {
    if (ready) refreshSettings()
    else setSettings(null)
  }, [ready, refreshSettings])

  const value = useMemo(() => {
    const baseCurrency = settings?.currency || 'LKR'
    return {
      settings,
      baseCurrency,
      companyName: settings?.company_name || 'GroovyMark',
      money: (amount: unknown, currency?: string | null) => formatMoney(amount, currency || baseCurrency),
      moneyCompact: (amount: unknown, currency?: string | null) => formatCompact(amount, currency || baseCurrency),
      refreshSettings,
    }
  }, [settings, refreshSettings])

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider')
  return ctx
}
