import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  AlertTriangle, Ban, Banknote, CheckCircle2, Clock, Copy, Download, Eye, FileDown, FileText, Info,
  MoreHorizontal, Pencil, Plus, RotateCcw, Send, Trash2, Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clientApi, invoiceApi } from '../services/api'
import type { Client, DocumentClientFields, Invoice, InvoiceStatus, LineItem, Settings } from '../services/api'
import {
  ClientFields, EmptyState, ErrorState, Field, LineItemsEditor, Modal, Money, PageHeader, SearchInput,
  Segmented, Spinner, StatCard, StatusBadge, TableSkeleton, Toolbar,
  emptyClientFields, emptyItem, lineItemsProblem, useConfirm,
} from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import {
  SUPPORTED_CURRENCIES, addDaysISO, daysUntil, errorMessage, formatDate, formatDateTime, formatMoney,
  formatNumber, symbolFor, todayISO,
} from '../lib/format'
import { downloadUrl, exportCsv, openPdf } from '../lib/files'
import type { CsvColumn } from '../lib/files'

// ── Constants ────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | InvoiceStatus

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'Draft', label: 'Draft' },
  { id: 'Sent', label: 'Sent' },
  { id: 'Overdue', label: 'Overdue' },
  { id: 'Paid', label: 'Paid' },
  { id: 'Cancelled', label: 'Cancelled' },
]

const STAT_CARDS: {
  status: InvoiceStatus
  label: string
  icon: LucideIcon
  tone: 'neutral' | 'info' | 'bad' | 'good'
  none: string
}[] = [
  { status: 'Draft', label: 'Draft', icon: FileText, tone: 'neutral', none: 'None to send' },
  { status: 'Sent', label: 'Awaiting payment', icon: Clock, tone: 'info', none: 'Nothing owed' },
  { status: 'Overdue', label: 'Overdue', icon: AlertTriangle, tone: 'bad', none: 'None overdue' },
  { status: 'Paid', label: 'Paid', icon: CheckCircle2, tone: 'good', none: 'None yet' },
]

const PAYMENT_METHODS = ['Bank Transfer', 'Cash', 'Cheque', 'Card', 'Online', 'Other']

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NO_INVOICES: Invoice[] = []

const CSV_COLUMNS: CsvColumn<Invoice>[] = [
  { header: 'Invoice number', value: (r) => r.invoice_number },
  { header: 'Client', value: (r) => r.client_name },
  { header: 'Company', value: (r) => r.client_company },
  { header: 'Email', value: (r) => r.client_email },
  { header: 'Issue date', value: (r) => r.issue_date },
  { header: 'Due date', value: (r) => r.due_date },
  { header: 'Currency', value: (r) => r.currency },
  { header: 'Subtotal', value: (r) => r.subtotal },
  { header: 'Discount', value: (r) => r.discount },
  { header: 'Tax rate %', value: (r) => r.tax_rate },
  { header: 'Tax', value: (r) => r.tax_amount },
  { header: 'Total', value: (r) => r.total },
  { header: 'Status', value: (r) => r.status },
  { header: 'Paid date', value: (r) => r.paid_date },
]

// ── Form model ───────────────────────────────────────────────────────────────

interface InvoiceForm {
  client: DocumentClientFields
  issue_date: string
  due_date: string
  currency: string
  items: LineItem[]
  tax_rate: string
  discount: string
  notes: string
  terms: string
}

type FormErrors = Partial<Record<'client' | 'issue_date' | 'due_date' | 'items', string>>

/** 'keep' leaves the status of an invoice that has already left Draft as it is. */
type SaveTarget = 'Draft' | 'Sent' | 'keep'

type RowAction = 'send' | 'unpaid' | 'duplicate' | 'cancel' | 'reopen' | 'delete'

function dueDaysFrom(settings: Settings | null) {
  const days = settings?.invoice_due_days
  return typeof days === 'number' && Number.isInteger(days) && days >= 0 ? days : 30
}

function blankForm(settings: Settings | null, baseCurrency: string): InvoiceForm {
  const today = todayISO()
  const taxRate = Number(settings?.default_tax_rate) || 0
  return {
    client: emptyClientFields(),
    issue_date: today,
    due_date: addDaysISO(today, dueDaysFrom(settings)),
    currency: baseCurrency,
    items: [emptyItem()],
    tax_rate: taxRate > 0 ? String(taxRate) : '',
    discount: '',
    notes: settings?.invoice_notes || '',
    terms: settings?.invoice_terms || '',
  }
}

// Date inputs only accept YYYY-MM-DD; rows carried over from the old system may hold a full timestamp.
const dateInputValue = (value?: string | null) => String(value || '').slice(0, 10)

