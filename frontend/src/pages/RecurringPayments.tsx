import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  ArrowDownLeft, ArrowUpRight, CalendarClock, Check, Pause, Pencil, Play, Plus, Repeat, RotateCcw, Trash2, X,
} from 'lucide-react'
import { recurringApi } from '../services/api'
import type { RecurringPayment } from '../services/api'
import {
  EmptyState, ErrorState, Field, Modal, Money, PageHeader, Segmented, Spinner, StatCard, StatusBadge,
  TableSkeleton, Toolbar, useConfirm,
} from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import {
  daysUntil, errorMessage, formatCompact, formatDate, formatMoney, formatNumber, SUPPORTED_CURRENCIES, symbolFor, todayISO,
} from '../lib/format'

type PaymentType = 'Income' | 'Expense'
type TypeFilter = 'all' | PaymentType

// The vocabulary of backend/src/routes/recurring.js. An item that does not
// renew ends as Cancelled once its last payment has been processed.
const STATUSES = ['Active', 'Paused', 'Cancelled']
const STATUS_ORDER: Record<string, number> = { Active: 0, Paused: 1, Cancelled: 2 }
const CYCLES = ['Weekly', 'Monthly', 'Quarterly', 'Semi-Annual', 'Annual']

// What one payment of each cycle is worth per month.
const PER_MONTH: Record<string, number> = {
  Weekly: 52 / 12, Monthly: 1, Quarterly: 1 / 3, 'Semi-Annual': 1 / 6, Annual: 1 / 12,
}

// Category suggestions. "Salaries" is left out: payroll records those itself.
const EXPENSE_CATEGORIES = [
  'Software', 'Subscriptions', 'Hosting', 'Marketing', 'Office', 'Rent', 'Utilities', 'Professional fees', 'Bank charges', 'Other',
]
const INCOME_CATEGORIES = ['Retainer', 'Service fee', 'Consulting', 'Maintenance', 'License', 'Other']

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const statusOf = (r: RecurringPayment) => r.status || 'Active'
const isActive = (r: RecurringPayment) => statusOf(r) === 'Active'
const renews = (r: RecurringPayment) => Number(r.auto_renewal ?? 1) !== 0
// The server treats an unknown cycle as monthly; so does this page.
const cycleOf = (r: RecurringPayment) => (CYCLES.includes(r.billing_cycle) ? r.billing_cycle : 'Monthly')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const httpStatus = (err: unknown) => (err as { response?: { status?: number } } | null)?.response?.status
const errorCode = (err: unknown) => (err as { response?: { data?: { code?: string } } } | null)?.response?.data?.code

interface CurrencyTotal {
  currency: string
  total: number
}

/**
 * Monthly equivalent of the given items, one figure per currency (base
 * currency first). Amounts in different currencies are never added together.
 */
function monthlyByCurrency(rows: RecurringPayment[], base: string): CurrencyTotal[] {
  const sums = new Map<string, number>()
  for (const r of rows) {
    const currency = (r.currency || base).toUpperCase()
    sums.set(currency, (sums.get(currency) || 0) + (Number(r.amount) || 0) * PER_MONTH[cycleOf(r)])
  }
  return Array.from(sums, ([currency, total]) => ({ currency, total })).sort((a, b) =>
    a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency))
}

/** "1 late · 2 due in 7 days" for a stat card. */
function dueSummary(items: RecurringPayment[]) {
  if (items.length === 0) return 'None set up'
  let late = 0
  let soon = 0
  for (const r of items) {
    const days = daysUntil(r.next_payment_date)
    if (days === null) continue
    if (days < 0) late += 1
    else if (days <= 7) soon += 1
  }
  const parts: string[] = []
  if (late) parts.push(`${late} late`)
  parts.push(soon ? `${soon} due in 7 days` : 'Nothing due in 7 days')
  return parts.join(' · ')
}

