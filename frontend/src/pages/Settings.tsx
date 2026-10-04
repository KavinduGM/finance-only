import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Building2, DatabaseBackup, FileText, Mail, UserRound, Users, Zap } from 'lucide-react'
import { settingsApi } from '../services/api'
import type { Settings as CompanySettings } from '../services/api'
import { ErrorState, LoadingBlock, PageHeader, Tabs } from '../components/ui'
import type { TabItem } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { errorMessage } from '../lib/format'
import AccountTab from './settings/AccountTab'
import CompanyTab from './settings/CompanyTab'
import DocumentsTab from './settings/DocumentsTab'
import EmailTab from './settings/EmailTab'
import AutomationTab from './settings/AutomationTab'
import UsersTab from './settings/UsersTab'
import BackupTab from './settings/BackupTab'
import type { SettingsTabProps } from './settings/shared'

type TabId = 'account' | 'company' | 'documents' | 'email' | 'automation' | 'users' | 'backup'

const TABS: (TabItem<TabId> & { adminOnly?: boolean })[] = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'company', label: 'Company', icon: Building2, adminOnly: true },
  { id: 'documents', label: 'Documents', icon: FileText, adminOnly: true },
  { id: 'email', label: 'Email', icon: Mail, adminOnly: true },
  { id: 'automation', label: 'Automation', icon: Zap, adminOnly: true },
  { id: 'users', label: 'Users', icon: Users, adminOnly: true },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup, adminOnly: true },
]

// The tabs that edit the company settings row, each with its own form and Save button.
const SETTINGS_FORMS: Partial<Record<TabId, (props: SettingsTabProps) => JSX.Element>> = {
  company: CompanyTab,
  documents: DocumentsTab,
  email: EmailTab,
  automation: AutomationTab,
}

export default function Settings() {
  const { isAdmin } = useAuth()
  const { refreshSettings } = useSettings()
  const [params, setParams] = useSearchParams()

  // Staff only have their own account to manage; the rest is for administrators.
  const tabs = useMemo(() => TABS.filter((t) => isAdmin || !t.adminOnly), [isAdmin])
  const requested = params.get('tab')
  const tab: TabId = tabs.find((t) => t.id === requested)?.id || 'account'

  // A tab is built the first time it is opened and then kept, so edits that
  // are not saved yet are still there when you come back to it.
  const [opened, setOpened] = useState<TabId[]>([tab])
  useEffect(() => {
    setOpened((list) => (list.includes(tab) ? list : [...list, tab]))
  }, [tab])

  // The page keeps its own copy of the settings: unlike the shared one it can
  // show that loading failed, and it is replaced by what each save returns.
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const loadSettings = useCallback(async () => {
    setSettingsError(null)
    try {
      setSettings(await settingsApi.get())
    } catch (err) {
      setSettingsError(errorMessage(err, 'Could not load the settings'))
    }
  }, [])

  useEffect(() => {
    if (isAdmin) loadSettings()
  }, [isAdmin, loadSettings])

  // After a save the rest of the app (base currency, company name) follows.
  const onSaved = useCallback((next: CompanySettings) => {
    setSettings(next)
    refreshSettings()
  }, [refreshSettings])

  function panel(id: TabId, active: boolean) {
    if (id === 'account') return <AccountTab active={active} />
    if (id === 'users') return <UsersTab active={active} />
    if (id === 'backup') return <BackupTab active={active} />

    const Form = SETTINGS_FORMS[id]
    if (!Form) return null
    if (settings) return <Form settings={settings} onSaved={onSaved} />
    return (
      <div className="card max-w-4xl">
        {settingsError
          ? <ErrorState message={settingsError} onRetry={loadSettings} />
          : <LoadingBlock label="Loading settings" />}
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        description={
          isAdmin
            ? 'Your account, company details, documents, email, users and backups'
            : 'Your profile, password and signed-in devices'
        }
      />

      {tabs.length > 1 && (
        <Tabs tabs={tabs} value={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
      )}

      {tabs.filter((t) => t.id === tab || opened.includes(t.id)).map((t) => (
        <div key={t.id} role="tabpanel" aria-label={t.label} hidden={t.id !== tab}>
          {panel(t.id, t.id === tab)}
        </div>
      ))}
    </div>
  )
}