function formFromInvoice(inv: Invoice, baseCurrency: string): InvoiceForm {
  const items = (inv.items || []).map((it) => ({
    description: it.description || '',
    quantity: it.quantity,
    unit_price: it.unit_price,
  }))
  return {
    client: {
      client_id: inv.client_id ?? null,
      client_name: inv.client_name || '',
      client_email: inv.client_email || '',
      client_company: inv.client_company || '',
      client_address: inv.client_address || '',
    },
    issue_date: dateInputValue(inv.issue_date),
    due_date: dateInputValue(inv.due_date),
    currency: inv.currency || baseCurrency,
    items: items.length ? items : [emptyItem()],
    tax_rate: inv.tax_rate ? String(inv.tax_rate) : '',
    discount: inv.discount ? String(inv.discount) : '',
    notes: inv.notes || '',
    terms: inv.terms || '',
  }
}

const textOrNull = (value?: string | null) => (value || '').trim() || null

function toBody(form: InvoiceForm) {
  return {
    client_id: form.client.client_id,
    client_name: form.client.client_name.trim(),
    client_email: textOrNull(form.client.client_email),
    client_company: textOrNull(form.client.client_company),
    client_address: textOrNull(form.client.client_address),
    issue_date: form.issue_date,
    due_date: form.due_date,
    currency: form.currency,
    items: form.items.map((it) => ({
      description: String(it.description || '').trim(),
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price),
    })),
    tax_rate: Number(form.tax_rate) || 0,
    discount: Number(form.discount) || 0,
    notes: textOrNull(form.notes),
    terms: textOrNull(form.terms),
  }
}

/** The invoice exactly as stored, for updates that only change its status. */
const storedBody = (inv: Invoice, baseCurrency: string) =>
  toBody({ ...formFromInvoice(inv, baseCurrency), items: inv.items || [] })

function validate(form: InvoiceForm): FormErrors {
  const errors: FormErrors = {}
  const email = (form.client.client_email || '').trim()
  if (!form.client.client_name.trim()) errors.client = 'Enter the client name'
  else if (email && !EMAIL_RE.test(email)) errors.client = 'The client email is not a valid email address'

  if (!form.issue_date) errors.issue_date = 'Choose the issue date'
  if (!form.due_date) errors.due_date = 'Choose the due date'
  else if (form.issue_date && form.due_date < form.issue_date) errors.due_date = 'The due date cannot be before the issue date'

  const taxRate = Number(form.tax_rate) || 0
  const lines = lineItemsProblem(form.items, form.discount)
  if (lines) errors.items = lines
  else if (Number(form.discount) < 0) errors.items = 'Discount cannot be negative'
  else if (taxRate < 0 || taxRate > 100) errors.items = 'Tax must be between 0 and 100 percent'
  return errors
}

const firstProblem = (errors: FormErrors) =>
  errors.client || errors.issue_date || errors.due_date || errors.items || null

// ── List helpers ─────────────────────────────────────────────────────────────

/** ?status=overdue and ?status=Overdue both select the Overdue filter. */
function readStatusParam(value: string | null): StatusFilter {
  const wanted = String(value || '').toLowerCase()
  return STATUS_FILTERS.find((s) => s.id.toLowerCase() === wanted)?.id || 'all'
}

/** One total per currency. Amounts in different currencies are never added together. */
function totalsByCurrency(rows: Invoice[], fallbackCurrency: string): [string, number][] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const currency = row.currency || fallbackCurrency
    totals.set(currency, (totals.get(currency) || 0) + (Number(row.total) || 0))
  }
  return Array.from(totals).sort((a, b) => a[0].localeCompare(b[0]))
}

function statHint(rows: Invoice[], fallbackCurrency: string, none: string): React.ReactNode {
  if (rows.length === 0) return none
  const totals = totalsByCurrency(rows, fallbackCurrency)
  if (totals.length === 1) return <Money amount={totals[0][1]} currency={totals[0][0]} />
  return (
    <span title={totals.map(([currency, sum]) => `${currency} ${formatMoney(sum, currency)}`).join(' · ')}>
      in {totals.length} currencies
    </span>
  )
}

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`

/** The line under the due date: how late an unpaid invoice is, or how soon it falls due. */
function dueNote(inv: Invoice): { text: string; tone: string } | null {
  if (inv.status !== 'Overdue' && inv.status !== 'Sent') return null
  const days = daysUntil(inv.due_date)
  if (days === null) return null
  if (days < 0) return { text: `${plural(-days, 'day')} overdue`, tone: 'text-bad' }
  if (inv.status !== 'Sent' || days > 3) return null
  return {
    text: days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`,
    tone: 'text-warn',
  }
}

