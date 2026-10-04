import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { ThemeProvider } from './context/ThemeContext'
import { ConfirmProvider, Spinner } from './components/ui'
import Layout from './components/Layout/Layout'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import Dashboard from './pages/Dashboard'
import Proposals from './pages/Proposals'
import Invoices from './pages/Invoices'
import Clients from './pages/Clients'
import Revenue from './pages/Revenue'
import Expenses from './pages/Expenses'
import RecurringPayments from './pages/RecurringPayments'
import Salaries from './pages/Salaries'
import Reports from './pages/Reports'
import Settings from './pages/Settings'

/** Sends signed-out visitors to the login page and remembers where they were going. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen app-backdrop flex items-center justify-center text-ink-3">
        <Spinner size={20} />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (user.must_change_password) return <Navigate to="/change-password" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <SettingsProvider>
            <ConfirmProvider>
              <Toaster
                position="top-right"
                toastOptions={{
                  duration: 4000,
                  style: {
                    background: 'rgb(var(--surface-3))',
                    color: 'rgb(var(--ink))',
                    border: '1px solid rgb(var(--line-strong))',
                    borderRadius: '10px',
                    fontSize: '13px',
                    maxWidth: '420px',
                  },
                  success: { iconTheme: { primary: 'rgb(var(--good))', secondary: 'rgb(var(--surface-3))' } },
                  error: { duration: 6000, iconTheme: { primary: 'rgb(var(--bad))', secondary: 'rgb(var(--surface-3))' } },
                }}
              />
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/change-password" element={<ChangePassword />} />

                <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
                  <Route index element={<Navigate to="/dashboard" replace />} />
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="proposals" element={<Proposals />} />
                  <Route path="invoices" element={<Invoices />} />
                  <Route path="clients" element={<Clients />} />
                  <Route path="income" element={<Revenue />} />
                  <Route path="expenses" element={<Expenses />} />
                  <Route path="recurring" element={<RecurringPayments />} />
                  <Route path="payroll" element={<Salaries />} />
                  <Route path="reports" element={<Reports />} />
                  <Route path="settings" element={<Settings />} />
                  {/* Addresses used by the previous version */}
                  <Route path="revenue" element={<Navigate to="/income" replace />} />
                  <Route path="salaries" element={<Navigate to="/payroll" replace />} />
                </Route>

                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </ConfirmProvider>
          </SettingsProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}
