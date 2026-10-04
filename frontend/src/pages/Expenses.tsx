import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Download, Lock, Paperclip, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react'
import { expenseApi } from '../services/api'
import type { Expense } from '../services/api'
import {
  EmptyState, ErrorState, Field, Modal, Money, PageHeader, SearchInput, Spinner, TableSkeleton, Toolbar, useConfirm,
} from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import { errorMessage, formatDate, formatNumber, SUPPORTED_CURRENCIES, symbolFor, todayISO } from '../lib/format'
import { exportCsv } from '../lib/files'

// Suggestions for the category field. "Salaries" is left out on purpose:
// payroll writes those rows itself when salaries are paid.
const DEFAULT_CATEGORIES = [
  'Software', 'Marketing', 'Office', 'Rent', 'Utilities', 'Travel', 'Professional fees', 'Bank charges', 'Taxes', 'Other',
]
const PAYROLL_CATEGORY = 'salaries'
const PAYMENT_METHODS = ['Bank Transfer', 'Cash', 'Credit Card', 'Online', 'Other']
const BILLING_CYCLES = ['Weekly', 'Monthly', 'Quarterly', 'Semi-Annual', 'Annual']

// The same limits the server enforces, checked here so the answer is immediate.
const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const RECEIPT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp'
const MAX_RECEIPT_MB = 5

const PAYROLL_HINT = 'Managed from the Payroll page'
const RECURRING_HINT = 'Recorded from the Recurring page'

const isPayrollRow = (e: Expense) => typeof e.source === 'string' && e.source.startsWith('payroll:')
const isRecurringRow = (e: Expense) => typeof e.source === 'string' && e.source.startsWith('recurring:')

/** Receipts are files on this server; anything that is not a local path is not linked. */
const receiptHref = (path: string | null | undefined) => (path && /^\/(?!\/)/.test(path) ? path : null)

interface CurrencyTotal {
  currency: string
  total: number
}

/** One subtotal per currency, base currency first. Amounts in different currencies are never added together. */
function totalsByCurrency(rows: Expense[], base: string): CurrencyTotal[] {
  const sums = new Map<string, number>()
  for (const r of rows) {
    const currency = (r.currency || base).toUpperCase()
    sums.set(currency, (sums.get(currency) || 0) + (Number(r.amount) || 0))
  }
  return Array.from(sums, ([currency, total]) => ({ currency, total })).sort((a, b) =>
    a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency))
}

function receiptProblem(file: File): string | null {
  if (!RECEIPT_TYPES.includes(file.type.toLowerCase())) return 'The receipt must be a PDF, JPEG, PNG or WebP file'
  if (file.size > MAX_RECEIPT_MB * 1024 * 1024) {
    const size = Math.ceil((file.size / (1024 * 1024)) * 10) / 10
    return `This file is ${size.toFixed(1)} MB. A receipt can be up to ${MAX_RECEIPT_MB} MB.`
  }
  return null
}

interface FormState {
  title: string
  category: string
  vendor: string
  amount: string
  currency: string
  payment_date: string
  payment_method: string
  is_recurring: boolean
  billing_cycle: string
  notes: string
}

type FormErrors = Partial<Record<'title' | 'category' | 'amount' | 'payment_date' | 'receipt', string>>

const emptyForm = (currency: string): FormState => ({
  title: '', category: '', vendor: '', amount: '', currency, payment_date: todayISO(),
  payment_method: '', is_recurring: false, billing_cycle: 'Monthly', notes: '',
})

const formFrom = (e: Expense, fallbackCurrency: string): FormState => ({
  title: e.title || '',
  category: e.category || '',
  vendor: e.vendor || '',
  amount: e.amount === null || e.amount === undefined ? '' : String(e.amount),
  currency: e.currency || fallbackCurrency,
  // A date input only takes YYYY-MM-DD; older rows may carry a full timestamp.
  payment_date: e.payment_date ? e.payment_date.slice(0, 10) : '',
  payment_method: e.payment_method || '',
  is_recurring: !!e.is_recurring,
  billing_cycle: e.billing_cycle && BILLING_CYCLES.includes(e.billing_cycle) ? e.billing_cycle : 'Monthly',
  notes: e.notes || '',
})