/** The line under the status badge: when it was paid, or whether the client was emailed. */
function statusNote(inv: Invoice): { text: string; title?: string } | null {
  if (inv.status === 'Paid') return inv.paid_date ? { text: `on ${formatDate(inv.paid_date)}` } : null
  if (inv.status !== 'Sent' && inv.status !== 'Overdue') return null
  if (!inv.email_sent) return { text: 'Not emailed', title: 'Marked as sent, but not emailed to the client' }
  if (!inv.email_sent_at) return { text: 'Emailed' }
  return {
    text: `Emailed ${formatDate(inv.email_sent_at, 'dd MMM')}`,
    title: `Emailed to the client on ${formatDateTime(inv.email_sent_at)}`,
  }
}

function RowButton({ label, number, icon: Icon, onClick, disabled, spinning }: {
  label: string
  number: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
  spinning?: boolean
}) {
  return (
    <button
      type="button"
      className="btn-icon"
      title={label}
      aria-label={`${label}: invoice ${number}`}
      onClick={onClick}
      disabled={disabled}
    >
      {spinning ? <Spinner size={14} /> : <Icon size={15} />}
    </button>
  )
}

interface MenuItem {
  label: string
  icon: LucideIcon
  onSelect: () => void
  danger?: boolean
}

/**
 * The less frequent row actions, behind one button and spelled out in words.
 * Keeping all of them as icons made the table too wide for a laptop screen.
 * The menu is rendered on <body> so the table's scroll container cannot clip it.
 */