/** The line under a next payment date. The words carry the meaning; the tone only supports them. */
function dueNote(dateISO: string | null) {
  const days = daysUntil(dateISO)
  if (days === null) return { text: 'No date set', tone: 'text-warn' }
  if (days < 0) return { text: `${plural(-days, 'day')} late`, tone: 'text-bad' }
  if (days === 0) return { text: 'Due today', tone: 'text-warn' }
  return { text: `in ${plural(days, 'day')}`, tone: days <= 7 ? 'text-warn' : 'text-ink-3' }
}

/** Big figure of a "per month" stat card: compact when there is one currency, a short list otherwise. */
function MonthlyValue({ totals }: { totals: CurrencyTotal[] }) {
  if (totals.length === 0) return <span className="text-ink-3">—</span>
  if (totals.length === 1) return <>{formatCompact(totals[0].total, totals[0].currency)}</>
  return (
    <span className="flex flex-col gap-0.5 text-base leading-6">
      {totals.map((t) => (
        <span key={t.currency} className="truncate">{formatMoney(t.total, t.currency)}</span>
      ))}
    </span>
  )
}

function monthlyHint(totals: CurrencyTotal[]) {
  if (totals.length === 0) return 'No active items'
  if (totals.length === 1) return `${formatMoney(totals[0].total, totals[0].currency)} monthly equivalent`
  return 'Monthly equivalent, one line per currency'
}

function InlineTotals({ label, totals }: { label: string; totals: CurrencyTotal[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="eyebrow">{label}</span>
      {totals.length === 0 ? (
        <span className="text-sm text-ink-3">—</span>
      ) : totals.map((t, i) => (
        <Fragment key={t.currency}>
          {i > 0 && <span className="text-ink-3" aria-hidden="true">·</span>}
          <Money amount={t.total} currency={t.currency} className="text-sm font-medium text-ink" />
        </Fragment>
      ))}
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className="text-ink text-right">{children}</span>
    </div>
  )
}

interface FormState {
  name: string
  type: PaymentType
  category: string
  billing_cycle: string
  amount: string
  currency: string
  next_payment_date: string
  client_vendor: string
  email: string
  reminder_days: string
  auto_renewal: boolean
  status: string
  notes: string
}

type FormErrors = Partial<Record<'name' | 'amount' | 'next_payment_date' | 'email' | 'reminder_days', string>>

const emptyForm = (currency: string): FormState => ({
  name: '', type: 'Expense', category: '', billing_cycle: 'Monthly', amount: '', currency,
  next_payment_date: todayISO(), client_vendor: '', email: '', reminder_days: '3',
  auto_renewal: true, status: 'Active', notes: '',
})

const formFrom = (r: RecurringPayment, fallbackCurrency: string): FormState => ({
  name: r.name || '',
  type: r.type === 'Income' ? 'Income' : 'Expense',
  category: r.category || '',
  billing_cycle: cycleOf(r),
  amount: r.amount === null || r.amount === undefined ? '' : String(r.amount),
  currency: r.currency || fallbackCurrency,
  // A date input only takes YYYY-MM-DD; older rows may carry a full timestamp.
  next_payment_date: r.next_payment_date ? r.next_payment_date.slice(0, 10) : '',
  client_vendor: r.client_vendor || '',
  email: r.email || '',
  reminder_days: String(r.reminder_days ?? 3),
  auto_renewal: renews(r),
  status: STATUSES.includes(statusOf(r)) ? statusOf(r) : 'Active',
  notes: r.notes || '',
})

function dateProblem(value: string, missing: string) {
  if (!value) return missing
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') {
    return 'The date must be between 2000 and 2100'
  }
  return null
}

function validate(f: FormState): FormErrors {
  const problems: FormErrors = {}
  if (!f.name.trim()) problems.name = 'Enter a name'

  const amount = Number(f.amount)
  if (f.amount.trim() === '') problems.amount = 'Enter the amount'
  else if (!Number.isFinite(amount) || Math.round(amount * 100) <= 0) problems.amount = 'Amount must be greater than 0'
  else if (amount > 1e12) problems.amount = 'Amount is too large'

  const date = dateProblem(f.next_payment_date, 'Choose the next payment date')
  if (date) problems.next_payment_date = date

  const email = f.email.trim()
  if (email && !EMAIL.test(email)) problems.email = 'Enter a valid email address'

  const days = Number(f.reminder_days)
  if (f.reminder_days.trim() === '' || !Number.isInteger(days) || days < 0 || days > 60) {
    problems.reminder_days = 'Enter a whole number from 0 to 60'
  }
  return problems
}

