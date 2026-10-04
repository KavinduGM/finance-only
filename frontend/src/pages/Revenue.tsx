import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  CheckCircle2, Clock, Download, Layers, Lock, Pencil, Plus, Repeat, Trash2, TrendingUp, Trophy, X,
} from 'lucide-react'
import { clientApi, revenueApi } from '../services/api'
import type { Client, RevenueEntry } from '../services/api'
import {
  BarList, ChartCard, EmptyState, ErrorState, Field, Modal, Money, PageHeader, SearchInput, Segmented,
  Spinner, StatCard, StatusBadge, TableSkeleton, Toolbar, useConfirm,
} from '../components/ui'
import type { BarListItem } from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import { exportCsv } from '../lib/files'
import {
  daysUntil, errorMessage, formatDate, formatMoney, formatNumber, symbolFor, todayISO, SUPPORTED_CURRENCIES,
} from '../lib/format'

type IncomeStats = Awaited<ReturnType<typeof revenueApi.stats>>
type StatusFilter = 'all' | 'Paid' | 'Pending' | 'Overdue'

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'Paid', label: 'Paid' },
  { id: 'Pending', label: 'Pending' },
]
// 'Overdue' only exists on entries carried over from the previous system, so its chip is offered only when there are any.
const OVERDUE_FILTER: { id: StatusFilter; label: string } = { id: 'Overdue', label: 'Overdue' }
const STATUSES = ['Paid', 'Pending']
// The years the server accepts. A year typed as "26" is saved as 0026 and drops out of every dated report.
const MIN_DATE = '2000-01-01'
const MAX_DATE = '2100-12-31'
const dateInRange = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= MIN_DATE && value <= MAX_DATE
const PAYMENT_METHODS = ['Bank Transfer', 'Cash', 'Cheque', 'Card', 'PayPal', 'Stripe', 'Crypto', 'Other']
const BILLING_CYCLES = ['Weekly', 'Monthly', 'Quarterly', 'Semi-Annual', 'Annual']
/** Bars a breakdown card shows before "Show all" is used, so the table stays within reach. */
const COLLAPSED_BARS = 5

interface IncomeForm {
  client_name: string
  service_type: string
  project_name: string
  invoice_number: string
  invoice_date: string
  due_date: string
  amount: string
  currency: string
  payment_status: string
  payment_method: string
  is_recurring: boolean
  billing_cycle: string
  notes: string
}

type FormErrors = Partial<Record<keyof IncomeForm, string>>

const emptyForm = (currency: string): IncomeForm => ({
  client_name: '', service_type: '', project_name: '', invoice_number: '',
  invoice_date: todayISO(), due_date: '', amount: '', currency,
  payment_status: 'Paid', payment_method: '', is_recurring: false, billing_cycle: 'Monthly', notes: '',
})

// Date inputs need exactly YYYY-MM-DD; older rows may carry a full timestamp.
const dateValue = (value: string | null) => (value ? value.slice(0, 10) : '')

const toForm = (r: RevenueEntry, fallbackCurrency: string): IncomeForm => {
  const recurring = !!r.is_recurring && !!r.billing_cycle && r.billing_cycle !== 'One-time'
  return {
    client_name: r.client_name || '',
    service_type: r.service_type || '',
    project_name: r.project_name || '',
    invoice_number: r.invoice_number || '',
    invoice_date: dateValue(r.invoice_date),
    due_date: dateValue(r.due_date),
    amount: r.amount === null || r.amount === undefined ? '' : String(r.amount),
    currency: r.currency || fallbackCurrency,
    payment_status: r.payment_status || 'Pending',
    payment_method: r.payment_method || '',
    is_recurring: recurring,
    billing_cycle: recurring ? r.billing_cycle! : 'Monthly',
    notes: r.notes || '',
  }
}

