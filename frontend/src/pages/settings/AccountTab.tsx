import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { KeyRound, LogOut, Monitor, Save, Smartphone } from 'lucide-react'
import { authApi } from '../../services/api'
import type { SessionRow } from '../../services/api'
import { EmptyState, ErrorState, Field, Spinner, TableSkeleton, useConfirm } from '../../components/ui'
import PasswordInput, { passwordProblem } from '../../components/PasswordInput'
import { useAuth } from '../../context/AuthContext'
import { errorMessage, formatDateTime } from '../../lib/format'
import { EMAIL_PATTERN, Section } from './shared'

/** Your own profile, password and signed-in devices. Open to every user. */
export default function AccountTab({ active }: { active: boolean }) {
  // Bumped after a password change, which signs the other devices out.
  const [sessionsVersion, setSessionsVersion] = useState(0)

  return (
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <ProfileCard />
      <PasswordCard onChanged={() => setSessionsVersion((n) => n + 1)} />
      <div className="lg:col-span-2">
        <SessionsCard active={active} version={sessionsVersion} />
      </div>
    </div>
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────

function ProfileCard() {
  const { user, isAdmin, refresh } = useAuth()
  const savedName = user?.name || ''
  const savedEmail = user?.email || ''

  const [name, setName] = useState(savedName)
  const [email, setEmail] = useState(savedEmail)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The account can also be edited from the Users tab; show what is saved now.
  useEffect(() => {
    setName(savedName)
    setEmail(savedEmail)
    setEmailError(null)
  }, [savedName, savedEmail])

  const dirty = name.trim() !== savedName || email.trim() !== savedEmail

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return
    const address = email.trim()
    if (address && !EMAIL_PATTERN.test(address)) {
      setEmailError('Enter a valid email address')
      return
    }

    setSaving(true)
    try {
      await authApi.updateProfile({ name: name.trim() || null, email: address || null })
      await refresh()
      toast.success('Profile updated')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update your profile'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      title="Profile"
      description="How you appear in this system."
      actions={<span className={isAdmin ? 'badge-accent' : 'badge-neutral'}>{isAdmin ? 'Administrator' : 'Staff'}</span>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Username" hint="Used to sign in. It cannot be changed.">
          <input className="input num" value={user?.username || ''} readOnly disabled />
        </Field>
        <Field label="Name">
          <input
            className="input" autoComplete="name" maxLength={100} placeholder="Your full name"
            value={name} onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Email" error={emailError}>
          <input
            className="input" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (emailError) setEmailError(null)
            }}
          />
        </Field>
        <div className="flex justify-end pt-1">
          <button type="submit" className="btn-primary" disabled={!dirty || saving}>
            {saving ? <Spinner /> : <Save size={15} />} Save profile
          </button>
        </div>
      </form>
    </Section>
  )
}

// ── Password ─────────────────────────────────────────────────────────────────

interface PasswordErrors {
  current?: string
  next?: string
  repeat?: string
}

function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [saving, setSaving] = useState(false)

  const started = current !== '' || next !== '' || repeat !== ''

  function clearError(field: keyof PasswordErrors) {
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !started) return

    const problems: PasswordErrors = {}
    if (!current) problems.current = 'Enter your current password'
    const weakness = passwordProblem(next, user?.username || '')
    if (weakness) problems.next = weakness
    else if (next === current) problems.next = 'Choose a password that is different from the current one'
    else if (next !== repeat) problems.repeat = 'The two new passwords do not match'
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      await authApi.changePassword(current, next)
      toast.success('Password updated. Your other devices were signed out.')
      setCurrent('')
      setNext('')
      setRepeat('')
      onChanged()
    } catch (err) {
      const message = errorMessage(err, 'Could not update the password')
      // The server's answer belongs next to the field it is about.
      if (/^current password/i.test(message)) setErrors({ current: message })
      else if (/^(new )?password/i.test(message)) setErrors({ next: message })
      else toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="Change password" description="Changing your password signs you out on every other device.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Current password" error={errors.current}>
          <PasswordInput
            autoComplete="current-password" value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              clearError('current')
            }}
          />
        </Field>
        <Field label="New password" error={errors.next} hint="At least 10 characters, with letters and numbers.">
          <PasswordInput
            autoComplete="new-password" value={next}
            onChange={(e) => {
              setNext(e.target.value)
              clearError('next')
            }}
          />
        </Field>
        <Field label="Repeat new password" error={errors.repeat}>
          <PasswordInput
            autoComplete="new-password" value={repeat}
            onChange={(e) => {
              setRepeat(e.target.value)
              clearError('repeat')
            }}
          />
        </Field>
        <div className="flex justify-end pt-1">
          <button type="submit" className="btn-primary" disabled={!started || saving}>
            {saving ? <Spinner /> : <KeyRound size={15} />} Update password
          </button>
        </div>
      </form>
    </Section>
  )
}