const bodyFromForm = (f: FormState): Partial<RecurringPayment> => ({
  name: f.name.trim(),
  type: f.type,
  category: f.category.trim() || null,
  billing_cycle: f.billing_cycle,
  amount: Number(f.amount),
  currency: f.currency,
  next_payment_date: f.next_payment_date,
  auto_renewal: f.auto_renewal ? 1 : 0,
  client_vendor: f.client_vendor.trim() || null,
  email: f.email.trim() || null,
  reminder_days: Number(f.reminder_days),
  notes: f.notes.trim() || null,
})

export default function RecurringPayments() {
  const { baseCurrency } = useSettings()
  const confirm = useConfirm()

  // null = nothing loaded yet (first load, or the last load failed)
  const [rows, setRows] = useState<RecurringPayment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RecurringPayment | null>(null)
  const [reactivating, setReactivating] = useState(false)
  const [form, setForm] = useState<FormState>(() => emptyForm(baseCurrency))
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)

  const [busy, setBusy] = useState<{ id: number; action: 'status' | 'delete' } | null>(null)

  const [target, setTarget] = useState<RecurringPayment | null>(null)
  const [paidDate, setPaidDate] = useState(todayISO())
  const [moveOnly, setMoveOnly] = useState(false)
  const [paidDateError, setPaidDateError] = useState<string | null>(null)
  const [alreadyRecorded, setAlreadyRecorded] = useState(false)
  const [processing, setProcessing] = useState(false)

  // Only the newest request may update the list; slower, older answers are dropped.
  const latestRequest = useRef(0)

  // The whole list is loaded once and filtered here, so the summary cards
  // stay the same whichever filter is on.
  const load = useCallback(async () => {
    const ticket = ++latestRequest.current
    setRefreshing(true)
    setError(null)
    try {
      const data = await recurringApi.list()
      if (ticket !== latestRequest.current) return
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      if (ticket !== latestRequest.current) return
      setRows(null)
      setError(errorMessage(err, 'Could not load recurring payments'))
    } finally {
      if (ticket === latestRequest.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { latestRequest.current += 1 }, [])

  const categories = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows || []) if (r.category) seen.add(r.category)
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [rows])

  // A category that no longer has any item cannot stay selected.
  useEffect(() => {
    if (rows && categoryFilter && !categories.includes(categoryFilter)) setCategoryFilter('')
  }, [rows, categories, categoryFilter])

  const summary = useMemo(() => {
    const active = (rows || []).filter(isActive)
    const income = active.filter((r) => r.type === 'Income')
    const expense = active.filter((r) => r.type === 'Expense')
    return {
      income,
      expense,
      incomeMonthly: monthlyByCurrency(income, baseCurrency),
      expenseMonthly: monthlyByCurrency(expense, baseCurrency),
    }
  }, [rows, baseCurrency])

  // Rows after the status and category filters; the type filter is applied last so its chips can show counts.
  const narrowed = useMemo(() => (rows || []).filter((r) =>
    (!statusFilter || statusOf(r) === statusFilter) && (!categoryFilter || r.category === categoryFilter)),
  [rows, statusFilter, categoryFilter])

  const shown = useMemo(() => {
    const list = typeFilter === 'all' ? [...narrowed] : narrowed.filter((r) => r.type === typeFilter)
    // Active items first; inside each group the server's order (soonest date first) is kept.
    return list.sort((a, b) => (STATUS_ORDER[statusOf(a)] ?? 3) - (STATUS_ORDER[statusOf(b)] ?? 3))
  }, [narrowed, typeFilter])

  const shownMonthly = useMemo(() => {
    const active = shown.filter(isActive)
    return {
      income: monthlyByCurrency(active.filter((r) => r.type === 'Income'), baseCurrency),
      expense: monthlyByCurrency(active.filter((r) => r.type === 'Expense'), baseCurrency),
    }
  }, [shown, baseCurrency])

  const typeOptions: { id: TypeFilter; label: string; count?: number }[] = [
    { id: 'all', label: 'All', count: rows ? narrowed.length : undefined },
    { id: 'Income', label: 'Income', count: rows ? narrowed.filter((r) => r.type === 'Income').length : undefined },
    { id: 'Expense', label: 'Expense', count: rows ? narrowed.filter((r) => r.type === 'Expense').length : undefined },
  ]

  const filtersActive = typeFilter !== 'all' || !!statusFilter || !!categoryFilter
  const firstLoad = rows === null && !error

  function clearFilters() {
    setTypeFilter('all')
    setStatusFilter('')
    setCategoryFilter('')
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  function openNew() {
    setEditing(null)
    setReactivating(false)
    setForm({ ...emptyForm(baseCurrency), type: typeFilter === 'Income' ? 'Income' : 'Expense' })
    setErrors({})
    setModalOpen(true)
  }

  // A cancelled item comes back through the form, so its next date is checked before it is active again.
  function openEdit(row: RecurringPayment, reactivate = false) {
    setEditing(row)
    setReactivating(reactivate)
    setForm({ ...formFrom(row, baseCurrency), ...(reactivate ? { status: 'Active' } : {}) })
    setErrors({})
    setModalOpen(true)
  }

  function closeModal() {
    if (!saving) setModalOpen(false)
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((prev) => (key in prev ? { ...prev, [key]: undefined } : prev))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    const problems = validate(form)
    if (Object.values(problems).some(Boolean)) {
      setErrors(problems)
      return
    }

    setSaving(true)
    try {
      if (editing) await recurringApi.update(editing.id, { ...bodyFromForm(form), status: form.status })
      else await recurringApi.create(bodyFromForm(form))
      toast.success(editing ? 'Recurring payment updated' : 'Recurring payment added')
      setModalOpen(false)
      load()
    } catch (err) {
      toast.error(errorMessage(err, editing ? 'Could not update this recurring payment' : 'Could not add this recurring payment'))
    } finally {
      setSaving(false)
    }
  }

  // ── Row actions ────────────────────────────────────────────────────────────

  async function changeStatus(row: RecurringPayment, status: 'Active' | 'Paused') {
    setBusy({ id: row.id, action: 'status' })
    try {
      // Only the status is sent, so nothing changed elsewhere since this list was loaded is overwritten.
      await recurringApi.setStatus(row.id, status)
      toast.success(status === 'Paused' ? `${row.name} is paused` : `${row.name} is active again`)
      await load()
    } catch (err) {
      toast.error(errorMessage(err, status === 'Paused' ? 'Could not pause this item' : 'Could not resume this item'))
    } finally {
      setBusy(null)
    }
  }

  async function remove(row: RecurringPayment) {
    const ok = await confirm({
      title: 'Delete this recurring payment?',
      message: (
        <>
          <span className="text-ink font-medium">{row.name}</span> will be removed from this list. Income and
          expenses already recorded from it stay in the books.
        </>
      ),
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return

    setBusy({ id: row.id, action: 'delete' })
    try {
      await recurringApi.delete(row.id)
      toast.success('Recurring payment deleted')
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete this recurring payment'))
    } finally {
      setBusy(null)
    }
  }

  // ── Record payment ─────────────────────────────────────────────────────────

  function openProcess(row: RecurringPayment) {
    setTarget(row)
    setPaidDate(todayISO())
    setMoveOnly(false)
    setPaidDateError(null)
    setAlreadyRecorded(false)
  }

  function closeProcess() {
    if (!processing) setTarget(null)
  }

  async function submitProcess(e: React.FormEvent) {
    e.preventDefault()
    if (!target || processing) return
    if (!moveOnly) {
      const problem = dateProblem(paidDate, 'Choose the payment date')
      if (problem) {
        setPaidDateError(problem)
        return
      }
    }

    // The due date this dialog shows. The server refuses (409) when the item has since moved past it,
    // so a stale list or a second click never settles the following occurrence as well.
    const occurrence_date = target.next_payment_date ? target.next_payment_date.slice(0, 10) : undefined

    setProcessing(true)
    try {
      const res = await recurringApi.process(
        target.id,
        moveOnly ? { record: false, occurrence_date } : { record: true, paid_date: paidDate, occurrence_date },
      )
      // The server's sentence carries the new date as YYYY-MM-DD; show it the way every other date is shown.
      const next = res.next_payment_date
      const message = !next
        ? res.message
        : res.message.includes(next)
          ? res.message.replace(next, formatDate(next))
          : `${res.message} Next payment date: ${formatDate(next)}.`
      toast.success(message)
      setTarget(null)
      load()
    } catch (err) {
      const code = httpStatus(err) === 409 ? errorCode(err) : undefined
      // ALREADY_RECORDED: this occurrence is already in the books. The dialog stays open and says how to move on.
      setAlreadyRecorded(code === 'ALREADY_RECORDED')
      toast.error(errorMessage(err, moveOnly ? 'Could not move the date' : 'Could not record this payment'))
      load()
      // OCCURRENCE_CHANGED: the item has moved on since this dialog was opened, so what it shows is out of date.
      if (code === 'OCCURRENCE_CHANGED') setTarget(null)
    } finally {
      setProcessing(false)
    }
  }

  const supported: readonly string[] = SUPPORTED_CURRENCIES
  const currencyOptions = supported.includes(form.currency) ? supported : [...supported, form.currency]

  const categorySuggestions = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const name of [...categories, ...(form.type === 'Income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES)]) {
      const key = name.trim().toLowerCase()
      if (!key || key === 'salaries' || seen.has(key)) continue
      seen.add(key)
      list.push(name.trim())
    }
    return list
  }, [categories, form.type])

  const reminderDays = Number(form.reminder_days)
  const reminderWhen = form.reminder_days.trim() === '' || !Number.isInteger(reminderDays) || reminderDays < 0
    ? 'before the payment date'
    : reminderDays === 0
      ? 'on the payment date'
      : `${plural(reminderDays, 'day')} before the payment date`
  const formDatePassed = (daysUntil(form.next_payment_date) ?? 0) < 0

  const targetBook = target?.type === 'Income' ? 'Income' : 'Expenses'
  const targetRenews = target ? renews(target) : true
  const targetCycle = target ? cycleOf(target).toLowerCase() : ''

  return (
    <div className="page">
      <PageHeader
        title="Recurring"
        description="Subscriptions, retainers and other payments that repeat"
        actions={
          <button type="button" className="btn-primary" onClick={openNew}>
            <Plus size={16} /> Add recurring payment
          </button>
        }
      />

      {!error && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Active income items" icon={ArrowDownLeft} tone="good" loading={firstLoad}
            value={formatNumber(summary.income.length)} hint={dueSummary(summary.income)}
          />
          <StatCard
            label="Active expense items" icon={ArrowUpRight} tone="warn" loading={firstLoad}
            value={formatNumber(summary.expense.length)} hint={dueSummary(summary.expense)}
          />
          <StatCard
            label="Income per month" icon={CalendarClock} loading={firstLoad}
            value={<MonthlyValue totals={summary.incomeMonthly} />} hint={monthlyHint(summary.incomeMonthly)}
          />
          <StatCard
            label="Expenses per month" icon={CalendarClock} loading={firstLoad}
            value={<MonthlyValue totals={summary.expenseMonthly} />} hint={monthlyHint(summary.expenseMonthly)}
          />
        </div>
      )}

      <Toolbar>
        <Segmented<TypeFilter> options={typeOptions} value={typeFilter} onChange={setTypeFilter} />
        <select
          className="input w-full sm:w-40" value={statusFilter} aria-label="Filter by status"
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          className="input w-full sm:w-48" value={categoryFilter} aria-label="Filter by category"
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {filtersActive && (
          <button type="button" className="btn-ghost btn-sm" onClick={clearFilters}>
            <X size={13} /> Clear filters
          </button>
        )}
      </Toolbar>

      {/* Category totals: what the chosen category adds up to per month, one figure per currency. */}
      {categoryFilter && rows && !error && (
        <div className="card px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-2">
          <div className="flex items-baseline gap-2">
            <span className="eyebrow">{categoryFilter}</span>
            <span className="num text-sm font-medium text-ink">{formatNumber(shown.length)}</span>
            <span className="text-xs text-ink-3">{shown.length === 1 ? 'item shown' : 'items shown'}</span>
          </div>
          {typeFilter !== 'Expense' && <InlineTotals label="Income per month" totals={shownMonthly.income} />}
          {typeFilter !== 'Income' && <InlineTotals label="Expenses per month" totals={shownMonthly.expense} />}
          <span className="text-xs text-ink-3">Active items only, never converted between currencies</span>
        </div>
      )}

      {error ? (
        <div className="card">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : (
        <div
          className={`table-wrap transition-opacity duration-150 ${rows && refreshing ? 'opacity-60' : ''}`}
          aria-busy={refreshing}
        >
          {rows === null ? (
            <TableSkeleton rows={6} cols={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="No recurring payments yet"
              description="Add the subscriptions you pay and the retainers you are paid, and record each payment from here when it happens."
              action={
                <button type="button" className="btn-primary" onClick={openNew}>
                  <Plus size={16} /> Add recurring payment
                </button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="Nothing matches these filters"
              description="Try a different type, status or category."
              action={<button type="button" className="btn-secondary" onClick={clearFilters}>Clear filters</button>}
            />
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Type</th>
                    <th className="th">Category</th>
                    <th className="th">Cycle</th>
                    <th className="th">Next date</th>
                    <th className="th-num">Amount</th>
                    <th className="th">Status</th>
                    <th className="th text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const status = statusOf(row)
                    const active = status === 'Active'
                    const rowBusy = busy?.id === row.id
                    const due = dueNote(row.next_payment_date)

                    return (
                      <tr key={row.id} className="tr">
                        <td className="td">
                          <p className="td-strong truncate max-w-[240px]" title={row.name}>{row.name}</p>
                          {row.client_vendor && (
                            <p className="text-xs text-ink-3 mt-0.5 truncate max-w-[240px]" title={row.client_vendor}>
                              {row.client_vendor}
                            </p>
                          )}
                        </td>
                        <td className="td">
                          <StatusBadge status={String(row.type || '').toLowerCase()} label={row.type} />
                        </td>
                        <td className="td">
                          {row.category ? (
                            <span className="block truncate max-w-[160px]" title={row.category}>{row.category}</span>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap">
                          <p>{row.billing_cycle || 'Monthly'}</p>
                          {!renews(row) && <p className="text-xs text-ink-3 mt-0.5">Does not renew</p>}
                        </td>
                        <td className="td whitespace-nowrap">
                          <p className={active ? 'text-ink' : ''}>{formatDate(row.next_payment_date)}</p>
                          {active && <p className={`text-xs mt-0.5 ${due.tone}`}>{due.text}</p>}
                        </td>
                        <td className="td-num">
                          <Money amount={row.amount} currency={row.currency || baseCurrency} />
                        </td>
                        <td className="td">
                          <StatusBadge status={status} />
                        </td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-1">
                            {active && (
                              <button
                                type="button" onClick={() => openProcess(row)} disabled={rowBusy}
                                className="btn btn-sm mr-1 bg-accent/10 text-accent border border-accent/25 hover:bg-accent/20"
                                title="Record payment" aria-label={`Record payment for ${row.name}`}
                              >
                                <Check size={13} /> Record
                              </button>
                            )}
                            <button
                              type="button" className="btn-icon" onClick={() => openEdit(row)} disabled={rowBusy}
                              title="Edit" aria-label={`Edit ${row.name}`}
                            >
                              <Pencil size={14} />
                            </button>
                            {active ? (
                              <button
                                type="button" className="btn-icon" onClick={() => changeStatus(row, 'Paused')} disabled={rowBusy}
                                title="Pause" aria-label={`Pause ${row.name}`}
                              >
                                {rowBusy && busy?.action === 'status' ? <Spinner size={14} /> : <Pause size={14} />}
                              </button>
                            ) : status === 'Paused' ? (
                              <button
                                type="button" className="btn-icon" onClick={() => changeStatus(row, 'Active')} disabled={rowBusy}
                                title="Resume" aria-label={`Resume ${row.name}`}
                              >
                                {rowBusy && busy?.action === 'status' ? <Spinner size={14} /> : <Play size={14} />}
                              </button>
                            ) : (
                              <button
                                type="button" className="btn-icon" onClick={() => openEdit(row, true)} disabled={rowBusy}
                                title="Reactivate" aria-label={`Reactivate ${row.name}`}
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}
                            <button
                              type="button" className="btn-icon-danger" onClick={() => remove(row)} disabled={rowBusy}
                              title="Delete" aria-label={`Delete ${row.name}`}
                            >
                              {rowBusy && busy?.action === 'delete' ? <Spinner size={14} /> : <Trash2 size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add / edit */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit recurring payment' : 'Add recurring payment'}
        busy={saving}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
            <button type="submit" form="recurring-form" className="btn-primary" disabled={saving}>
              {saving ? <><Spinner /> Saving</> : editing ? 'Save changes' : 'Add recurring payment'}
            </button>
          </>
        }
      >
        <form id="recurring-form" onSubmit={submit} noValidate className="form-grid">
          {reactivating && (
            <p className="form-full text-sm text-info bg-info/10 border border-info/20 rounded-lg px-3 py-2">
              This item is cancelled. Check the next payment date, then save to make it active again.
            </p>
          )}

          <Field label="Name" required error={errors.name} className="form-full">
            <input
              className="input" value={form.name} maxLength={200} placeholder="For example, design software subscription"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Type" required hint={form.type === 'Income' ? 'Money you are paid' : 'Money you pay'}>
            <select className="input" value={form.type} onChange={(e) => set('type', e.target.value as PaymentType)}>
              <option value="Expense">Expense</option>
              <option value="Income">Income</option>
            </select>
          </Field>
          <Field
            label="Category"
            hint={form.type === 'Income'
              ? 'Becomes the service type of the income that is recorded'
              : 'Becomes the category of the expense that is recorded'}
          >
            <input
              className="input" list="recurring-category-options" value={form.category} maxLength={100}
              autoComplete="off" onChange={(e) => set('category', e.target.value)}
            />
            <datalist id="recurring-category-options">
              {categorySuggestions.map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>

          <Field label="Amount" required error={errors.amount} hint="For one payment">
            <input
              className="input-num" type="number" min="0" step="any" inputMode="decimal" placeholder="0.00"
              value={form.amount} onChange={(e) => set('amount', e.target.value)}
            />
          </Field>
          <Field label="Currency">
            <select className="input" value={form.currency} onChange={(e) => set('currency', e.target.value)}>
              {currencyOptions.map((c) => <option key={c} value={c}>{c} — {symbolFor(c)}</option>)}
            </select>
          </Field>

          <Field label="Billing cycle">
            <select className="input" value={form.billing_cycle} onChange={(e) => set('billing_cycle', e.target.value)}>
              {CYCLES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field
            label="Next payment date" required error={errors.next_payment_date}
            hint={formDatePassed ? 'This date has already passed' : undefined}
          >
            <input
              className="input" type="date" min="2000-01-01" max="2100-12-31"
              value={form.next_payment_date} onChange={(e) => set('next_payment_date', e.target.value)}
            />
          </Field>

          <Field
            label={form.type === 'Income' ? 'Client' : 'Vendor'}
            hint={form.type === 'Income' ? 'Who pays you' : 'Who you pay'}
            className={editing ? '' : 'form-full'}
          >
            <input
              className="input" value={form.client_vendor} maxLength={200}
              onChange={(e) => set('client_vendor', e.target.value)}
            />
          </Field>
          {editing && (
            <Field label="Status" hint="Only active items can be recorded and send reminders">
              <select className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}

          <p className="eyebrow form-full pt-1">Reminder</p>
          <Field
            label="Reminder email" error={errors.email}
            hint={`Optional. A reminder is emailed here ${reminderWhen}.`}
          >
            <input
              className="input" type="email" value={form.email} maxLength={254} placeholder="name@example.com"
              autoComplete="off" onChange={(e) => set('email', e.target.value)}
            />
          </Field>
          <Field label="Reminder days" error={errors.reminder_days} hint="Days before the payment date, 0 to 60">
            <input
              className="input-num" type="number" min="0" max="60" step="1" inputMode="numeric"
              value={form.reminder_days} onChange={(e) => set('reminder_days', e.target.value)}
            />
          </Field>

          <label className="form-full flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
            <input
              type="checkbox" className="checkbox mt-0.5 shrink-0" checked={form.auto_renewal}
              onChange={(e) => set('auto_renewal', e.target.checked)}
            />
            <span className="text-sm text-ink">
              Renews automatically
              <span className="help block">
                When this is off, the item finishes after the next payment and is marked as Cancelled.
              </span>
            </span>
          </label>

          <Field label="Notes" className="form-full">
            <textarea
              className="input resize-y" rows={2} value={form.notes} maxLength={2000}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>
        </form>
      </Modal>

      {/* Record payment */}
      <Modal
        open={!!target}
        onClose={closeProcess}
        size="sm"
        title="Record payment"
        subtitle={target?.name}
        busy={processing}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeProcess} disabled={processing}>Cancel</button>
            <button type="submit" form="recurring-process-form" className="btn-primary" disabled={processing}>
              {processing ? <><Spinner /> Working</> : moveOnly ? 'Move the date' : 'Record payment'}
            </button>
          </>
        }
      >
        {target && (
          <form id="recurring-process-form" onSubmit={submitProcess} noValidate className="space-y-4">
            <div className="rounded-lg border border-line bg-surface-2/40 px-3.5 py-3 space-y-2 text-sm">
              <DetailRow label="Amount">
                <Money amount={target.amount} currency={target.currency || baseCurrency} className="font-medium" />
              </DetailRow>
              <DetailRow label="Due">{formatDate(target.next_payment_date)}</DetailRow>
              <DetailRow label="Cycle">{cycleOf(target)}{targetRenews ? '' : ', does not renew'}</DetailRow>
              {target.last_processed_date && (
                <DetailRow label="Last processed">{formatDate(target.last_processed_date)}</DetailRow>
              )}
            </div>

            <p className="text-sm text-ink-2 leading-relaxed">
              {moveOnly ? (
                <>Nothing is added to {targetBook}.{' '}</>
              ) : (
                <>
                  This adds{' '}
                  <Money amount={target.amount} currency={target.currency || baseCurrency} className="text-ink" />
                  {' '}to {targetBook}
                  {targetRenews ? ' and ' : '. '}
                </>
              )}
              {targetRenews
                ? `${moveOnly ? 'The next date moves' : 'moves the next date'} forward one cycle (${targetCycle}).`
                : 'This item does not renew, so it is then marked as Cancelled.'}
            </p>

            <Field label="Payment date" required={!moveOnly} error={paidDateError} hint={moveOnly ? 'Not used when only the date moves' : undefined}>
              <input
                className="input" type="date" min="2000-01-01" max="2100-12-31" value={paidDate} disabled={moveOnly}
                onChange={(e) => { setPaidDate(e.target.value); setPaidDateError(null) }}
              />
            </Field>

            <label className="flex items-start gap-2.5">
              <input
                type="checkbox" className="checkbox mt-0.5 shrink-0" checked={moveOnly}
                onChange={(e) => { setMoveOnly(e.target.checked); setPaidDateError(null) }}
              />
              <span className="text-sm text-ink">
                Only move the date (do not record)
                <span className="help block">
                  For a payment that was skipped, or one that is already in {targetBook}.
                </span>
              </span>
            </label>

            {alreadyRecorded && !moveOnly && (
              <p role="alert" className="text-sm text-warn bg-warn/10 border border-warn/20 rounded-lg px-3 py-2">
                This payment is already in {targetBook}. To move on to the next date without recording it again,
                tick "Only move the date".
              </p>
            )}
          </form>
        )}
      </Modal>
    </div>
  )
}