function validate(f: FormState): FormErrors {
  const problems: FormErrors = {}
  if (!f.title.trim()) problems.title = 'Enter a title'
  if (!f.category.trim()) problems.category = 'Choose or type a category'

  const amount = Number(f.amount)
  if (f.amount.trim() === '') problems.amount = 'Enter the amount'
  else if (!Number.isFinite(amount) || Math.round(amount * 100) <= 0) problems.amount = 'Amount must be greater than 0'
  else if (amount > 1e12) problems.amount = 'Amount is too large'

  if (!f.payment_date) problems.payment_date = 'Choose the payment date'
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(f.payment_date) || f.payment_date < '2000-01-01' || f.payment_date > '2100-12-31') {
    problems.payment_date = 'The date must be between 2000 and 2100'
  }
  return problems
}

/**
 * The multipart body, field by field. Blank optional fields are left out,
 * which the server stores as empty; booleans travel as '1' / '0'.
 */
function buildFormData(f: FormState, receipt: File | null, removeReceipt: boolean) {
  const fd = new FormData()
  const put = (key: string, value: string | null | undefined) => {
    if (value !== undefined && value !== null && value !== '') fd.append(key, value)
  }
  put('title', f.title.trim())
  put('category', f.category.trim())
  put('vendor', f.vendor.trim())
  put('amount', String(Number(f.amount)))
  put('currency', f.currency)
  put('payment_date', f.payment_date)
  put('payment_method', f.payment_method)
  put('is_recurring', f.is_recurring ? '1' : '0')
  if (f.is_recurring) put('billing_cycle', f.billing_cycle)
  put('notes', f.notes.trim())
  if (receipt) fd.append('receipt', receipt)
  else if (removeReceipt) fd.append('remove_receipt', '1')
  return fd
}