// ── Signed-in devices ────────────────────────────────────────────────────────

/** "Chrome on macOS" from a browser's user-agent string. */
function describeDevice(userAgent: string | null) {
  const ua = userAgent || ''
  // Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari".
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : ''
  const system = /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  const label = browser && system ? `${browser} on ${system}` : browser || system || 'Unknown device'
  return { label, mobile: /iPhone|iPod|iPad|Android|Mobile/.test(ua) }
}

function SessionsCard({ active, version }: { active: boolean; version: number }) {
  const confirm = useConfirm()
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ticket = useRef(0)

  const load = useCallback(async () => {
    const mine = ++ticket.current
    setError(null)
    try {
      const rows = await authApi.sessions()
      if (mine === ticket.current) setSessions(rows)
    } catch (err) {
      if (mine !== ticket.current) return
      setSessions(null)
      setError(errorMessage(err, 'Could not load your signed-in devices'))
    }
  }, [])

  // Loads when the tab is opened, and again after a password change.
  useEffect(() => {
    if (active) load()
  }, [active, version, load])

  const others = sessions ? sessions.filter((s) => !s.current).length : 0

  async function signOutOthers() {
    const ok = await confirm({
      title: 'Sign out other devices?',
      message: `Your account is signed out on ${others === 1 ? 'the other device' : `the ${others} other devices`}. This device stays signed in.`,
      confirmLabel: 'Sign out other devices',
    })
    if (!ok) return

    setBusy(true)
    try {
      await authApi.logoutOthers()
      toast.success('Signed out of all other devices')
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not sign out the other devices'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      flush
      title="Signed-in devices"
      description="Browsers and devices where your account is signed in right now."
      actions={
        <button type="button" className="btn-secondary" onClick={signOutOthers} disabled={busy || others === 0}>
          {busy ? <Spinner /> : <LogOut size={15} />} Sign out other devices
        </button>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : sessions === null ? (
        <TableSkeleton rows={2} cols={4} />
      ) : sessions.length === 0 ? (
        <EmptyState icon={Monitor} title="No signed-in devices" description="Nothing is signed in with your account at the moment." />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Device</th>
                <th scope="col" className="th">IP address</th>
                <th scope="col" className="th">Signed in</th>
                <th scope="col" className="th">Last active</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const device = describeDevice(s.user_agent)
                const Icon = device.mobile ? Smartphone : Monitor
                return (
                  <tr key={s.id} className="tr">
                    <td className="td td-strong">
                      <span className="flex items-center gap-2.5 whitespace-nowrap" title={s.user_agent || undefined}>
                        <Icon size={15} className="text-ink-3 shrink-0" />
                        {device.label}
                        {s.current && <span className="badge-accent">This device</span>}
                      </span>
                    </td>
                    <td className="td num whitespace-nowrap">{s.ip || '—'}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(s.created_at)}</td>
                    <td className="td whitespace-nowrap">{formatDateTime(s.last_seen_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