function RowMenu({ number, items, disabled, spinning }: {
  number: string
  items: MenuItem[]
  disabled?: boolean
  spinning?: boolean
}) {
  const [place, setPlace] = useState<{ top?: number; bottom?: number; right: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const open = place !== null

  function toggle() {
    if (open || !trigger.current) {
      setPlace(null)
      return
    }
    const box = trigger.current.getBoundingClientRect()
    const height = items.length * 36 + 14
    const right = Math.max(8, window.innerWidth - box.right)
    // Opens upwards when there is no room below (last rows of the table).
    const above = box.bottom + height + 8 > window.innerHeight && box.top > height + 8
    setPlace(above ? { bottom: window.innerHeight - box.top + 4, right } : { top: box.bottom + 4, right })
  }

  function closeAndRefocus() {
    setPlace(null)
    trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const close = () => setPlace(null)
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', close)
    // Capture phase: the page scrolls inside <main>, and scroll events do not bubble.
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      closeAndRefocus()
      return
    }
    const entries = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])
    const at = entries.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % entries.length
    else if (e.key === 'ArrowUp') next = (at - 1 + entries.length) % entries.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = entries.length - 1
    if (next < 0) return
    e.preventDefault()
    entries[next]?.focus()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn-icon"
        title="More actions"
        aria-label={`More actions: invoice ${number}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        disabled={disabled}
      >
        {spinning ? <Spinner size={14} /> : <MoreHorizontal size={15} />}
      </button>
      {place && createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={`More actions for invoice ${number}`}
          className="fixed z-40 w-52 p-1.5 rounded-xl border border-line-strong bg-surface shadow-pop animate-fade-in"
          style={place}
          onKeyDown={onKeyDown}
        >
          {items.map(({ label, icon: Icon, onSelect, danger }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={`nav-item w-full ${danger ? 'hover:!text-bad hover:!bg-bad/10' : ''}`}
              onClick={() => {
                setPlace(null)
                onSelect()
              }}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Invoices() {
  const { settings, baseCurrency } = useSettings()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()

  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [clients, setClients] = useState<Client[]>([])
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [busyRows, setBusyRows] = useState<Record<number, RowAction>>({})

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Invoice | null>(null)
  const [form, setForm] = useState<InvoiceForm>(() => blankForm(settings, baseCurrency))
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState<SaveTarget | null>(null)
  // Whether anything was typed into the open form, and whether the due date was set by hand.
  const touched = useRef(false)
  const dueEdited = useRef(false)
  // True while the "discard?" question is open, so a second close request is ignored.
  const closing = useRef(false)

  const [payTarget, setPayTarget] = useState<Invoice | null>(null)
  const [payDate, setPayDate] = useState(todayISO())
  const [payMethod, setPayMethod] = useState(PAYMENT_METHODS[0])
  const [payError, setPayError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)

  const status = readStatusParam(params.get('status'))
  const dueDays = dueDaysFrom(settings)

  // ── Loading ────────────────────────────────────────────────────────────────

  // Reloads after a row action must use the search that is current when they
  // run, not the one that was current when the action started.
  const latestQuery = useRef(query)
  latestQuery.current = query
  const latestRequest = useRef(0)

  const load = useCallback(async () => {
    const request = ++latestRequest.current
    setFetching(true)
    try {
      const rows = await invoiceApi.list(latestQuery.current ? { search: latestQuery.current } : undefined)
      if (request !== latestRequest.current) return
      setInvoices(rows)
      setLoadError(null)
    } catch (err) {
      if (request !== latestRequest.current) return
      setLoadError(errorMessage(err, 'Could not load invoices'))
    } finally {
      if (request === latestRequest.current) setFetching(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    load()
  }, [load, query])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const rows = await clientApi.list()
        if (active) setClients(rows)
      } catch (err) {
        if (active) toast.error(errorMessage(err, 'Could not load saved clients'))
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // ── Filters ────────────────────────────────────────────────────────────────

  function setStatus(next: StatusFilter) {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next === 'all') p.delete('status')
      else p.set('status', next)
      return p
    }, { replace: true })
  }

  function clearFilters() {
    setSearch('')
    setQuery('')
    setStatus('all')
  }

  /** Makes sure a newly created invoice is not hidden by the status filter. */
  function reveal(created: InvoiceStatus) {
    if (status !== 'all' && status !== created) setStatus('all')
  }

  const loaded = loadError ? NO_INVOICES : invoices || NO_INVOICES
  const firstLoad = invoices === null && !loadError

  const byStatus = useMemo(() => {
    const groups: Record<InvoiceStatus, Invoice[]> = { Draft: [], Sent: [], Overdue: [], Paid: [], Cancelled: [] }
    for (const inv of loaded) groups[inv.status]?.push(inv)
    return groups
  }, [loaded])

  const visible = useMemo(
    () => (status === 'all' ? loaded : loaded.filter((inv) => inv.status === status)),
    [loaded, status]
  )
  const visibleTotals = useMemo(() => totalsByCurrency(visible, baseCurrency), [visible, baseCurrency])
  const statusLabel = STATUS_FILTERS.find((s) => s.id === status)?.label || 'All'

  function exportVisible() {
    const scope = status === 'all' ? 'all' : status.toLowerCase()
    exportCsv(`invoices-${scope}-${todayISO()}.csv`, CSV_COLUMNS, visible)
    toast.success(`Exported ${plural(visible.length, 'invoice')}`)
  }

  // ── Create / edit form ─────────────────────────────────────────────────────

  function openNew() {
    touched.current = false
    dueEdited.current = false
    setEditing(null)
    setForm(blankForm(settings, baseCurrency))
    setSubmitted(false)
    setFormOpen(true)
  }

  function openEdit(inv: Invoice) {
    touched.current = false
    setEditing(inv)
    setForm(formFromInvoice(inv, baseCurrency))
    setSubmitted(false)
    setFormOpen(true)
  }

  async function closeForm() {
    if (saving || closing.current) return
    if (touched.current) {
      closing.current = true
      const discard = await confirm({
        title: editing ? 'Discard your changes?' : 'Discard this invoice?',
        message: editing
          ? `The changes to invoice ${editing.invoice_number} have not been saved.`
          : 'What you entered has not been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      })
      // The Escape press that dismisses the question also reaches this form's
      // dialog; keep ignoring close requests until that key press is over.
      setTimeout(() => { closing.current = false }, 0)
      if (!discard) return
    }
    setFormOpen(false)
  }

  function patch(changes: Partial<InvoiceForm>) {
    touched.current = true
    setForm((f) => ({ ...f, ...changes }))
  }

  // On a new invoice the due date follows the issue date until it is set by hand.
  function setIssueDate(value: string) {
    const follow = !editing && !dueEdited.current && !!value
    patch(follow ? { issue_date: value, due_date: addDaysISO(value, dueDays) } : { issue_date: value })
  }

  // A link to /invoices?new=1 opens the form; the flag is dropped so a refresh does not reopen it.
  useEffect(() => {
    if (params.get('new') !== '1') return
    openNew()
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.delete('new')
      return p
    }, { replace: true })
  }, [params])

  // Settings can arrive after the form opened (a direct link to ?new=1):
  // apply the company defaults as long as nothing has been typed.
  useEffect(() => {
    if (formOpen && !editing && !touched.current) setForm(blankForm(settings, baseCurrency))
  }, [settings, baseCurrency])

  const problems = submitted ? validate(form) : {}
  const canChooseStatus = !editing || editing.status === 'Draft'
  const currencyOptions = (SUPPORTED_CURRENCIES as readonly string[]).includes(form.currency)
    ? SUPPORTED_CURRENCIES
    : [form.currency, ...SUPPORTED_CURRENCIES]

  async function save(target: SaveTarget) {
    if (saving) return
    setSubmitted(true)
    const problem = firstProblem(validate(form))
    if (problem) {
      toast.error(problem)
      return
    }

    const body = { ...toBody(form), status: target === 'keep' ? undefined : target }
    setSaving(target)
    try {
      if (editing) {
        await invoiceApi.update(editing.id, body)
        toast.success(target === 'Sent'
          ? `Invoice ${editing.invoice_number} saved and marked as sent`
          : `Invoice ${editing.invoice_number} saved`)
      } else {
        const created = await invoiceApi.create(body)
        toast.success(target === 'Sent'
          ? `Invoice ${created.invoice_number} created and marked as sent`
          : `Invoice ${created.invoice_number} saved as a draft`)
        reveal(target === 'Sent' ? 'Sent' : 'Draft')
      }
      setFormOpen(false)
      load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the invoice'))
    } finally {
      setSaving(null)
    }
  }

  // ── Row actions ────────────────────────────────────────────────────────────

  function setRowBusy(id: number, action: RowAction | null) {
    setBusyRows((prev) => {
      const next = { ...prev }
      if (action) next[id] = action
      else delete next[id]
      return next
    })
  }

  /** Runs one request for a row, keeps the row locked until the list is fresh again. */
  async function runRow<T>(
    inv: Invoice, action: RowAction, request: () => Promise<T>, done: (result: T) => void, failure: string
  ) {
    setRowBusy(inv.id, action)
    try {
      done(await request())
      await load()
    } catch (err) {
      toast.error(errorMessage(err, failure))
    } finally {
      setRowBusy(inv.id, null)
    }
  }

  async function send(inv: Invoice) {
    const number = inv.invoice_number
    const email = (inv.client_email || '').trim()

    if (!email && inv.status !== 'Draft') {
      // Already marked as sent and nowhere to email it: sending would change nothing.
      const edit = await confirm({
        title: 'No email address on this invoice',
        message: `Invoice ${number} has no client email, so it cannot be sent by email. Add an address to the invoice first.`,
        confirmLabel: 'Edit invoice',
      })
      if (edit) openEdit(inv)
      return
    }

    const ok = await confirm(!email
      ? {
          title: 'No email address on this invoice',
          message: `Invoice ${number} has no client email, so it cannot be sent by email. You can mark it as sent and deliver the PDF yourself, or go back and add an address by editing the invoice.`,
          confirmLabel: 'Mark as sent',
          cancelLabel: 'Go back',
        }
      : {
          title: inv.email_sent ? `Send invoice ${number} again?` : `Send invoice ${number}?`,
          message: inv.status === 'Draft'
            ? `The invoice PDF will be emailed to ${email} and the invoice marked as sent.`
            : inv.email_sent && inv.email_sent_at
              ? `It was last emailed on ${formatDate(inv.email_sent_at)}. The invoice PDF will be emailed to ${email} again.`
              : `The invoice PDF will be emailed to ${email}.`,
          confirmLabel: 'Send by email',
        })
    if (!ok) return

    setRowBusy(inv.id, 'send')
    const pending = toast.loading(email ? `Sending invoice ${number}` : `Marking invoice ${number} as sent`)
    try {
      const res = await invoiceApi.send(inv.id)
      if (res.emailSent) {
        toast.success(res.message, { id: pending })
      } else if (!email) {
        toast.success(`Invoice ${number} marked as sent`, { id: pending })
      } else {
        // The request worked but no email went out; the message says why.
        toast(res.message, {
          id: pending,
          duration: 8000,
          icon: <AlertTriangle size={16} className="text-warn shrink-0" />,
        })
      }
      await load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the invoice'), { id: pending })
    } finally {
      setRowBusy(inv.id, null)
    }
  }

  function openPayment(inv: Invoice) {
    setPayDate(todayISO())
    setPayMethod(PAYMENT_METHODS[0])
    setPayError(null)
    setPayTarget(inv)
  }

  function closePayment() {
    if (!paying) setPayTarget(null)
  }

  async function submitPayment(e: React.FormEvent) {
    e.preventDefault()
    if (!payTarget || paying) return
    if (!payDate) {
      setPayError('Choose the payment date')
      return
    }
    setPaying(true)
    try {
      const res = await invoiceApi.markPaid(payTarget.id, { paid_date: payDate, payment_method: payMethod })
      toast.success(res.message, { duration: 6000 })
      setPayTarget(null)
      load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not record the payment'))
    } finally {
      setPaying(false)
    }
  }

  async function markUnpaid(inv: Invoice) {
    const ok = await confirm({
      title: `Mark invoice ${inv.invoice_number} as unpaid?`,
      message: (
        <>
          The income entry of <Money amount={inv.total} currency={inv.currency || baseCurrency} className="text-ink" /> recorded
          for this invoice will be removed from Income, and the invoice goes back to how it was before the
          payment: a draft if it had not been sent yet, otherwise awaiting payment.
        </>
      ),
      confirmLabel: 'Mark as unpaid',
      tone: 'danger',
    })
    if (!ok) return
    await runRow(inv, 'unpaid', () => invoiceApi.markUnpaid(inv.id),
      (res) => toast.success(res.message), 'Could not mark the invoice as unpaid')
  }

  async function duplicate(inv: Invoice) {
    await runRow(inv, 'duplicate', () => invoiceApi.duplicate(inv.id), (res) => {
      toast.success(`Draft ${res.invoice_number} created from ${inv.invoice_number}`)
      reveal('Draft')
    }, 'Could not duplicate the invoice')
  }

  async function cancelInvoice(inv: Invoice) {
    const ok = await confirm({
      title: `Cancel invoice ${inv.invoice_number}?`,
      message: 'It stays in the list as cancelled and is no longer counted as owed. You can reopen it as a draft later.',
      confirmLabel: 'Cancel invoice',
      cancelLabel: 'Keep invoice',
      tone: 'danger',
    })
    if (!ok) return
    await runRow(inv, 'cancel',
      () => invoiceApi.setStatus(inv.id, 'Cancelled'),
      () => toast.success(`Invoice ${inv.invoice_number} cancelled`), 'Could not cancel the invoice')
  }

  async function reopen(inv: Invoice) {
    const ok = await confirm({
      title: `Reopen invoice ${inv.invoice_number}?`,
      message: 'It becomes a draft again, so it can be edited and sent.',
      confirmLabel: 'Reopen as draft',
    })
    if (!ok) return
    await runRow(inv, 'reopen',
      () => invoiceApi.setStatus(inv.id, 'Draft'),
      () => toast.success(`Invoice ${inv.invoice_number} reopened as a draft`), 'Could not reopen the invoice')
  }

  async function remove(inv: Invoice) {
    const ok = await confirm({
      title: `Delete invoice ${inv.invoice_number}?`,
      message: inv.status === 'Paid' ? (
        <>
          This invoice is paid. Deleting it also removes its income entry
          of <Money amount={inv.total} currency={inv.currency || baseCurrency} className="text-ink" /> from Income.
          This cannot be undone.
        </>
      ) : 'The invoice and its line items are deleted for good. This cannot be undone.',
      confirmLabel: 'Delete invoice',
      tone: 'danger',
    })
    if (!ok) return
    await runRow(inv, 'delete', () => invoiceApi.delete(inv.id),
      (res) => toast.success(res.message), 'Could not delete the invoice')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const newInvoiceButton = (
    <button type="button" className="btn-primary" onClick={openNew}>
      <Plus size={16} /> New invoice
    </button>
  )

  return (
    <div className="page">
      <PageHeader
        title="Invoices"
        description="Bill clients, see what is owed and record payments as they arrive."
        actions={newInvoiceButton}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STAT_CARDS.map((card) => {
          const group = byStatus[card.status]
          return (
            <StatCard
              key={card.status}
              label={card.label}
              icon={card.icon}
              tone={group.length ? card.tone : 'neutral'}
              loading={firstLoad}
              value={loadError ? '—' : <span className="num">{formatNumber(group.length)}</span>}
              hint={loadError ? undefined : statHint(group, baseCurrency, card.none)}
              onClick={() => setStatus(status === card.status ? 'all' : card.status)}
            />
          )
        })}
      </div>

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search client, company or number"
          className="w-full sm:w-72"
        />
        <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <button
          type="button"
          className="btn-secondary sm:ml-auto"
          onClick={exportVisible}
          disabled={visible.length === 0}
        >
          <FileDown size={15} /> Export CSV
        </button>
      </Toolbar>

      <div className="table-wrap" aria-busy={fetching}>
        {loadError ? (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError(null)
              load()
            }}
          />
        ) : firstLoad ? (
          <TableSkeleton rows={8} cols={7} />
        ) : visible.length === 0 ? (
          loaded.length === 0 && !query ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="Create an invoice to bill a client. It stays a draft until you send it."
              action={newInvoiceButton}
            />
          ) : (
            <EmptyState
              icon={FileText}
              title="No invoices match"
              description={
                query
                  ? `Nothing ${status === 'all' ? '' : `with the status ${statusLabel.toLowerCase()} `}matches "${query}". The search looks at the client, company and invoice number.`
                  : `There are no ${statusLabel.toLowerCase()} invoices right now.`
              }
              action={
                <button type="button" className="btn-secondary" onClick={clearFilters}>
                  {query ? 'Clear filters' : 'Show all invoices'}
                </button>
              }
            />
          )
        ) : (
          <>
            <div className={`table-scroll transition-opacity duration-150 ${fetching ? 'opacity-60' : ''}`}>
              <table className="table">
                <caption className="sr-only">Invoices</caption>
                <thead>
                  <tr>
                    <th scope="col" className="th">Number</th>
                    <th scope="col" className="th">Client</th>
                    <th scope="col" className="th">Issued</th>
                    <th scope="col" className="th">Due</th>
                    <th scope="col" className="th-num">Total</th>
                    <th scope="col" className="th">Status</th>
                    <th scope="col" className="th-num">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((inv) => {
                    const busy = busyRows[inv.id]
                    const number = inv.invoice_number
                    const unpaid = inv.status === 'Draft' || inv.status === 'Sent' || inv.status === 'Overdue'
                    const due = dueNote(inv)
                    const note = statusNote(inv)
                    return (
                      <tr key={inv.id} className="tr">
                        <td className="td td-strong whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            <span className="num">{number}</span>
                            {inv.proposal_id != null && <span className="badge-neutral">From proposal</span>}
                          </div>
                        </td>
                        <td className="td">
                          <p className="text-ink max-w-[220px] truncate" title={inv.client_name}>{inv.client_name}</p>
                          {inv.client_company && (
                            <p className="text-xs text-ink-3 max-w-[220px] truncate" title={inv.client_company}>
                              {inv.client_company}
                            </p>
                          )}
                        </td>
                        <td className="td whitespace-nowrap">{formatDate(inv.issue_date)}</td>
                        <td className="td whitespace-nowrap">
                          {formatDate(inv.due_date)}
                          {due && <p className={`text-xs mt-0.5 ${due.tone}`}>{due.text}</p>}
                        </td>
                        <td className="td-num">
                          <Money amount={inv.total} currency={inv.currency || baseCurrency} />
                        </td>
                        <td className="td whitespace-nowrap">
                          <StatusBadge status={inv.status} />
                          {note && <p className="text-xs text-ink-3 mt-1" title={note.title}>{note.text}</p>}
                        </td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-0.5">
                            <RowButton
                              label="View PDF" number={number} icon={Eye}
                              onClick={() => openPdf(invoiceApi.pdfUrl(inv.id))}
                            />
                            {unpaid && (
                              <RowButton
                                label={inv.email_sent ? 'Send again by email' : 'Send by email'}
                                number={number} icon={Send}
                                onClick={() => send(inv)} disabled={!!busy} spinning={busy === 'send'}
                              />
                            )}
                            {unpaid && (
                              <RowButton
                                label="Record payment" number={number} icon={Banknote}
                                onClick={() => openPayment(inv)} disabled={!!busy}
                              />
                            )}
                            {inv.status === 'Paid' && (
                              <RowButton
                                label="Mark as unpaid" number={number} icon={Undo2}
                                onClick={() => markUnpaid(inv)} disabled={!!busy} spinning={busy === 'unpaid'}
                              />
                            )}
                            {inv.status === 'Cancelled' && (
                              <RowButton
                                label="Reopen as draft" number={number} icon={RotateCcw}
                                onClick={() => reopen(inv)} disabled={!!busy} spinning={busy === 'reopen'}
                              />
                            )}
                            {inv.status !== 'Paid' && (
                              <RowButton
                                label="Edit" number={number} icon={Pencil}
                                onClick={() => openEdit(inv)} disabled={!!busy}
                              />
                            )}
                            <RowMenu
                              number={number}
                              disabled={!!busy}
                              spinning={busy === 'duplicate' || busy === 'cancel' || busy === 'delete'}
                              items={[
                                { label: 'Download PDF', icon: Download, onSelect: () => downloadUrl(invoiceApi.pdfUrl(inv.id)) },
                                { label: 'Duplicate', icon: Copy, onSelect: () => duplicate(inv) },
                                ...(unpaid
                                  ? [{ label: 'Cancel invoice', icon: Ban, onSelect: () => cancelInvoice(inv), danger: true }]
                                  : []),
                                { label: 'Delete', icon: Trash2, onSelect: () => remove(inv), danger: true },
                              ]}
                            />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 border-t border-line bg-surface-2/40 text-xs text-ink-3">
              <span>
                {plural(visible.length, 'invoice')}
                {query && <> matching "{query}"</>}
              </span>
              {status !== 'all' && (
                <span className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                  <span className="eyebrow">{statusLabel} total</span>
                  {visibleTotals.map(([currency, sum]) => (
                    <Money key={currency} amount={sum} currency={currency} className="text-ink" />
                  ))}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Create / edit */}
      <Modal
        open={formOpen}
        onClose={closeForm}
        size="lg"
        busy={!!saving}
        title={editing ? `Edit invoice ${editing.invoice_number}` : 'New invoice'}
        subtitle={
          !editing ? 'The invoice number is assigned when you save.'
            : editing.status === 'Cancelled' ? 'This invoice is cancelled. Saving keeps it cancelled.'
              : editing.status === 'Draft' ? 'Draft. Nothing has been sent to the client yet.'
                : 'Already sent. Changes are not emailed to the client until you send it again.'
        }
        footer={
          <>
            <span className="w-full sm:w-auto sm:mr-auto sm:max-w-xs text-xs text-ink-3">
              Saving does not email the client. Use "Send by email" in the list for that.
            </span>
            <button type="button" className="btn-secondary" onClick={closeForm} disabled={!!saving}>Cancel</button>
            {canChooseStatus ? (
              <>
                <button type="button" className="btn-secondary" onClick={() => save('Sent')} disabled={!!saving}>
                  {saving === 'Sent' && <Spinner />} Save and mark as sent
                </button>
                <button type="button" className="btn-primary" onClick={() => save('Draft')} disabled={!!saving}>
                  {saving === 'Draft' && <Spinner />} Save draft
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary" onClick={() => save('keep')} disabled={!!saving}>
                {saving === 'keep' && <Spinner />} Save changes
              </button>
            )}
          </>
        }
      >
        <div className="space-y-6">
          <section>
            <p className="eyebrow mb-3">Bill to</p>
            <ClientFields clients={clients} value={form.client} onChange={(client) => patch({ client })} />
            {problems.client && <p className="field-error" role="alert">{problems.client}</p>}
          </section>

          <section>
            <p className="eyebrow mb-3">Dates and currency</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Issue date" required error={problems.issue_date}>
                <input
                  type="date" className="input" value={form.issue_date}
                  onChange={(e) => setIssueDate(e.target.value)}
                />
              </Field>
              <Field
                label="Due date" required error={problems.due_date}
                hint={
                  editing?.status === 'Overdue' ? 'Today or later puts the invoice back to sent'
                    : !editing ? `${plural(dueDays, 'day')} after the issue date by default`
                      : undefined
                }
              >
                <input
                  type="date" className="input" value={form.due_date} min={form.issue_date || undefined}
                  onChange={(e) => {
                    dueEdited.current = true
                    patch({ due_date: e.target.value })
                  }}
                />
              </Field>
              <Field label="Currency" hint="Line prices are entered in this currency">
                <select className="input" value={form.currency} onChange={(e) => patch({ currency: e.target.value })}>
                  {currencyOptions.map((code) => (
                    <option key={code} value={code}>{code} — {symbolFor(code)}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          <section>
            <p className="eyebrow mb-3">Line items</p>
            <LineItemsEditor
              items={form.items}
              onChange={(items) => patch({ items })}
              currency={form.currency}
              taxRate={form.tax_rate}
              onTaxRate={(tax_rate) => patch({ tax_rate })}
              discount={form.discount}
              onDiscount={(discount) => patch({ discount })}
            />
            {problems.items && <p className="field-error" role="alert">{problems.items}</p>}
          </section>

          <section>
            <p className="eyebrow mb-3">Printed on the invoice</p>
            <div className="form-grid">
              <Field label="Notes">
                <textarea
                  className="input resize-y" rows={3} maxLength={5000} value={form.notes}
                  onChange={(e) => patch({ notes: e.target.value })}
                />
              </Field>
              <Field label="Terms">
                <textarea
                  className="input resize-y" rows={3} maxLength={5000} value={form.terms}
                  onChange={(e) => patch({ terms: e.target.value })}
                />
              </Field>
            </div>
          </section>
        </div>
      </Modal>

      {/* Record payment */}
      {payTarget && (
        <Modal
          open
          onClose={closePayment}
          size="sm"
          busy={paying}
          title="Record payment"
          subtitle={`Invoice ${payTarget.invoice_number} · ${payTarget.client_name}`}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closePayment} disabled={paying}>Cancel</button>
              <button type="submit" form="invoice-payment-form" className="btn-primary" disabled={paying}>
                {paying && <Spinner />} Record payment
              </button>
            </>
          }
        >
          <form id="invoice-payment-form" onSubmit={submitPayment} className="space-y-4" noValidate>
            <div className="rounded-lg border border-line bg-surface-2 px-4 py-3">
              <p className="eyebrow">Amount received</p>
              <Money
                amount={payTarget.total} currency={payTarget.currency || baseCurrency}
                className="block mt-1 text-xl font-semibold text-ink"
              />
            </div>
            <Field label="Payment date" required error={payError}>
              <input
                type="date" className="input" value={payDate}
                onChange={(e) => {
                  setPayDate(e.target.value)
                  setPayError(null)
                }}
              />
            </Field>
            <Field label="Payment method">
              <select className="input" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
              </select>
            </Field>
            <p className="flex gap-2 text-xs text-ink-3 leading-relaxed">
              <Info size={14} className="shrink-0 mt-0.5" />
              <span>
                This marks the invoice as paid and records the amount under Income on the payment date.
                Use "Mark as unpaid" to undo it.
              </span>
            </p>
          </form>
        </Modal>
      )}
    </div>
  )
}
