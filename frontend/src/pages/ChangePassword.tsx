import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import AuthShell from '../components/AuthShell'
import PasswordInput, { passwordProblem } from '../components/PasswordInput'
import { Spinner } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { authApi } from '../services/api'
import { errorMessage } from '../lib/format'

/** Shown after signing in with a temporary password; nothing else is reachable until it is replaced. */
export default function ChangePassword() {
  const { user, loading, refresh, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  if (!user.must_change_password) return <Navigate to="/dashboard" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const problem = passwordProblem(next, user!.username)
    if (!current) return setError('Enter the temporary password you signed in with')
    if (problem) return setError(problem)
    if (next !== confirm) return setError('The two new passwords do not match')

    setBusy(true)
    setError(null)
    try {
      await authApi.changePassword(current, next)
      await refresh()
      toast.success('Password updated')
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not update the password'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={<>You signed in as <span className="text-ink font-medium">{user.username}</span> with a temporary password. Set your own to continue.</>}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="current">Temporary password</label>
          <PasswordInput id="current" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="next">New password</label>
          <PasswordInput id="next" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="help">At least 10 characters, with letters and numbers.</p>
        </div>
        <div>
          <label className="label" htmlFor="confirm">Repeat new password</label>
          <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        {error && (
          <p role="alert" className="text-sm text-bad bg-bad/10 border border-bad/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <button type="submit" className="btn-primary w-full h-10" disabled={busy}>
          {busy ? <Spinner /> : 'Save and continue'}
        </button>
        <button type="button" className="btn-ghost w-full" onClick={() => logout()}>Sign out</button>
      </form>
    </AuthShell>
  )
}