function validate(form: IncomeForm): FormErrors {
  const errors: FormErrors = {}
  if (!form.client_name.trim()) errors.client_name = 'Enter who the money is from'
  if (!form.invoice_date) errors.invoice_date = 'Choose a date'
  else if (!dateInRange(form.invoice_date)) errors.invoice_date = 'The date must be between 2000 and 2100'
  if (form.due_date && !dateInRange(form.due_date)) errors.due_date = 'The due date must be between 2000 and 2100'
  if (form.amount.trim() === '') errors.amount = 'Enter the amount'
  else if (!(Number(form.amount) > 0)) errors.amount = 'Amount must be greater than 0'
  return errors
}

/** Keeps a stored value selectable even when it is not one of the standard options. */
const withCurrent = (options: readonly string[], current: string) =>
  current && !options.includes(current) ? [...options, current] : [...options]

const entries = (n: number) => `${formatNumber(n)} ${n === 1 ? 'entry' : 'entries'}`

function periodLabel(from: string, to: string) {
  if (from && to) return `${formatDate(from)} – ${formatDate(to)}`
  if (from) return `Since ${formatDate(from)}`
  if (to) return `Up to ${formatDate(to)}`
  return 'All time'
}

/**
 * An automatic entry whose invoice is still in the system belongs to that
 * invoice: the server refuses to delete it, so the button is not offered. An
 * automatic entry carried over without its invoice can be deleted like any other.
 */
const ownedByInvoice = (r: RevenueEntry) => !!r.auto_recorded && r.invoice_id != null

const lockedReason = (r: RevenueEntry) =>
  r.invoice_number
    ? `Recorded from invoice ${r.invoice_number}. Mark that invoice as unpaid to remove this entry.`
    : 'Recorded from an invoice. Mark that invoice as unpaid to remove this entry.'

