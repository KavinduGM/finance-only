import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/** Password field with a show/hide toggle. */
export default function PasswordInput({ className = '', ...props }: Props) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input {...props} type={shown ? 'text' : 'password'} className={`input pr-9 ${className}`} />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown(!shown)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

/** Mirrors the server's password policy (backend/src/services/authService.js). */
export function passwordProblem(password: string, username = ''): string | null {
  if (password.length < 10) return 'Use at least 10 characters'
  if (new TextEncoder().encode(password).length > 72) return 'Use 72 characters or fewer'
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Include both letters and numbers'
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Must not contain your username'
  return null
}
