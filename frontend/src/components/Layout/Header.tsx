import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, KeyRound, LogOut, Menu, Moon, Sun, Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { notificationApi, AppNotification } from '../../services/api'
import { useAuth } from '../../context/AuthContext'
import { useTheme } from '../../context/ThemeContext'
import { useSettings } from '../../context/SettingsContext'
import { formatDateTime } from '../../lib/format'

const DOT: Record<string, string> = {
  success: 'bg-good', warning: 'bg-warn', critical: 'bg-bad', info: 'bg-info',
}

/** Closes a dropdown when the user clicks anywhere outside it or presses Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

export default function Header({ onMenu }: { onMenu: () => void }) {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { baseCurrency } = useSettings()

  const [unread, setUnread] = useState(0)
  const [notifs, setNotifs] = useState<AppNotification[]>([])
  const [bellOpen, setBellOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const bellRef = useDismiss(bellOpen, useCallback(() => setBellOpen(false), []))
  const userRef = useDismiss(userOpen, useCallback(() => setUserOpen(false), []))

  const loadCount = useCallback(async () => {
    try {
      setUnread((await notificationApi.unreadCount()).count)
    } catch {
      /* the bell is not worth an error message; the next poll retries */
    }
  }, [])

  useEffect(() => {
    loadCount()
    const timer = setInterval(loadCount, 60000)
    return () => clearInterval(timer)
  }, [loadCount])

  async function openBell() {
    const next = !bellOpen
    setBellOpen(next)
    if (next) {
      try {
        setNotifs(await notificationApi.list())
      } catch {
        setNotifs([])
      }
    }
  }

  async function markAllRead() {
    await notificationApi.markAllRead()
    setUnread(0)
    setNotifs((list) => list.map((n) => ({ ...n, is_read: 1 })))
  }

  async function clearRead() {
    await notificationApi.clearRead()
    setNotifs((list) => list.filter((n) => !n.is_read))
  }

  async function signOut() {
    await logout()
    navigate('/login', { replace: true })
  }

  const displayName = user?.name || user?.username || ''

  return (
    <header className="relative z-20 h-14 shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 border-b border-line bg-surface/70 backdrop-blur-md">
      <div className="flex items-center gap-3 min-w-0">
        <button className="btn-icon lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu size={18} /></button>
        <p className="text-sm text-ink-2 truncate">{format(new Date(), 'EEEE, d MMMM yyyy')}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="hidden sm:inline-flex badge-neutral mr-1" title="Totals and reports are shown in this currency">
          {baseCurrency}
        </span>

        <button className="btn-icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <div className="relative" ref={bellRef}>
          <button className="btn-icon relative" onClick={openBell} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell size={16} />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-accent-ink text-[10px] font-bold flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          {bellOpen && (
            <div className="absolute right-0 top-10 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line-strong bg-surface shadow-pop z-50 overflow-hidden animate-fade-up">
              <div className="flex items-center justify-between px-4 py-3 border-b border-line">
                <span className="text-sm font-semibold text-ink">Notifications</span>
                <div className="flex items-center gap-1">
                  <button className="btn-ghost btn-sm" onClick={markAllRead} disabled={unread === 0}>
                    <CheckCheck size={13} /> Mark read
                  </button>
                  <button className="btn-icon" onClick={clearRead} title="Remove read notifications" aria-label="Remove read notifications">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {notifs.length === 0 ? (
                  <p className="text-center text-sm text-ink-3 py-10">Nothing new</p>
                ) : (
                  notifs.map((n) => (
                    <div key={n.id} className={`flex gap-3 px-4 py-3 border-b border-line/60 last:border-b-0 ${n.is_read ? 'opacity-60' : ''}`}>
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${DOT[n.type] || 'bg-ink-3'}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{n.title}</p>
                        {n.message && <p className="text-xs text-ink-2 mt-0.5 break-words">{n.message}</p>}
                        <p className="text-2xs text-ink-3 mt-1">{formatDateTime(n.created_at)}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="relative ml-1" ref={userRef}>
          <button
            className="flex items-center gap-2 h-9 pl-1 pr-2.5 rounded-lg hover:bg-surface-2 transition-colors"
            onClick={() => setUserOpen(!userOpen)}
            aria-label="Account menu"
          >
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-accent/15 text-accent text-xs font-bold uppercase">
              {displayName.charAt(0)}
            </span>
            <span className="hidden sm:block text-sm font-medium text-ink max-w-[10rem] truncate">{displayName}</span>
          </button>

          {userOpen && (
            <div className="absolute right-0 top-10 w-56 rounded-xl border border-line-strong bg-surface shadow-pop z-50 overflow-hidden animate-fade-up">
              <div className="px-4 py-3 border-b border-line">
                <p className="text-sm font-semibold text-ink truncate">{displayName}</p>
                <p className="text-xs text-ink-3 truncate">
                  @{user?.username} · {user?.role === 'admin' ? 'Administrator' : 'Staff'}
                </p>
              </div>
              <div className="p-1.5">
                <button
                  className="nav-item w-full"
                  onClick={() => { setUserOpen(false); navigate('/settings?tab=account') }}
                >
                  <KeyRound size={15} /> Password & account
                </button>
                <button className="nav-item w-full hover:!text-bad" onClick={signOut}>
                  <LogOut size={15} /> Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
