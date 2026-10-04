import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Check, ChevronDown, Copy, KeyRound, LockOpen, Pencil, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react'
import { userApi } from '../../services/api'
import type { AuditRow, Role, UserRow } from '../../services/api'
import {
  EmptyState, ErrorState, Field, Modal, Spinner, StatusBadge, TableSkeleton, useConfirm,
} from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { errorMessage, formatDateTime, formatNumber } from '../../lib/format'
import { EMAIL_PATTERN, Notice, Section, textOrNull } from './shared'

const USERNAME = /^[A-Za-z0-9._-]{3,50}$/
const ROLE_HINT = 'Staff can do everything except manage users, settings and backups.'
const ROLE_LABELS: Record<string, string> = { admin: 'Administrator', staff: 'Staff' }

const isLocked = (u: UserRow) => !!u.locked_until && Date.parse(u.locked_until) > Date.now()

/** One status per account, the most restrictive first. */
function statusOf(u: UserRow): { status: string; label: string; title?: string } {
  if (!u.is_active) return { status: 'inactive', label: 'Inactive', title: 'This account cannot sign in' }
  if (isLocked(u)) {
    return { status: 'locked', label: 'Locked', title: `Too many wrong passwords. Locked until ${formatDateTime(u.locked_until)}` }
  }
  if (u.must_change_password) {
    return { status: 'warning', label: 'Must change password', title: 'Has a temporary password and must choose a new one at the next sign-in' }
  }
  return { status: 'active', label: 'Active' }
}

interface IssuedPassword {
  username: string
  password: string
  reason: 'created' | 'reset'
}