export default function Expenses() {
  const { baseCurrency } = useSettings()
  const confirm = useConfirm()

  // null = nothing loaded yet (first load, or the last load failed)
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [categories, setCategories] = useState<string[]>([])

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [form, setForm] = useState<FormState>(() => emptyForm(baseCurrency))
  const [errors, setErrors] = useState<FormErrors>({})
  const [receipt, setReceipt] = useState<File | null>(null)
  const [removeReceipt, setRemoveReceipt] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  // Only the newest request may update the list; slower, older answers are dropped.
  const latestRequest = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim().slice(0, 100)), 300)
    return () => clearTimeout(timer)
  }, [search])

  const load = useCallback(async () => {
    const ticket = ++latestRequest.current
    setRefreshing(true)
    setError(null)
    try {
      const data = await expenseApi.list({
        category: category || undefined,
        search: query || undefined,
        from: from || undefined,
        to: to || undefined,
      })
      if (ticket !== latestRequest.current) return
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      if (ticket !== latestRequest.current) return
      setRows(null)
      setError(errorMessage(err, 'Could not load expenses'))
    } finally {
      if (ticket === latestRequest.current) setRefreshing(false)
    }
  }, [category, query, from, to])

  const loadCategories = useCallback(async () => {
    try {
      const list = await expenseApi.categories()
      setCategories(Array.isArray(list) ? list : [])
    } catch (err) {
      toast.error(errorMessage(err, 'Could not load the category list'), { id: 'expense-categories' })
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => () => { latestRequest.current += 1 }, [])

  const totals = useMemo(() => totalsByCurrency(rows || [], baseCurrency), [rows, baseCurrency])

  // The filter lists what is in the books; keep the current choice visible even if its last row was just removed.
  const filterCategories = useMemo(
    () => (category && !categories.includes(category) ? [...categories, category] : categories),
    [categories, category],
  )

  const categorySuggestions = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const name of [...categories, ...DEFAULT_CATEGORIES]) {
      const key = name.trim().toLowerCase()
      if (!key || key === PAYROLL_CATEGORY || seen.has(key)) continue
      seen.add(key)
      list.push(name.trim())
    }
    return list
  }, [categories])

  const filtersActive = !!(search || category || from || to)
  const rangeInvalid = !!from && !!to && from > to

  function clearFilters() {
    setSearch('')
    setQuery('')
    setCategory('')
    setFrom('')
    setTo('')
  }

  function exportRows() {
    if (!rows || rows.length === 0) return
    exportCsv<Expense>(`expenses-${todayISO()}.csv`, [
      { header: 'Date', value: (r) => r.payment_date },
      { header: 'Title', value: (r) => r.title },
      { header: 'Vendor', value: (r) => r.vendor },
      { header: 'Category', value: (r) => r.category },
      { header: 'Payment method', value: (r) => r.payment_method },
      { header: 'Amount', value: (r) => r.amount },
      { header: 'Currency', value: (r) => r.currency || baseCurrency },
      { header: 'Repeats', value: (r) => (r.is_recurring ? r.billing_cycle || 'Yes' : 'No') },
      { header: 'Recorded by', value: (r) => (isPayrollRow(r) ? 'Payroll' : isRecurringRow(r) ? 'Recurring' : 'Manual entry') },
      { header: 'Receipt attached', value: (r) => (r.receipt_path ? 'Yes' : 'No') },
      { header: 'Notes', value: (r) => r.notes },
    ], rows)
    toast.success(`Exported ${rows.length} ${rows.length === 1 ? 'expense' : 'expenses'}`)
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  function openNew() {
    setEditing(null)
    setForm(emptyForm(baseCurrency))
    setErrors({})
    setReceipt(null)
    setRemoveReceipt(false)
    setModalOpen(true)
  }

  function openEdit(row: Expense) {
    setEditing(row)
    setForm(formFrom(row, baseCurrency))
    setErrors({})
    setReceipt(null)
    setRemoveReceipt(false)
    setModalOpen(true)
  }

  function closeModal() {
    if (!saving) setModalOpen(false)
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((prev) => (key in prev ? { ...prev, [key]: undefined } : prev))
  }

  function pickReceipt(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null
    if (!file) {
      setReceipt(null)
      setErrors((prev) => ({ ...prev, receipt: undefined }))
      return
    }
    const problem = receiptProblem(file)
    if (problem) {
      // Drop the rejected file so it cannot be submitted by mistake.
      e.target.value = ''
      setReceipt(null)
      setErrors((prev) => ({ ...prev, receipt: problem }))
      return
    }
    setReceipt(file)
    setRemoveReceipt(false)
    setErrors((prev) => ({ ...prev, receipt: undefined }))
  }

  function clearPickedReceipt() {
    if (fileInput.current) fileInput.current.value = ''
    setReceipt(null)
    setErrors((prev) => ({ ...prev, receipt: undefined }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    const problems = validate(form)
    if (Object.values(problems).some(Boolean)) {
      setErrors(problems)
      return
    }

    const body = buildFormData(form, receipt, !!editing && removeReceipt)
    setSaving(true)
    try {
      if (editing) await expenseApi.update(editing.id, body)
      else await expenseApi.create(body)
      toast.success(editing ? 'Expense updated' : 'Expense added')
      setModalOpen(false)
      load()
      loadCategories()
    } catch (err) {
      // The request ran out of time before the server answered. With a receipt attached that is the upload.
      if ((err as { code?: string } | null)?.code === 'ECONNABORTED') {
        toast.error(receipt
          ? 'The upload took too long. Try a smaller file or a faster connection.'
          : 'The server took too long to answer. Check your connection and try again.')
      } else {
        toast.error(errorMessage(err, editing ? 'Could not update the expense' : 'Could not add the expense'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: Expense) {
    const ok = await confirm({
      title: 'Delete this expense?',
      message: (
        <>
          <span className="text-ink font-medium">{row.title}</span> will be removed from the books
          {row.receipt_path ? ', together with its receipt' : ''}. This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete expense',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(row.id)
    try {
      await expenseApi.delete(row.id)
      toast.success('Expense deleted')
      await load()
      loadCategories()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the expense'))
    } finally {
      setBusyId(null)
    }
  }

  const currentReceipt = editing ? receiptHref(editing.receipt_path) : null
  const hasStoredReceipt = !!editing?.receipt_path
  // A row saved in a currency that is no longer offered still shows what it has.
  const supported: readonly string[] = SUPPORTED_CURRENCIES
  const currencyOptions = supported.includes(form.currency) ? supported : [...supported, form.currency]
  const methodOptions = !form.payment_method || PAYMENT_METHODS.includes(form.payment_method)
    ? PAYMENT_METHODS
    : [...PAYMENT_METHODS, form.payment_method]
  const typedPayrollCategory = form.category.trim().toLowerCase() === PAYROLL_CATEGORY

  let receiptHint = `PDF, JPEG, PNG or WebP, up to ${MAX_RECEIPT_MB} MB.`
  if (receipt && hasStoredReceipt) receiptHint = 'The new file replaces the current receipt when you save.'
  else if (removeReceipt && hasStoredReceipt) receiptHint = 'The current receipt is deleted when you save.'

  return (
    <div className="page">
      <PageHeader
        title="Expenses"
        description="Bills, subscriptions and other costs, each kept in the currency it was paid in"
        actions={
          <button type="button" className="btn-primary" onClick={openNew}>
            <Plus size={16} /> Add expense
          </button>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search title or vendor" className="w-full sm:w-64" />
        <select
          className="input w-full sm:w-48"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {filterCategories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          From
          <input
            type="date" className="input w-[150px]" value={from} max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-3">
          To
          <input
            type="date" className="input w-[150px]" value={to} min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {filtersActive && (
          <button type="button" className="btn-ghost btn-sm" onClick={clearFilters}>
            <X size={13} /> Clear filters
          </button>
        )}
        <button
          type="button" className="btn-secondary sm:ml-auto" onClick={exportRows}
          disabled={!rows || rows.length === 0}
        >
          <Download size={15} /> Export CSV
        </button>
      </Toolbar>

      {error ? (
        <div className="card">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : (
        <>
          {/* Totals for the rows on screen, one figure per currency. */}
          <div className="card px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-2 min-h-[46px]">
            {rows === null ? (
              <div className="skeleton h-4 w-56" />
            ) : (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="eyebrow">Entries</span>
                  <span className="num text-sm font-medium text-ink">{formatNumber(rows.length)}</span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="eyebrow">{category ? `${category} total` : 'Total'}</span>
                  {totals.length === 0 ? (
                    <span className="text-sm text-ink-3">—</span>
                  ) : totals.map((t, i) => (
                    <Fragment key={t.currency}>
                      {i > 0 && <span className="text-ink-3" aria-hidden="true">·</span>}
                      <Money amount={t.total} currency={t.currency} className="text-sm font-medium text-ink" />
                    </Fragment>
                  ))}
                </div>
                {totals.length > 1 && (
                  <span className="text-xs text-ink-3">One total per currency, not converted</span>
                )}
              </>
            )}
          </div>

          <div
            className={`table-wrap transition-opacity duration-150 ${rows && refreshing ? 'opacity-60' : ''}`}
            aria-busy={refreshing}
          >
            {rows === null ? (
              <TableSkeleton rows={8} cols={6} />
            ) : rows.length === 0 ? (
              filtersActive ? (
                <EmptyState
                  icon={Receipt}
                  title={rangeInvalid ? 'Check the date range' : 'No expenses match these filters'}
                  description={rangeInvalid
                    ? 'The From date is after the To date.'
                    : 'Try a different search, category or date range.'}
                  action={<button type="button" className="btn-secondary" onClick={clearFilters}>Clear filters</button>}
                />
              ) : (
                <EmptyState
                  icon={Receipt}
                  title="No expenses yet"
                  description="Add the first one to start tracking what the business spends. Payroll and recurring payments show up here on their own once they are recorded."
                  action={
                    <button type="button" className="btn-primary" onClick={openNew}>
                      <Plus size={16} /> Add expense
                    </button>
                  }
                />
              )
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="th">Date</th>
                      <th className="th">Title</th>
                      <th className="th">Category</th>
                      <th className="th">Method</th>
                      <th className="th-num">Amount</th>
                      <th className="th text-center">Receipt</th>
                      <th className="th text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const payroll = isPayrollRow(row)
                      const fromRecurring = isRecurringRow(row)
                      const href = receiptHref(row.receipt_path)
                      const busy = busyId === row.id
                      // Payroll rows all carry the vendor "Payroll", which the badge already says.
                      const details = [
                        payroll ? null : row.vendor,
                        row.is_recurring ? row.billing_cycle || 'Repeats' : null,
                      ].filter(Boolean).join(' · ')

                      return (
                        <tr key={row.id} className="tr" title={payroll ? PAYROLL_HINT : undefined}>
                          <td className="td whitespace-nowrap">{formatDate(row.payment_date)}</td>
                          <td className="td">
                            <div className="flex items-center gap-2">
                              <span className="td-strong truncate max-w-[260px]" title={row.title}>{row.title}</span>
                              {payroll && (
                                <Link to="/payroll" className="badge-accent hover:bg-accent/20" title={PAYROLL_HINT}>
                                  Payroll
                                </Link>
                              )}
                              {fromRecurring && (
                                <span className="badge-neutral" title={RECURRING_HINT}>Recurring</span>
                              )}
                            </div>
                            {details && (
                              <p className="text-xs text-ink-3 mt-0.5 truncate max-w-[320px]" title={details}>{details}</p>
                            )}
                          </td>
                          <td className="td">
                            <span className="badge-neutral max-w-[180px]" title={row.category}>
                              <span className="truncate">{row.category || '—'}</span>
                            </span>
                          </td>
                          <td className="td whitespace-nowrap">
                            {row.payment_method || <span className="text-ink-3">—</span>}
                          </td>
                          <td className="td-num">
                            <Money amount={row.amount} currency={row.currency || baseCurrency} />
                          </td>
                          <td className="td text-center">
                            {href ? (
                              <a
                                href={href} target="_blank" rel="noopener noreferrer" className="btn-icon"
                                title="Open receipt" aria-label={`Open the receipt for ${row.title}`}
                              >
                                <Paperclip size={14} />
                              </a>
                            ) : (
                              <span className="text-ink-3" title="No receipt">—</span>
                            )}
                          </td>
                          <td className="td">
                            <div className="flex items-center justify-end gap-1">
                              {payroll ? (
                                <span
                                  role="img" aria-label={PAYROLL_HINT} title={PAYROLL_HINT}
                                  className="inline-flex items-center justify-center w-8 h-8 text-ink-3"
                                >
                                  <Lock size={14} />
                                </span>
                              ) : (
                                <>
                                  <button
                                    type="button" className="btn-icon" onClick={() => openEdit(row)} disabled={busy}
                                    title="Edit" aria-label={`Edit ${row.title}`}
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    type="button" className="btn-icon-danger" onClick={() => remove(row)} disabled={busy}
                                    title="Delete" aria-label={`Delete ${row.title}`}
                                  >
                                    {busy ? <Spinner size={14} /> : <Trash2 size={14} />}
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
          </div>
        </>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit expense' : 'Add expense'}
        subtitle={editing && isRecurringRow(editing) ? 'This entry was recorded from the Recurring page.' : undefined}
        busy={saving}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
            <button type="submit" form="expense-form" className="btn-primary" disabled={saving}>
              {saving ? <><Spinner /> Saving</> : editing ? 'Save changes' : 'Add expense'}
            </button>
          </>
        }
      >
        <form id="expense-form" onSubmit={submit} noValidate className="form-grid">
          <Field label="Title" required error={errors.title} className="form-full">
            <input
              className="input" value={form.title} maxLength={200} placeholder="What was paid for"
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>

          <Field
            label="Category" required error={errors.category}
            hint={typedPayrollCategory
              ? 'Salaries are added automatically when payroll is paid. Use this only for a salary cost paid outside payroll.'
              : 'Pick one from the list or type a new one'}
          >
            <input
              className="input" list="expense-category-options" value={form.category} maxLength={100}
              autoComplete="off" onChange={(e) => set('category', e.target.value)}
            />
            <datalist id="expense-category-options">
              {categorySuggestions.map((c) => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Vendor" hint="Who was paid">
            <input className="input" value={form.vendor} maxLength={200} onChange={(e) => set('vendor', e.target.value)} />
          </Field>

          <Field label="Amount" required error={errors.amount}>
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

          <Field label="Payment date" required error={errors.payment_date}>
            <input
              className="input" type="date" min="2000-01-01" max="2100-12-31"
              value={form.payment_date} onChange={(e) => set('payment_date', e.target.value)}
            />
          </Field>
          <Field label="Payment method">
            <select className="input" value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
              <option value="">Not specified</option>
              {methodOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>

          <div className="form-full rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 min-h-[32px]">
              <label className="flex items-center gap-2.5 text-sm text-ink">
                <input
                  type="checkbox" className="checkbox" checked={form.is_recurring}
                  onChange={(e) => set('is_recurring', e.target.checked)}
                />
                This expense repeats
              </label>
              {form.is_recurring && (
                <label className="flex items-center gap-2 text-xs text-ink-3">
                  Billing cycle
                  <select
                    className="input h-8 w-40" value={form.billing_cycle}
                    onChange={(e) => set('billing_cycle', e.target.value)}
                  >
                    {BILLING_CYCLES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              )}
            </div>
            <p className="help">
              This only labels the entry. To be reminded and to record it every cycle, add it on the Recurring page.
            </p>
          </div>

          <Field label="Notes" className="form-full">
            <textarea
              className="input resize-y" rows={2} value={form.notes} maxLength={2000}
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>

          <div className="form-full">
            <label className="label" htmlFor="expense-receipt">Receipt</label>
            {hasStoredReceipt && (
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
                <span className="flex items-center gap-2 text-sm min-w-0">
                  <Paperclip size={14} className="text-ink-3 shrink-0" />
                  {currentReceipt ? (
                    <a
                      href={currentReceipt} target="_blank" rel="noopener noreferrer"
                      className={`link ${removeReceipt || receipt ? 'line-through opacity-60' : ''}`}
                    >
                      Current receipt
                    </a>
                  ) : (
                    <span className={`text-ink-2 ${removeReceipt || receipt ? 'line-through opacity-60' : ''}`}>Current receipt</span>
                  )}
                </span>
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input
                    type="checkbox" className="checkbox" checked={removeReceipt} disabled={!!receipt || saving}
                    onChange={(e) => setRemoveReceipt(e.target.checked)}
                  />
                  Remove
                </label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                id="expense-receipt" ref={fileInput} type="file" accept={RECEIPT_ACCEPT} onChange={pickReceipt}
                aria-invalid={!!errors.receipt} aria-describedby="expense-receipt-note"
                className="input px-1.5 py-[5px] text-xs text-ink-2 file:mr-3 file:h-6 file:px-2.5 file:rounded-md file:border-0
                  file:bg-surface-3 file:text-ink file:text-xs file:font-medium file:cursor-pointer"
              />
              {receipt && (
                <button
                  type="button" className="btn-icon shrink-0" onClick={clearPickedReceipt}
                  title="Clear the chosen file" aria-label="Clear the chosen file"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {errors.receipt ? (
              <p id="expense-receipt-note" className="field-error" role="alert">{errors.receipt}</p>
            ) : (
              <p id="expense-receipt-note" className="help">{receiptHint}</p>
            )}
          </div>
        </form>
      </Modal>
    </div>
  )
}
