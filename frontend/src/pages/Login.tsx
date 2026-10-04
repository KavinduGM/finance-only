import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import PasswordInput from '../components/PasswordInput'
import { Spinner } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { errorMessage } from '../lib/format'

export default function Login() {
  const { user, loading, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from || '/dashboard'

  if (!loading && user) {
    return <Navigate to={user.must_change_password ? '/change-password' : from} replace />
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) {
      setError('Enter your username and password')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const u = await login(username.trim(), password)
      navigate(u.must_change_password ? '/change-password' : from, { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not sign in'))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Use the account you were given for the finance system.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="username">Username</label>
          <input
            id="username" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
            autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        {error && (
          <p role="alert" className="text-sm text-bad bg-bad/10 border border-bad/20 rounded-lg px-3 py-2">{error}</p>
        )}

        <button type="submit" className="btn-primary w-full h-10" disabled={busy}>
          {busy ? <Spinner /> : <>Sign in <ArrowRight size={15} /></>}
        </button>
      </form>
    </AuthShell>
  )
}