export default function Revenue() {
  const { baseCurrency, money, moneyCompact } = useSettings()
  const confirm = useConfirm()

  // Filters
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Entries
  const [rows, setRows] = useState<RevenueEntry[] | null>(null)
  // Whether the rows on screen were loaded with any filter (the controls may already say something newer).
  const [rowsFiltered, setRowsFiltered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  // Summary: the figures are kept together with the period they were loaded for.
  const [summary, setSummary] = useState<{ stats: IncomeStats; period: string } | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  // Saved clients, offered as suggestions in the form
  const [clients, setClients] = useState<Client[]>([])
  const [clientsLoaded, setClientsLoaded] = useState(false)
  const [clientsFailed, setClientsFailed] = useState(false)

  // Form
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RevenueEntry | null>(null)
  const [form, setForm] = useState<IncomeForm>(() => emptyForm(baseCurrency))
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const serviceInput = useRef<HTMLInputElement>(null)

  // Each request takes a ticket; a response is ignored once a newer one is out.
  const listTicket = useRef(0)
  const statsTicket = useRef(0)

  const isAuto = !!editing?.auto_recorded
  const rangeBackwards = !!from && !!to && from > to
  const filtersActive = !!search.trim() || status !== 'all' || !!from || !!to

  // Typing waits 300 ms before searching; clearing the box applies at once.
  useEffect(() => {
    const next = search.trim()
    if (!next) {
      setQuery('')
      return
    }
    const timer = setTimeout(() => setQuery(next), 300)
    return () => clearTimeout(timer)
  }, [search])

  const loadRows = useCallback(async () => {
    const ticket = ++listTicket.current
    setFetching(true)
    setError(null)
    try {
      const list = await revenueApi.list({
        status: status === 'all' ? undefined : status,
        search: query || undefined,
        from: from || undefined,
        to: to || undefined,
      })
      if (ticket !== listTicket.current) return
      setRows(list)
      setRowsFiltered(!!query || status !== 'all' || !!from || !!to)
    } catch (err) {
      if (ticket !== listTicket.current) return
      setRows(null)
      setError(errorMessage(err, 'Could not load income'))
    } finally {
      if (ticket === listTicket.current) setFetching(false)
    }
  }, [status, query, from, to])

  // The summary follows the date range only; search and status narrow the table.
  const loadStats = useCallback(async () => {
    const ticket = ++statsTicket.current
    setSummaryError(null)
    try {
      const stats = await revenueApi.stats({ from: from || undefined, to: to || undefined })
      if (ticket !== statsTicket.current) return
      setSummary({ stats, period: periodLabel(from, to) })
    } catch (err) {
      if (ticket !== statsTicket.current) return
      setSummary(null)
      setSummaryError(errorMessage(err, 'Could not load the income summary'))
    }
  }, [from, to])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await clientApi.list()
        if (cancelled) return
        setClients(list)
        setClientsLoaded(true)
      } catch {
        // Not worth a toast: the form says the suggestions are unavailable.
        if (!cancelled) setClientsFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // On an invoice entry the first field is locked, so start at the first editable one.
  useEffect(() => {
    if (formOpen && isAuto) serviceInput.current?.focus()
  }, [formOpen, isAuto])

  const clientOptions = useMemo(() => {
    const seen = new Set<string>()
    return clients.filter((c) => {
      const key = c.name.trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [clients])

  // Service types already in use, so the same service is spelled the same way each time.
  const serviceOptions = useMemo(() => {
    const names = new Map<string, string>()
    const add = (name?: string | null) => {
      const clean = String(name || '').trim()
      if (clean && !names.has(clean.toLowerCase())) names.set(clean.toLowerCase(), clean)
    }
    // "Other" in the summary stands for entries without a service type.
    summary?.stats.byService.forEach((s) => s.service_type !== 'Other' && add(s.service_type))
    rows?.forEach((r) => add(r.service_type))
    return [...names.values()].sort((a, b) => a.localeCompare(b))
  }, [summary, rows])

  // Subtotals of the rows on screen, one per currency: amounts in different
  // currencies are never added together here.
  const subtotals = useMemo(() => {
    const byCurrency = new Map<string, { currency: string; received: number; pending: number }>()
    for (const r of rows || []) {
      const currency = r.currency || baseCurrency
      const line = byCurrency.get(currency) || { currency, received: 0, pending: 0 }
      if (r.payment_status === 'Paid') line.received += Number(r.amount) || 0
      else line.pending += Number(r.amount) || 0
      byCurrency.set(currency, line)
    }
    return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  }, [rows, baseCurrency])

  function retryAll() {
    loadRows()
    loadStats()
  }

  function clearFilters() {
    setSearch('')
    setStatus('all')
    setFrom('')
    setTo('')
  }

  function openNew() {
    setEditing(null)
    setForm(emptyForm(baseCurrency))
    setErrors({})
    setFormOpen(true)
  }

  function openEdit(row: RevenueEntry) {
    setEditing(row)
    setForm(toForm(row, baseCurrency))
    setErrors({})
    setFormOpen(true)
  }

  function patch(changes: Partial<IncomeForm>) {
    setForm((f) => ({ ...f, ...changes }))
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(changes) as (keyof IncomeForm)[]) delete next[key]
      return next
    })
  }

  /**
   * Links the entry to a saved client when the typed name is one of them, and
   * uses that client's spelling so the same client is never counted twice.
   */
  function resolveClient(typed: string): Pick<RevenueEntry, 'client_id' | 'client_name'> {
    const name = typed.trim()
    const key = name.toLowerCase()
    const saved = clients.find((c) => c.name.trim().toLowerCase() === key)
    if (saved) return { client_id: saved.id, client_name: saved.name.trim() }
    // Name left as it was: keep the existing link, also when the saved clients did not load. A link to a
    // client that is no longer on the loaded list (deleted, or never carried over) is dropped instead of sent.
    if (editing?.client_id && editing.client_name.trim().toLowerCase() === key) {
      const linkedId = editing.client_id
      if (!clientsLoaded || clients.some((c) => c.id === linkedId)) return { client_id: linkedId, client_name: name }
    }
    return { client_id: null, client_name: name }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    if (!isAuto) {
      const problems = validate(form)
      setErrors(problems)
      if (Object.keys(problems).length > 0) return
    }

    const text = (value: string) => value.trim() || null
    const descriptive: Partial<RevenueEntry> = {
      project_name: text(form.project_name),
      service_type: text(form.service_type),
      payment_method: form.payment_method || null,
      notes: text(form.notes),
    }
    // An invoice entry only accepts the descriptive fields; the rest belongs to the invoice.
    const body: Partial<RevenueEntry> = isAuto
      ? descriptive
      : {
          ...descriptive,
          ...resolveClient(form.client_name),
          invoice_number: text(form.invoice_number),
          invoice_date: form.invoice_date,
          due_date: form.due_date || null,
          amount: Number(form.amount),
          currency: form.currency,
          payment_status: form.payment_status as RevenueEntry['payment_status'],
          is_recurring: form.is_recurring ? 1 : 0,
          billing_cycle: form.is_recurring ? form.billing_cycle : 'One-time',
        }

    setSaving(true)
    try {
      if (editing) {
        await revenueApi.update(editing.id, body)
        toast.success('Income entry updated')
      } else {
        await revenueApi.create(body)
        toast.success('Income added')
      }
      setFormOpen(false)
      loadRows()
      loadStats()
    } catch (err) {
      toast.error(errorMessage(err, editing ? 'Could not update the income entry' : 'Could not add the income'))
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: RevenueEntry) {
    const ok = await confirm({
      title: 'Delete this income entry?',
      message: (
        <>
          <span className="num text-ink">{formatMoney(row.amount, row.currency || baseCurrency)}</span> from{' '}
          <span className="text-ink">{row.client_name}</span>
          {row.invoice_date ? ` on ${formatDate(row.invoice_date)}` : ''} will be removed from your income and from
          every report. This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete entry',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(row.id)
    try {
      await revenueApi.delete(row.id)
      toast.success('Income entry deleted')
      setRows((list) => (list ? list.filter((r) => r.id !== row.id) : list))
      loadRows()
      loadStats()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the income entry'))
    } finally {
      setBusyId(null)
    }
  }

  function exportRows() {
    if (!rows?.length) return
    exportCsv<RevenueEntry>(`income-${todayISO()}.csv`, [
      { header: 'Date', value: (r) => dateValue(r.invoice_date) },
      { header: 'Client', value: (r) => r.client_name },
      { header: 'Service type', value: (r) => r.service_type },
      { header: 'Project', value: (r) => r.project_name },
      { header: 'Reference', value: (r) => r.invoice_number },
      { header: 'Amount', value: (r) => r.amount },
      { header: 'Currency', value: (r) => r.currency },
      { header: 'Status', value: (r) => r.payment_status },
      { header: 'Payment method', value: (r) => r.payment_method },
      { header: 'Due date', value: (r) => dateValue(r.due_date) },
      { header: 'Billing cycle', value: (r) => (r.is_recurring ? r.billing_cycle : 'One-time') },
      { header: 'Source', value: (r) => (r.auto_recorded ? 'Invoice' : 'Entered by hand') },
      { header: 'Notes', value: (r) => r.notes },
    ], rows)
  }

  // Summary figures (already converted to the base currency by the server)
  const stats = summary?.stats
  const statsCurrency = stats?.base_currency || baseCurrency
  const paid = stats?.byStatus.find((s) => s.payment_status === 'Paid')
  // Everything not received yet is pending, including entries carried over as 'Overdue'.
  const unpaid = (stats?.byStatus ?? []).filter((s) => s.payment_status !== 'Paid')
  const pendingTotal = unpaid.reduce((n, s) => n + s.total, 0)
  const pendingCount = unpaid.reduce((n, s) => n + s.count, 0)
  const overdueCount = unpaid.find((s) => s.payment_status === 'Overdue')?.count ?? 0
  const entryCount = stats ? stats.byStatus.reduce((n, s) => n + s.count, 0) : 0
  const countsHint = `${formatNumber(paid?.count ?? 0)} paid · ${formatNumber(pendingCount)} pending`
  // The chip stays while it is the chosen filter, so it can always be switched off again.
  const statusFilters = overdueCount > 0 || status === 'Overdue' ? [...STATUS_FILTERS, OVERDUE_FILTER] : STATUS_FILTERS
  const topClient = stats?.byClient[0]
  const period = summary?.period || periodLabel(from, to)
  const barMoney = (value: number) => money(value, statsCurrency)
  const noneReceived = period === 'All time' ? 'No income received yet' : 'No income received in this period'

  return (
    <div className="page">
      <PageHeader
        title="Income"
        description="Money received, plus anything still expected"
        actions={
          <button type="button" className="btn-primary" onClick={openNew}>
            <Plus size={15} /> Add income
          </button>
        }
      />

      {summaryError ? (
        // When the list failed as well, its error block below speaks for the whole page.
        !error && (
          <div className="card">
            <ErrorState message={summaryError} onRetry={loadStats} />
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Received" icon={CheckCircle2} tone="good" loading={!stats}
              value={moneyCompact(paid?.total ?? 0, statsCurrency)}
              hint={money(paid?.total ?? 0, statsCurrency)}
            />
            <StatCard
              label="Pending" icon={Clock} tone="info" loading={!stats}
              value={moneyCompact(pendingTotal, statsCurrency)}
              hint={money(pendingTotal, statsCurrency)}
            />
            <StatCard
              label="Entries" icon={Layers} tone="neutral" loading={!stats}
              value={formatNumber(entryCount)}
              hint={countsHint}
            />
            <StatCard
              label="Top client" icon={Trophy} tone="accent" loading={!stats}
              value={topClient ? <span title={topClient.client_name}>{topClient.client_name}</span> : '—'}
              hint={topClient ? money(topClient.total, statsCurrency) : noneReceived}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Top clients" subtitle={`Received, in ${statsCurrency} · ${period}`}>
              {stats ? (
                <Breakdown
                  items={stats.byClient.map((c) => ({ label: c.client_name, value: c.total, hint: entries(c.count) }))}
                  format={barMoney}
                  emptyLabel={noneReceived}
                />
              ) : (
                <BarSkeleton />
              )}
            </ChartCard>
            <ChartCard title="By service" subtitle={`Received, in ${statsCurrency} · ${period}`}>
              {stats ? (
                <Breakdown
                  items={stats.byService.map((s) => ({ label: s.service_type, value: s.total }))}
                  format={barMoney}
                  emptyLabel={noneReceived}
                />
              ) : (
                <BarSkeleton />
              )}
            </ChartCard>
          </div>
        </>
      )}

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search client, service or reference"
          className="w-full sm:w-72"
        />
        <Segmented<StatusFilter> options={statusFilters} value={status} onChange={setStatus} />
        <label className="flex items-center gap-2 text-xs text-ink-3">
          From
          <input
            type="date" className="input w-[9.5rem]" value={from} max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          To
          <input
            type="date" className="input w-[9.5rem]" value={to} min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {filtersActive && (
          <button type="button" className="btn-ghost btn-sm" onClick={clearFilters}>
            <X size={13} /> Clear filters
          </button>
        )}
        <div className="flex items-center gap-3 ml-auto">
          {fetching && rows && <Spinner className="text-ink-3" />}
          <button type="button" className="btn-secondary" onClick={exportRows} disabled={!rows?.length}>
            <Download size={15} /> Export CSV
          </button>
        </div>
        {rangeBackwards && (
          <p role="status" className="w-full text-xs text-warn">
            The From date is after the To date, so nothing can match. Swap them or clear one.
          </p>
        )}
      </Toolbar>

      <div className="table-wrap">
        {error ? (
          <ErrorState message={error} onRetry={summaryError ? retryAll : loadRows} />
        ) : rows === null ? (
          <TableSkeleton rows={7} cols={6} />
        ) : rows.length === 0 ? (
          rowsFiltered ? (
            <EmptyState
              icon={TrendingUp}
              title="No income matches these filters"
              description="Try a wider date range, another status or a different search."
              action={<button type="button" className="btn-secondary" onClick={clearFilters}>Clear filters</button>}
            />
          ) : (
            <EmptyState
              icon={TrendingUp}
              title="No income recorded yet"
              description="Invoices appear here on their own when you mark them as paid. Add anything else you received by hand."
              action={
                <button type="button" className="btn-primary" onClick={openNew}>
                  <Plus size={15} /> Add income
                </button>
              }
            />
          )
        ) : (
          <>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" className="th">Date</th>
                    <th scope="col" className="th">Client</th>
                    <th scope="col" className="th">Service / project</th>
                    <th scope="col" className="th">Reference</th>
                    <th scope="col" className="th-num">Amount</th>
                    <th scope="col" className="th">Status</th>
                    <th scope="col" className="th-num">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const busy = busyId === r.id
                    const auto = !!r.auto_recorded
                    const recurring = !!r.is_recurring && !!r.billing_cycle && r.billing_cycle !== 'One-time'
                    const awaited = r.payment_status !== 'Paid' && !!r.due_date
                    const late = awaited && (daysUntil(r.due_date) ?? 0) < 0
                    const primary = r.service_type || r.project_name
                    const secondary = r.service_type ? r.project_name : null
                    return (
                      <tr key={r.id} className="tr">
                        <td className="td whitespace-nowrap">
                          {formatDate(r.invoice_date)}
                          {awaited && (
                            <div className={`text-xs mt-0.5 ${late ? 'text-warn' : 'text-ink-3'}`}>
                              {late ? 'Was due' : 'Due'} {formatDate(r.due_date)}
                            </div>
                          )}
                        </td>
                        <td className="td td-strong">
                          <div className="max-w-[220px] truncate" title={r.client_name}>{r.client_name}</div>
                        </td>
                        <td className="td">
                          {primary ? (
                            <div className="max-w-[240px] truncate" title={primary}>{primary}</div>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                          {(secondary || recurring) && (
                            <div className="flex items-center gap-2 text-xs text-ink-3 mt-0.5">
                              {secondary && <span className="max-w-[200px] truncate" title={secondary}>{secondary}</span>}
                              {recurring && (
                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                  <Repeat size={11} /> {r.billing_cycle}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            {r.invoice_number ? (
                              <span className="num whitespace-nowrap">{r.invoice_number}</span>
                            ) : (
                              !auto && <span className="text-ink-3">—</span>
                            )}
                            {auto && <span className="badge-accent">From invoice</span>}
                          </div>
                        </td>
                        <td className="td-num">
                          <Money amount={r.amount} currency={r.currency || baseCurrency} />
                          {r.payment_method && (
                            <div className="font-sans text-xs text-ink-3 mt-0.5 whitespace-nowrap">{r.payment_method}</div>
                          )}
                        </td>
                        <td className="td"><StatusBadge status={r.payment_status} /></td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              type="button" className="btn-icon" onClick={() => openEdit(r)} disabled={busy}
                              title={auto ? 'Edit project, service type, payment method and notes' : 'Edit'}
                              aria-label={`Edit income from ${r.client_name}`}
                            >
                              <Pencil size={14} />
                            </button>
                            {ownedByInvoice(r) ? (
                              // A disabled button ignores the pointer, so the wrapper carries the tooltip.
                              <span className="inline-flex cursor-not-allowed" title={lockedReason(r)}>
                                <button type="button" className="btn-icon" disabled title={lockedReason(r)} aria-label={lockedReason(r)}>
                                  <Trash2 size={14} />
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button" className="btn-icon-danger" onClick={() => remove(r)} disabled={busy}
                                title="Delete" aria-label={`Delete income from ${r.client_name}`}
                              >
                                {busy ? <Spinner size={14} /> : <Trash2 size={14} />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 border-t border-line bg-surface-2/40 text-xs text-ink-3">
              <span>{entries(rows.length)} shown</span>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                {subtotals.map((s) => (
                  <span key={s.currency} className="inline-flex flex-wrap items-center gap-x-2">
                    <span className="eyebrow">{s.currency}</span>
                    {s.received > 0 && (
                      <span className="whitespace-nowrap">
                        Received <Money amount={s.received} currency={s.currency} className="text-ink" />
                      </span>
                    )}
                    {s.pending > 0 && (
                      <span className="whitespace-nowrap">
                        Pending <Money amount={s.pending} currency={s.currency} className="text-ink" />
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit income' : 'Add income'}
        subtitle={editing ? undefined : 'Paid invoices are recorded on their own. Use this for anything else.'}
        busy={saving}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="income-form" className="btn-primary" disabled={saving}>
              {saving && <Spinner size={14} />}
              {editing ? 'Save changes' : 'Add income'}
            </button>
          </>
        }
      >
        <form id="income-form" onSubmit={submit} noValidate className="space-y-5">
          {isAuto && (
            <div className="flex items-start gap-2.5 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2.5 text-sm text-ink-2">
              <Lock size={15} className="text-accent shrink-0 mt-0.5" />
              <p>
                This entry was recorded from{' '}
                {editing?.invoice_number
                  ? <>invoice <span className="num text-ink">{editing.invoice_number}</span></>
                  : 'a paid invoice'}
                . The client, dates, amount, currency and status follow the invoice, so only the service type, project,
                payment method and notes can be changed here.{' '}
                {editing && ownedByInvoice(editing) ? (
                  <>
                    To change the rest or remove the entry, mark the invoice as unpaid on
                    the <Link to="/invoices" className="link">Invoices</Link> page.
                  </>
                ) : (
                  'That invoice is no longer in the system, so if the entry is wrong, delete it and add it again by hand.'
                )}
              </p>
            </div>
          )}

          <div>
            <p className="eyebrow mb-3">Client and work</p>
            <div className="form-grid">
              <Field
                label="Client name" required error={errors.client_name}
                hint={!isAuto && clientsFailed ? 'Saved clients could not be loaded. Type the name instead.' : undefined}
              >
                <input
                  className="input" list="income-clients" value={form.client_name} maxLength={200} autoComplete="off"
                  disabled={isAuto} aria-invalid={!!errors.client_name}
                  onChange={(e) => patch({ client_name: e.target.value })}
                />
              </Field>
              <Field label="Service type">
                <input
                  ref={serviceInput}
                  className="input" list="income-services" value={form.service_type} maxLength={100} autoComplete="off"
                  placeholder="e.g. Web design"
                  onChange={(e) => patch({ service_type: e.target.value })}
                />
              </Field>
              <Field label="Project">
                <input
                  className="input" value={form.project_name} maxLength={200} autoComplete="off"
                  onChange={(e) => patch({ project_name: e.target.value })}
                />
              </Field>
              <Field label="Reference number" hint={isAuto ? undefined : 'An invoice, receipt or transfer number'}>
                <input
                  className="input num" value={form.invoice_number} maxLength={50} autoComplete="off"
                  disabled={isAuto}
                  onChange={(e) => patch({ invoice_number: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div>
            <p className="eyebrow mb-3">Amount and payment</p>
            <div className="form-grid">
              <Field label="Date" required error={errors.invoice_date}>
                <input
                  className="input" type="date" min={MIN_DATE} max={MAX_DATE} value={form.invoice_date}
                  disabled={isAuto} aria-invalid={!!errors.invoice_date}
                  onChange={(e) => patch({ invoice_date: e.target.value })}
                />
              </Field>
              <Field
                label="Due date" error={errors.due_date}
                hint={isAuto ? undefined : 'When a pending amount is expected'}
              >
                <input
                  className="input" type="date" min={MIN_DATE} max={MAX_DATE} value={form.due_date}
                  disabled={isAuto} aria-invalid={!!errors.due_date}
                  onChange={(e) => patch({ due_date: e.target.value })}
                />
              </Field>
              <Field label={`Amount (${form.currency})`} required error={errors.amount}>
                <input
                  className="input-num" type="number" min="0" step="any" inputMode="decimal" placeholder="0.00"
                  value={form.amount} disabled={isAuto} aria-invalid={!!errors.amount}
                  onChange={(e) => patch({ amount: e.target.value })}
                />
              </Field>
              <Field label="Currency">
                <select
                  className="input" value={form.currency} disabled={isAuto}
                  onChange={(e) => patch({ currency: e.target.value })}
                >
                  {withCurrent(SUPPORTED_CURRENCIES, form.currency).map((c) => (
                    <option key={c} value={c}>{c} · {symbolFor(c)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  className="input" value={form.payment_status} disabled={isAuto}
                  onChange={(e) => patch({ payment_status: e.target.value })}
                >
                  {withCurrent(STATUSES, form.payment_status).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Payment method">
                <select
                  className="input" value={form.payment_method}
                  onChange={(e) => patch({ payment_method: e.target.value })}
                >
                  <option value="">Not specified</option>
                  {withCurrent(PAYMENT_METHODS, form.payment_method).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <div>
            <p className="eyebrow mb-3">Recurring and notes</p>
            <div className="form-grid">
              <div>
                <label className="flex items-center gap-2.5 h-9 text-sm text-ink-2">
                  <input
                    type="checkbox" className="checkbox" checked={form.is_recurring} disabled={isAuto}
                    onChange={(e) => patch({ is_recurring: e.target.checked })}
                  />
                  This income repeats
                </label>
                {!isAuto && (
                  <p className="help">
                    A label for this entry only. To be reminded each cycle, add it under Recurring.
                  </p>
                )}
              </div>
              {form.is_recurring && (
                <Field label="Billing cycle">
                  <select
                    className="input" value={form.billing_cycle} disabled={isAuto}
                    onChange={(e) => patch({ billing_cycle: e.target.value })}
                  >
                    {withCurrent(BILLING_CYCLES, form.billing_cycle).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Notes" className="form-full">
                <textarea
                  className="input resize-y" rows={3} value={form.notes} maxLength={2000}
                  onChange={(e) => patch({ notes: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <datalist id="income-clients">
            {clientOptions.map((c) => (
              <option key={c.id} value={c.name}>{c.company || ''}</option>
            ))}
          </datalist>
          <datalist id="income-services">
            {serviceOptions.map((name) => <option key={name} value={name} />)}
          </datalist>
        </form>
      </Modal>
    </div>
  )
}

/** Ranked bars, largest first; a long list starts with the top few and opens on request. */
function Breakdown({ items, format, emptyLabel }: {
  items: BarListItem[]
  format: (value: number) => string
  emptyLabel: string
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, COLLAPSED_BARS)
  return (
    <>
      <BarList items={shown} format={format} color="income" emptyLabel={emptyLabel} />
      {items.length > COLLAPSED_BARS && (
        <button
          type="button" className="btn-ghost btn-sm -ml-2.5 mt-3"
          aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? `Show top ${COLLAPSED_BARS}` : `Show all ${formatNumber(items.length)}`}
        </button>
      )}
    </>
  )
}

/** Placeholder bars while the summary is loading. */
function BarSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {[72, 56, 38, 24].map((width) => (
        <div key={width}>
          <div className="skeleton h-4" style={{ width: `${width}%` }} />
          <div className="skeleton h-1.5 w-full mt-2" />
        </div>
      ))}
    </div>
  )
}