/** Accounts that can sign in, and the log of security events. Administrators only. */
export default function UsersTab({ active }: { active: boolean }) {
  const { user: me, refresh } = useAuth()
  const confirm = useConfirm()

  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const ticket = useRef(0)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [issued, setIssued] = useState<IssuedPassword | null>(null)
  // Bumped after every change, so an open security log shows the new entry.
  const [logVersion, setLogVersion] = useState(0)

  const load = useCallback(async () => {
    const mine = ++ticket.current
    setError(null)
    try {
      const rows = await userApi.list()
      if (mine === ticket.current) setUsers(rows)
    } catch (err) {
      if (mine !== ticket.current) return
      setUsers(null)
      setError(errorMessage(err, 'Could not load the users'))
    }
  }, [])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  function afterChange() {
    load()
    setLogVersion((n) => n + 1)
  }

  async function resetPassword(u: UserRow) {
    const ok = await confirm({
      title: `Reset the password for ${u.username}?`,
      message: `${u.name || u.username} is signed out everywhere and the current password stops working. You get a temporary password to pass on.`,
      confirmLabel: 'Reset password',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(u.id)
    try {
      const res = await userApi.resetPassword(u.id)
      setIssued({ username: res.username, password: res.temporary_password, reason: 'reset' })
      afterChange()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not reset the password'))
    } finally {
      setBusyId(null)
    }
  }

  async function unlock(u: UserRow) {
    setBusyId(u.id)
    try {
      await userApi.unlock(u.id)
      toast.success(`${u.username} can sign in again`)
      afterChange()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not unlock the account'))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(u: UserRow) {
    const ok = await confirm({
      title: `Delete ${u.username}?`,
      message: `${u.name || u.username} will no longer be able to sign in. Invoices, expenses and everything else they recorded stay as they are. This cannot be undone.`,
      confirmLabel: 'Delete user',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(u.id)
    try {
      await userApi.delete(u.id)
      toast.success('User deleted')
      setUsers((list) => (list ? list.filter((row) => row.id !== u.id) : list))
      afterChange()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the user'))
    } finally {
      setBusyId(null)
    }
  }

  const usernames = useMemo(() => new Map((users || []).map((u) => [u.id, u.username])), [users])

  return (
    <div className="space-y-5">
      <Section
        flush
        title="Users"
        description="Everyone who can sign in to this system. Each person has their own username and password."
        actions={
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <UserPlus size={15} /> Add user
          </button>
        }
      >
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : users === null ? (
          <TableSkeleton rows={3} cols={5} />
        ) : users.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Add the people who should be able to sign in."
            action={
              <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
                <UserPlus size={15} /> Add user
              </button>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="th">Username</th>
                  <th scope="col" className="th">Name and email</th>
                  <th scope="col" className="th">Role</th>
                  <th scope="col" className="th">Status</th>
                  <th scope="col" className="th">Last sign-in</th>
                  <th scope="col" className="th-num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me?.id
                  const busy = busyId === u.id
                  const status = statusOf(u)
                  return (
                    <tr key={u.id} className="tr">
                      <td className="td td-strong whitespace-nowrap">
                        <span className="num">{u.username}</span>
                        {self && <span className="badge-neutral ml-2">You</span>}
                      </td>
                      {/* Name and email share a column so the actions stay in view on a laptop. */}
                      <td className="td">
                        <span className="block max-w-[260px] truncate text-ink" title={u.name || undefined}>{u.name || '—'}</span>
                        {u.email && (
                          <span className="block max-w-[260px] truncate text-xs text-ink-3 mt-0.5" title={u.email}>{u.email}</span>
                        )}
                      </td>
                      <td className="td">
                        <span className={u.role === 'admin' ? 'badge-accent' : 'badge-neutral'}>{ROLE_LABELS[u.role] || u.role}</span>
                      </td>
                      <td className="td">
                        <span title={status.title}><StatusBadge status={status.status} label={status.label} /></span>
                      </td>
                      <td className="td whitespace-nowrap">{u.last_login_at ? formatDateTime(u.last_login_at) : 'Never'}</td>
                      <td className="td">
                        <div className="flex items-center justify-end gap-0.5">
                          {busy && <Spinner size={14} className="text-ink-3 mr-1" />}
                          {isLocked(u) && (
                            <button
                              type="button" className="btn-icon" disabled={busy} onClick={() => unlock(u)}
                              title="Unlock account" aria-label={`Unlock ${u.username}`}
                            >
                              <LockOpen size={15} />
                            </button>
                          )}
                          <button
                            type="button" className="btn-icon" disabled={busy} onClick={() => setEditing(u)}
                            title="Edit" aria-label={`Edit ${u.username}`}
                          >
                            <Pencil size={15} />
                          </button>
                          {/* Your own password and account are handled on the Account tab. */}
                          {!self && (
                            <>
                              <button
                                type="button" className="btn-icon" disabled={busy} onClick={() => resetPassword(u)}
                                title="Reset password" aria-label={`Reset the password for ${u.username}`}
                              >
                                <KeyRound size={15} />
                              </button>
                              <button
                                type="button" className="btn-icon-danger" disabled={busy} onClick={() => remove(u)}
                                title="Delete" aria-label={`Delete ${u.username}`}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <SecurityLog version={logVersion} usernames={usernames} />

      {adding && (
        <AddUserModal
          onClose={() => setAdding(false)}
          onCreated={(username, password) => {
            setAdding(false)
            setIssued({ username, password, reason: 'created' })
            afterChange()
          }}
        />
      )}

      {editing && (
        <EditUserModal
          user={editing}
          self={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={(self) => {
            setEditing(null)
            afterChange()
            // The header and the Account tab show your own name and email.
            if (self) refresh()
          }}
        />
      )}

      {issued && <TemporaryPasswordModal issued={issued} onClose={() => setIssued(null)} />}
    </div>
  )
}

// ── Add user ─────────────────────────────────────────────────────────────────

function AddUserModal({ onClose, onCreated }: {
  onClose: () => void
  onCreated: (username: string, temporaryPassword: string) => void
}) {
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [errors, setErrors] = useState<{ username?: string; email?: string }>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    const problems: typeof errors = {}
    const login = username.trim()
    if (!login) problems.username = 'Enter a username'
    else if (!USERNAME.test(login)) problems.username = 'Use 3 to 50 letters, numbers, dots, dashes or underscores'
    if (email.trim() && !EMAIL_PATTERN.test(email.trim())) problems.email = 'Enter a valid email address'
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    setSaving(true)
    try {
      const res = await userApi.create({ username: login, name: textOrNull(name), email: textOrNull(email), role })
      onCreated(res.username, res.temporary_password)
    } catch (err) {
      const message = errorMessage(err, 'Could not add the user')
      if (/username/i.test(message)) setErrors({ username: message })
      else toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      size="sm"
      title="Add user"
      subtitle="A temporary password is created for them when you save."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="add-user-form" className="btn-primary" disabled={saving}>
            {saving ? <Spinner /> : <UserPlus size={15} />} Add user
          </button>
        </>
      }
    >
      <form id="add-user-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Username" required error={errors.username} hint="What they type to sign in. It cannot be changed later.">
          <input
            className="input num" maxLength={50} autoComplete="off" autoCapitalize="none" spellCheck={false}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              if (errors.username) setErrors((x) => ({ ...x, username: undefined }))
            }}
          />
        </Field>
        <Field label="Name">
          <input className="input" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" error={errors.email}>
          <input
            className="input" type="email" maxLength={254} autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (errors.email) setErrors((x) => ({ ...x, email: undefined }))
            }}
          />
        </Field>
        <Field label="Role" hint={ROLE_HINT}>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="staff">Staff</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
      </form>
    </Modal>
  )
}

// ── Edit user ────────────────────────────────────────────────────────────────

function EditUserModal({ user, self, onClose, onSaved }: {
  user: UserRow
  self: boolean
  onClose: () => void
  onSaved: (self: boolean) => void
}) {
  const [name, setName] = useState(user.name || '')
  const [email, setEmail] = useState(user.email || '')
  const [role, setRole] = useState<Role>(user.role)
  const [isActive, setIsActive] = useState(!!user.is_active)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = name.trim() !== (user.name || '') || email.trim() !== (user.email || '')
    || role !== user.role || isActive !== !!user.is_active

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return
    if (email.trim() && !EMAIL_PATTERN.test(email.trim())) {
      setEmailError('Enter a valid email address')
      return
    }

    setSaving(true)
    try {
      await userApi.update(user.id, { name: textOrNull(name), email: textOrNull(email), role, is_active: isActive })
      toast.success('User updated')
      onSaved(self)
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the user'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      size="sm"
      title={<>Edit <span className="num">{user.username}</span></>}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="edit-user-form" className="btn-primary" disabled={saving || !dirty}>
            {saving && <Spinner />} Save changes
          </button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name">
          <input className="input" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" error={emailError}>
          <input
            className="input" type="email" maxLength={254} autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (emailError) setEmailError(null)
            }}
          />
        </Field>
        <Field label="Role" hint={self ? 'Another administrator has to change your own role.' : ROLE_HINT}>
          <select className="input" value={role} disabled={self} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="staff">Staff</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <label className={`flex items-start gap-3 ${self ? 'opacity-60' : 'cursor-pointer'}`}>
          <input
            type="checkbox" className="checkbox mt-0.5" checked={isActive} disabled={self}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          <span>
            <span className="block text-sm font-medium text-ink">Active</span>
            <span className="block text-xs text-ink-3 mt-0.5">
              {self
                ? 'You cannot deactivate your own account.'
                : 'An inactive user cannot sign in and is signed out straight away. Nothing they recorded is removed.'}
            </span>
          </span>
        </label>
      </form>
    </Modal>
  )
}

// ── Temporary password ───────────────────────────────────────────────────────

/** Shown once after an account is created or a password is reset. Only "Done" closes it. */
function TemporaryPasswordModal({ issued, onClose }: { issued: IssuedPassword; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.password)
      setCopied(true)
    } catch {
      // The clipboard is only available over HTTPS. Select the text so the
      // older copy command, or the keyboard, can take it.
      field.current?.focus()
      field.current?.select()
      let done = false
      try {
        done = document.execCommand('copy')
      } catch {
        done = false
      }
      if (done) setCopied(true)
      else toast.error('Could not copy automatically. The password is selected, so copy it with the keyboard.')
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      // Closing by accident (Escape, a click outside) would lose the password for good.
      busy
      size="sm"
      title="Temporary password"
      subtitle={
        issued.reason === 'created'
          ? <>The account <span className="num text-ink-2">{issued.username}</span> was created.</>
          : <>The password for <span className="num text-ink-2">{issued.username}</span> was reset.</>
      }
      footer={<button type="button" className="btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="temporary-password">Temporary password</label>
          <div className="flex items-center gap-2">
            <input
              id="temporary-password" ref={field} readOnly value={issued.password}
              className="input num text-base tracking-wider" spellCheck={false} autoComplete="off"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" data-autofocus className="btn-secondary shrink-0" onClick={copy}>
              {copied ? <Check size={15} className="text-good" /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <Notice tone="warn">
          This password will not be shown again. Pass it to {issued.username} privately. They have to choose their own
          password the first time they sign in.
        </Notice>
      </div>
    </Modal>
  )
}

// ── Security log ─────────────────────────────────────────────────────────────

const ACTIONS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Sign-in failed',
  password_changed: 'Changed their password',
  password_change_failed: 'Password change refused (wrong current password)',
  logout_other_sessions: 'Signed out their other devices',
  user_created: 'Added a user',
  user_updated: 'Edited a user',
  user_deleted: 'Deleted a user',
  user_unlocked: 'Unlocked an account',
  password_reset: 'Reset a password',
  password_reset_cli: 'Password reset on the server',
  settings_updated: 'Changed settings',
  logo_updated: 'Uploaded a logo',
  logo_removed: 'Removed the logo',
  backup_created: 'Created a backup',
  backup_downloaded: 'Downloaded a backup',
  backup_deleted: 'Deleted a backup',
  restore_staged: 'Restored a backup',
}

function describeAction(action: string) {
  if (ACTIONS[action]) return ACTIONS[action]
  const words = action.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The stored detail is terse ("username=jane role=staff active=1"); this makes it readable. */
function describeDetail(row: AuditRow, usernames: Map<number, string>) {
  const detail = row.detail
  if (!detail) return '—'
  if (row.action === 'settings_updated') return detail.replace(/_/g, ' ')
  if (row.action === 'login_failed') {
    return detail.replace(/^username=/, 'Username tried: ').replace(/ \(locked\)$/, ' (account locked)')
  }
  const account = /^username=(\S+)(?: role=(\w+))?(?: active=([01]))?$/.exec(detail)
  if (account) {
    return [
      account[1],
      account[2] && (ROLE_LABELS[account[2]] || account[2]).toLowerCase(),
      account[3] && (account[3] === '1' ? 'active' : 'inactive'),
    ].filter(Boolean).join(' · ')
  }
  const byId = /^id=(\d+)$/.exec(detail)
  if (byId) return usernames.get(Number(byId[1])) || `User #${byId[1]}`
  return detail
}

// A long log scrolls under a header that stays in view.
const LOG_TH = 'sticky top-0 z-10 bg-surface-2 shadow-[inset_0_-1px_0_rgb(var(--line))]'

function SecurityLog({ version, usernames }: { version: number; usernames: Map<number, string> }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const ticket = useRef(0)

  const load = useCallback(async () => {
    const mine = ++ticket.current
    setLoading(true)
    setError(null)
    try {
      const data = await userApi.auditLog()
      if (mine === ticket.current) setRows(data)
    } catch (err) {
      if (mine !== ticket.current) return
      setRows(null)
      setError(errorMessage(err, 'Could not load the security log'))
    } finally {
      if (mine === ticket.current) setLoading(false)
    }
  }, [])

  // Read when it is opened, and again after a change made on this tab.
  useEffect(() => {
    if (open) load()
  }, [open, version, load])

  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-surface-2/60 transition-colors"
        aria-expanded={open}
        aria-controls="security-log"
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0">
          <span className="card-title block">Security log</span>
          <span className="card-sub block">
            Sign-ins, password changes, and changes to users, settings and backups. Entries are kept for one year.
          </span>
        </span>
        <ChevronDown size={16} className={`text-ink-3 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id="security-log" className="border-t border-line">
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : rows === null ? (
            <TableSkeleton rows={6} cols={5} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing logged yet" description="Sign-ins and changes to users, settings and backups appear here." />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-line">
                <p className="text-xs text-ink-3">
                  {rows.length >= 200 ? 'The latest 200 events' : `${formatNumber(rows.length)} ${rows.length === 1 ? 'event' : 'events'}`}, newest first
                </p>
                <button type="button" className="btn-ghost btn-sm" onClick={load} disabled={loading}>
                  {loading ? <Spinner size={13} /> : <RefreshCw size={13} />} Refresh
                </button>
              </div>
              <div className="table-scroll max-h-[28rem] overflow-y-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col" className={`th ${LOG_TH}`}>Time</th>
                      <th scope="col" className={`th ${LOG_TH}`}>User</th>
                      <th scope="col" className={`th ${LOG_TH}`}>Action</th>
                      <th scope="col" className={`th ${LOG_TH}`}>Detail</th>
                      <th scope="col" className={`th ${LOG_TH}`}>IP address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const detail = describeDetail(row, usernames)
                      return (
                        <tr key={row.id} className="tr">
                          <td className="td whitespace-nowrap">{formatDateTime(row.created_at)}</td>
                          <td className="td whitespace-nowrap">
                            {row.username ? <span className="num text-ink">{row.username}</span> : 'Unknown'}
                          </td>
                          <td className="td whitespace-nowrap">{describeAction(row.action)}</td>
                          <td className="td">
                            <span className="block max-w-[320px] truncate" title={detail}>{detail}</span>
                          </td>
                          <td className="td num whitespace-nowrap">{row.ip || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
