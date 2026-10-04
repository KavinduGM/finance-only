import { ArrowDownRight, ArrowUpRight, Loader2, Minus, Search, X, AlertCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { formatCompact, formatMoney, formatPercent } from '../../lib/format'

// ── Page header ──────────────────────────────────────────────────────────────

export function PageHeader({ title, description, actions }: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="text-sm text-ink-3 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Filters on the left, actions on the right; wraps on narrow screens. */
export function Toolbar({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>
}

// ── Numbers ──────────────────────────────────────────────────────────────────

/** An amount in its own currency, set in the tabular mono face so columns align. */
export function Money({ amount, currency, compact, className = '' }: {
  amount: unknown
  currency: string
  compact?: boolean
  className?: string
}) {
  return (
    <span className={`font-mono tabular-nums whitespace-nowrap ${className}`}>
      {compact ? formatCompact(amount, currency) : formatMoney(amount, currency)}
    </span>
  )
}

/**
 * Change versus the previous period. The arrow shows direction; the colour
 * shows whether that direction is good (pass goodWhen="down" for costs).
 */
export function Delta({ value, goodWhen = 'up', label }: {
  value: number | null | undefined
  goodWhen?: 'up' | 'down'
  label?: string
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-xs text-ink-3">Nothing to compare yet</span>
  }
  const flat = Math.abs(value) < 0.05
  const up = value > 0
  const good = flat ? null : up === (goodWhen === 'up')
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  const tone = good === null ? 'text-ink-3' : good ? 'text-good' : 'text-bad'
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={`inline-flex items-center gap-0.5 font-mono font-medium ${tone}`}>
        <Icon size={13} strokeWidth={2.25} />
        {formatPercent(value)}
      </span>
      {label && <span className="text-ink-3">{label}</span>}
    </span>
  )
}

// ── Stat card ────────────────────────────────────────────────────────────────

const ICON_TONES = {
  accent: 'bg-accent/10 text-accent border-accent/20',
  good: 'bg-good/10 text-good border-good/20',
  warn: 'bg-warn/10 text-warn border-warn/20',
  bad: 'bg-bad/10 text-bad border-bad/20',
  info: 'bg-info/10 text-info border-info/20',
  neutral: 'bg-surface-3 text-ink-2 border-line',
}

export function StatCard({ label, value, hint, footer, icon: Icon, tone = 'neutral', loading, onClick }: {
  label: string
  /** Already formatted (e.g. via money() / moneyCompact()). */
  value: React.ReactNode
  /** Small line under the value: the exact figure, a count, a period. */
  hint?: React.ReactNode
  /** Usually a <Delta />. */
  footer?: React.ReactNode
  icon?: LucideIcon
  tone?: keyof typeof ICON_TONES
  loading?: boolean
  onClick?: () => void
}) {
  // Spans (not <p>/<div>) inside, so the markup stays valid when the card is a button.
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`card card-pad block text-left w-full ${onClick ? 'transition-colors hover:border-line-strong' : ''}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="eyebrow">{label}</span>
        {Icon && (
          <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 ${ICON_TONES[tone]}`}>
            <Icon size={15} />
          </span>
        )}
      </span>
      {loading ? (
        <span className="skeleton block h-7 w-32 mt-2" />
      ) : (
        <span className="block mt-1.5 text-2xl font-semibold tracking-tight text-ink truncate">{value}</span>
      )}
      {hint && !loading && <span className="block text-xs text-ink-3 mt-1">{hint}</span>}
      {footer && !loading && <span className="block mt-2.5">{footer}</span>}
    </Tag>
  )
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = {
  paid: 'badge-good', accepted: 'badge-good', active: 'badge-good', success: 'badge-good', income: 'badge-good',
  sent: 'badge-info', pending: 'badge-info', info: 'badge-info',
  draft: 'badge-neutral', inactive: 'badge-neutral', paused: 'badge-neutral', completed: 'badge-neutral', ended: 'badge-neutral',
  overdue: 'badge-bad', declined: 'badge-bad', critical: 'badge-bad', locked: 'badge-bad',
  expired: 'badge-warn', warning: 'badge-warn', cancelled: 'badge-warn', expense: 'badge-warn',
}

/** Coloured pill for a status word. Unknown statuses fall back to neutral. */
export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const key = String(status || '').toLowerCase()
  return (
    <span className={STATUS_TONE[key] || 'badge-neutral'}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label || status || '—'}
    </span>
  )
}

// ── Empty, loading and error states ──────────────────────────────────────────

export function EmptyState({ icon: Icon, title, description, action }: {
  icon?: LucideIcon
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      {Icon && (
        <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-surface-2 border border-line text-ink-3 mb-3">
          <Icon size={20} />
        </span>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="text-sm text-ink-3 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-sm text-ink-3">
      <Spinner /> {label}
    </div>
  )
}

/** Skeleton rows for a table that is still loading. */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((__, c) => (
            <div key={c} className="skeleton h-4 flex-1" style={{ maxWidth: c === 0 ? '30%' : undefined }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-bad/10 border border-bad/20 text-bad mb-3">
        <AlertCircle size={20} />
      </span>
      <p className="text-sm font-semibold text-ink">Could not load this</p>
      <p className="text-sm text-ink-3 mt-1 max-w-sm">{message}</p>
      {onRetry && <button className="btn-secondary mt-4" onClick={onRetry}>Try again</button>}
    </div>
  )
}

// ── Form helpers ─────────────────────────────────────────────────────────────

export function Field({ label, hint, error, required, className = '', children }: {
  label: string
  hint?: React.ReactNode
  error?: string | null
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">
        {label}
        {required && <span className="text-accent ml-0.5">*</span>}
      </span>
      {children}
      {error ? <span className="field-error block">{error}</span> : hint ? <span className="help block">{hint}</span> : null}
    </label>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search', label, className = '' }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Accessible name; defaults to the placeholder. */
  label?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label || placeholder}
        maxLength={100}
        className="input pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

export interface TabItem<T extends string> {
  id: T
  label: string
  icon?: LucideIcon
  count?: number
}

/** Underlined tabs for switching sections of a page. */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: TabItem<T>[]
  value: T
  onChange: (id: NoInfer<T>) => void
}) {
  return (
    <div className="flex gap-1 border-b border-line overflow-x-auto" role="tablist">
      {tabs.map(({ id, label, icon: Icon, count }) => {
        const active = id === value
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`relative inline-flex items-center gap-2 h-10 px-3 text-sm font-medium whitespace-nowrap transition-colors
              ${active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {Icon && <Icon size={15} className={active ? 'text-accent' : ''} />}
            {label}
            {count !== undefined && <span className="text-2xs font-mono text-ink-3">{count}</span>}
            {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        )
      })}
    </div>
  )
}

/** Row of filter chips where exactly one is active (e.g. status filters). */
export function Segmented<T extends string>({ options, value, onChange }: {
  options: { id: T; label: string; count?: number }[]
  value: T
  onChange: (id: NoInfer<T>) => void
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-surface border border-line">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} className={o.id === value ? 'chip-active' : 'chip'}>
          {o.label}
          {o.count !== undefined && <span className="font-mono text-2xs text-ink-3">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}
