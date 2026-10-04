import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, FileSignature, FileText, TrendingUp, Receipt, Repeat, Wallet, Users, BarChart3, Settings, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSettings } from '../../context/SettingsContext'

const GROUPS: { title: string; items: { to: string; icon: LucideIcon; label: string }[] }[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' }],
  },
  {
    title: 'Sales',
    items: [
      { to: '/proposals', icon: FileSignature, label: 'Proposals' },
      { to: '/invoices', icon: FileText, label: 'Invoices' },
      { to: '/clients', icon: Users, label: 'Clients' },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/income', icon: TrendingUp, label: 'Income' },
      { to: '/expenses', icon: Receipt, label: 'Expenses' },
      { to: '/recurring', icon: Repeat, label: 'Recurring' },
      { to: '/payroll', icon: Wallet, label: 'Payroll' },
    ],
  },
  {
    title: 'Insight',
    items: [{ to: '/reports', icon: BarChart3, label: 'Reports' }],
  },
]

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { companyName } = useSettings()

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-60 shrink-0 flex flex-col bg-surface/95 backdrop-blur border-r border-line
          transition-transform duration-200 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-14 flex items-center justify-between px-4 border-b border-line">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 border border-accent/25 shrink-0">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.25"
                strokeLinecap="round" strokeLinejoin="round" className="text-accent">
                <path d="M4 17l5-5 4 3 7-8" />
              </svg>
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-semibold text-ink truncate">{companyName}</p>
              <p className="text-2xs uppercase tracking-[0.14em] text-ink-3">Finance</p>
            </div>
          </div>
          <button className="btn-icon lg:hidden" onClick={onClose} aria-label="Close menu"><X size={16} /></button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p className="eyebrow px-3 mb-1.5">{group.title}</p>
              <div className="space-y-0.5">
                {group.items.map(({ to, icon: Icon, label }) => (
                  <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                    <Icon size={16} />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 py-3 border-t border-line">
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Settings size={16} />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>
    </>
  )
}
