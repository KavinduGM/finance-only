import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  CheckCircle2, Clock, Copy, Download, FileSignature, FileText, Pencil, Percent, Plus, ReceiptText, Send,
  Trash2, Undo2, Wallet, XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { clientApi, proposalApi } from '../services/api'
import type { Client, DocumentClientFields, LineItem, Proposal, ProposalStats, ProposalStatus } from '../services/api'
import {
  ClientFields, EmptyState, ErrorState, Field, LineItemsEditor, Modal, Money, PageHeader, SearchInput, Segmented,
  Spinner, StatCard, StatusBadge, TableSkeleton, Toolbar, emptyClientFields, emptyItem, lineItemsProblem, useConfirm,
} from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import {
  CURRENCY_SYMBOLS, SUPPORTED_CURRENCIES, addDaysISO, daysUntil, errorMessage, formatDate, formatNumber, thisYear,
  todayISO,
} from '../lib/format'
import { exportCsv, openPdf } from '../lib/files'

type StatusFilter = 'All' | ProposalStatus
type RowAction = 'send' | 'accept' | 'decline' | 'reopen' | 'convert' | 'duplicate' | 'delete'

const STATUSES: ProposalStatus[] = ['Draft', 'Sent', 'Accepted', 'Declined', 'Expired']
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LONG_TEXT = 5000
const SEARCH_MAX = 100

interface FormState {
  client: DocumentClientFields
  title: string
  summary: string
  issue_date: string
  valid_until: string
  currency: string
  items: LineItem[]
  tax_rate: string
  discount: string
  notes: string
  terms: string
}

interface FormDefaults {
  currency: string
  validityDays: number
  taxRate: number
  terms: string
}

type Problems = Partial<Record<'client' | 'title' | 'issue_date' | 'valid_until' | 'items', string>>

function blankForm(defaults: FormDefaults): FormState {
  const today = todayISO()
  return {
    client: emptyClientFields(),
    title: '',
    summary: '',
    issue_date: today,
    valid_until: addDaysISO(today, defaults.validityDays),
    currency: defaults.currency,
    items: [emptyItem()],
    tax_rate: defaults.taxRate > 0 ? String(defaults.taxRate) : '',
    discount: '',
    notes: '',
    terms: defaults.terms,
  }
}

function formFrom(p: Proposal, fallbackCurrency: string): FormState {
  return {
    client: {
      client_id: p.client_id,
      client_name: p.client_name || '',
      client_email: p.client_email || '',
      client_company: p.client_company || '',
      client_address: p.client_address || '',
    },
    title: p.title || '',
    summary: p.summary || '',
    issue_date: p.issue_date,
    valid_until: p.valid_until,
    currency: p.currency || fallbackCurrency,
    items: p.items?.length
      ? p.items.map((it) => ({ description: it.description, quantity: it.quantity, unit_price: it.unit_price }))
      : [emptyItem()],
    tax_rate: p.tax_rate ? String(p.tax_rate) : '',
    discount: p.discount ? String(p.discount) : '',
    notes: p.notes || '',
    terms: p.terms || '',
  }
}

/** Problems in form order, so the first value is the first thing to fix. */
function findProblems(f: FormState): Problems {
  const problems: Problems = {}
  const email = (f.client.client_email || '').trim()
  if (!f.client.client_name.trim()) problems.client = 'Enter the client name'
  else if (email && !EMAIL.test(email)) problems.client = 'The client email address does not look right'

  if (!f.title.trim()) problems.title = 'Give the proposal a title'
  if (!f.issue_date) problems.issue_date = 'Choose the issue date'
  if (!f.valid_until) problems.valid_until = 'Choose the last day the proposal is valid'
  else if (f.issue_date && f.valid_until < f.issue_date) problems.valid_until = 'Valid until cannot be earlier than the issue date'

  const rate = Number(f.tax_rate) || 0
  const lines = lineItemsProblem(f.items, f.discount)
  if (lines) problems.items = lines
  else if (Number(f.discount) < 0) problems.items = 'Discount cannot be negative'
  else if (rate < 0 || rate > 100) problems.items = 'Tax rate must be between 0 and 100'
  return problems
}

const hasLapsed = (p: Proposal) => (daysUntil(p.valid_until) ?? 0) < 0

/** "expires in 3 days" for a sent proposal in its last week, otherwise nothing. */
function expiryNote(p: Proposal): string | null {
  if (p.status !== 'Sent') return null
  const days = daysUntil(p.valid_until)
  if (days === null || days < 0 || days > 7) return null
  if (days === 0) return 'expires today'
  return `expires in ${days} ${days === 1 ? 'day' : 'days'}`
}

/** Where a decided proposal goes back to: sent if the client already has it and it is still valid. */
const reopenTarget = (p: Proposal): 'Draft' | 'Sent' => (p.sent_at && !hasLapsed(p) ? 'Sent' : 'Draft')

function editNote(p: Proposal) {
  if (p.status === 'Sent') return 'Already sent. Send it again after saving so the client gets this version.'
  if (p.status === 'Expired') return 'Expired. Set a valid-until date of today or later to reopen it.'
  if (p.status === 'Declined') return 'Marked as declined. Saving keeps that status.'
  return 'Draft. Nothing reaches the client until you send it.'
}

const hasResponse = (err: unknown) => Boolean((err as { response?: unknown } | null)?.response)

function RowButton({ label, icon: Icon, onClick, working, disabled, danger }: {
  label: string
  icon: LucideIcon
  onClick: () => void
  /** This button's own request is in flight. */
  working?: boolean
  disabled?: boolean
  danger?: boolean
}) {
  // A draft row carries eight actions. Slightly tighter buttons keep the whole
  // row on screen on a 1366px laptop instead of pushing Edit and Delete out of view.
  return (
    <button
      type="button" className={`${danger ? 'btn-icon-danger' : 'btn-icon'} !w-7 !h-7 shrink-0`}
      title={label} aria-label={label} onClick={onClick} disabled={disabled}
    >
      {working ? <Spinner size={14} /> : <Icon size={15} />}
    </button>
  )
}

export default function Proposals() {
  const { settings, baseCurrency, money, moneyCompact } = useSettings()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const validity = Number(settings?.proposal_validity_days)
  const defaults: FormDefaults = {
    currency: baseCurrency,
    validityDays: validity > 0 ? Math.round(validity) : 30,
    taxRate: Number(settings?.default_tax_rate) || 0,
    terms: settings?.proposal_terms || '',
  }

  // ── List ───────────────────────────────────────────────────────────────────
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [stats, setStats] = useState<ProposalStats | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('All')
  /** Proposal id → the action running on that row. */
  const [busy, setBusy] = useState<Record<number, RowAction>>({})

  // ── Form ───────────────────────────────────────────────────────────────────
  const [clients, setClients] = useState<Client[]>([])
  const [clientsFailed, setClientsFailed] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Proposal | null>(null)
  const [form, setForm] = useState<FormState>(() => blankForm(defaults))
  const [showProblems, setShowProblems] = useState(false)
  const [saving, setSaving] = useState(false)
  /** The form exactly as it was opened; while `form` is still this object nothing has been typed. */
  const pristine = useRef<FormState | null>(null)
  const closing = useRef(false)

  // The loaders read the filters from a ref so a reload started by a row action
  // always uses what is on screen now, not what was there when it was clicked.
  const criteria = useRef({ filter, query })
  criteria.current = { filter, query }
  const listRequest = useRef(0)
  const statsRequest = useRef(0)

  const loadList = useCallback(async () => {
    const request = ++listRequest.current
    const { filter: status, query: text } = criteria.current
    setFetching(true)
    try {
      const rows = await proposalApi.list({ status: status === 'All' ? undefined : status, search: text || undefined })
      if (request !== listRequest.current) return
      setProposals(rows)
      setLoadError(null)
    } catch (err) {
      if (request !== listRequest.current) return
      setProposals(null)
      setLoadError(errorMessage(err, 'Could not load proposals'))
    } finally {
      if (request === listRequest.current) setFetching(false)
    }
  }, [])

  const loadStats = useCallback(async () => {
    const request = ++statsRequest.current
    try {
      const next = await proposalApi.stats()
      if (request !== statsRequest.current) return
      setStats(next)
      setStatsFailed(false)
    } catch {
      if (request !== statsRequest.current) return
      // Reported in the stat cards themselves ("Could not load").
      setStats(null)
      setStatsFailed(true)
    }
  }, [])

  const loadClients = useCallback(async () => {
    try {
      setClients(await clientApi.list())
      setClientsFailed(false)
    } catch {
      // Reported inside the form, where the picker is.
      setClientsFailed(true)
    }
  }, [])

  const refresh = useCallback(() => Promise.all([loadList(), loadStats()]), [loadList, loadStats])

  useEffect(() => {
    loadList()
  }, [loadList, filter, query])

  useEffect(() => {
    loadStats()
    loadClients()
  }, [loadStats, loadClients])

  // Search waits for a pause in typing before it reaches the server.
  useEffect(() => {
    const next = search.trim().slice(0, SEARCH_MAX)
    if (next === query) return
    const timer = setTimeout(() => setQuery(next), 300)
    return () => clearTimeout(timer)
  }, [search, query])

  function retry() {
    setLoadError(null)
    refresh()
  }

  function clearFilters() {
    setSearch('')
    setQuery('')
    setFilter('All')
  }

  /** Reloads after a new draft was made, switching away from a status filter that would hide it. */
  function refreshForNewDraft() {
    const current = criteria.current.filter
    if (current === 'All' || current === 'Draft') return refresh()
    setFilter('All') // the list reloads through the filter effect
    return loadStats()
  }

  // ── Form handling ──────────────────────────────────────────────────────────

  function openForm(proposal: Proposal | null) {
    const next = proposal ? formFrom(proposal, baseCurrency) : blankForm(defaults)
    pristine.current = next
    setForm(next)
    setEditing(proposal)
    setShowProblems(false)
    setModalOpen(true)
    loadClients()
  }

  // /proposals?new=1 opens the form straight away; the parameter is then
  // dropped so a reload or the back button does not open it again.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return
    openForm(null)
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next, { replace: true })
    // Runs only when the address changes.
  }, [searchParams])

  // Settings can arrive after the form was opened from a direct link; if
  // nothing has been typed yet, start again from the real defaults.
  useEffect(() => {
    if (!settings || !modalOpen || editing || form !== pristine.current) return
    const next = blankForm(defaults)
    pristine.current = next
    setForm(next)
    // Runs only when the settings change, not on every keystroke in the form.
  }, [settings])

  const patch = (changes: Partial<FormState>) => setForm((f) => ({ ...f, ...changes }))

  function changeIssueDate(value: string) {
    setForm((f) => {
      // Valid until follows the issue date for as long as it is still the standard number of days after it.
      const follows = f.valid_until === addDaysISO(f.issue_date, defaults.validityDays)
      return {
        ...f,
        issue_date: value,
        valid_until: follows && value ? addDaysISO(value, defaults.validityDays) : f.valid_until,
      }
    })
  }

  async function closeForm() {
    if (saving || closing.current) return
    if (form !== pristine.current) {
      closing.current = true
      const discard = await confirm({
        title: editing ? 'Discard your changes?' : 'Discard this proposal?',
        message: editing
          ? `The changes to ${editing.proposal_number} have not been saved.`
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
    setModalOpen(false)
  }

  const problems = useMemo(() => findProblems(form), [form])
  const shown: Problems = showProblems ? problems : {}

  async function save() {
    setShowProblems(true)
    const first = Object.values(problems)[0]
    if (first) {
      toast.error(first)
      return
    }

    const body = {
      client_id: form.client.client_id,
      client_name: form.client.client_name.trim(),
      client_email: (form.client.client_email || '').trim() || null,
      client_company: (form.client.client_company || '').trim() || null,
      client_address: (form.client.client_address || '').trim() || null,
      title: form.title.trim(),
      summary: form.summary.trim() || null,
      issue_date: form.issue_date,
      valid_until: form.valid_until,
      currency: form.currency,
      items: form.items.map((it) => ({
        description: it.description.trim(),
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
      tax_rate: Number(form.tax_rate) || 0,
      discount: Number(form.discount) || 0,
      notes: form.notes.trim() || null,
      terms: form.terms.trim() || null,
    }

    setSaving(true)
    try {
      if (editing) {
        await proposalApi.update(editing.id, body)
        toast.success(`Proposal ${editing.proposal_number} updated`)
      } else {
        const created = await proposalApi.create(body)
        toast.success(`Proposal ${created.proposal_number} saved as a draft`)
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the proposal'))
      return
    } finally {
      setSaving(false)
    }
    setModalOpen(false)
    await (editing ? refresh() : refreshForNewDraft())
  }

  // ── Row actions ────────────────────────────────────────────────────────────

  /** Runs one request for a row: locks the row, reports a failure, unlocks it. */
  async function runRow(p: Proposal, action: RowAction, fallback: string, task: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [p.id]: action }))
    try {
      await task()
    } catch (err) {
      toast.error(errorMessage(err, fallback))
      // A refusal usually means the row on screen is out of date (for example it
      // was already converted in another tab), so show what the server has now.
      if (hasResponse(err)) await refresh()
    } finally {
      setBusy((b) => {
        const next = { ...b }
        delete next[p.id]
        return next
      })
    }
  }

  async function send(p: Proposal) {
    if (hasLapsed(p)) {
      const edit = await confirm({
        title: 'The valid-until date has passed',
        message: `${p.proposal_number} was valid until ${formatDate(p.valid_until)}. Set a later date, then send it.`,
        confirmLabel: 'Edit proposal',
      })
      if (edit) openForm(p)
      return
    }

    if (!p.client_email) {
      if (p.status === 'Sent') {
        const edit = await confirm({
          title: 'No client email address',
          message: `${p.proposal_number} is already marked as sent and has no client email address, so there is nothing to email. Add the address to the proposal first.`,
          confirmLabel: 'Edit proposal',
        })
        if (edit) openForm(p)
        return
      }
      const proceed = await confirm({
        title: 'Mark as sent without emailing?',
        message: `${p.proposal_number} has no client email address, so it cannot be emailed. It will only be marked as sent.`,
        confirmLabel: 'Mark as sent',
      })
      if (!proceed) return
    } else if (p.email_sent) {
      const again = await confirm({
        title: 'Send this proposal again?',
        message: `${p.proposal_number} was already emailed to ${p.client_email}${p.sent_at ? ` on ${formatDate(p.sent_at)}` : ''}.`,
        confirmLabel: 'Send again',
      })
      if (!again) return
    } else {
      const ok = await confirm({
        title: `Send proposal ${p.proposal_number}?`,
        message: `The proposal PDF will be emailed to ${p.client_email}${p.status === 'Sent' ? '' : ' and the proposal marked as sent'}.`,
        confirmLabel: 'Send by email',
      })
      if (!ok) return
    }

    await runRow(p, 'send', 'Could not send the proposal', async () => {
      const res = await proposalApi.send(p.id)
      if (res.emailSent) toast.success(res.message)
      else toast(res.message)
      await refresh()
    })
  }

  function decide(p: Proposal, status: 'Accepted' | 'Declined') {
    return runRow(p, status === 'Accepted' ? 'accept' : 'decline', 'Could not update the proposal', async () => {
      await proposalApi.setStatus(p.id, status)
      toast.success(`Proposal ${p.proposal_number} marked as ${status.toLowerCase()}`)
      await refresh()
    })
  }

  function reopen(p: Proposal) {
    const target = reopenTarget(p)
    return runRow(p, 'reopen', 'Could not reopen the proposal', async () => {
      await proposalApi.setStatus(p.id, target)
      toast.success(`Proposal ${p.proposal_number} reopened as ${target.toLowerCase()}`)
      await refresh()
    })
  }

  async function convert(p: Proposal) {
    const proceed = await confirm({
      title: 'Convert to invoice?',
      message: (
        <>
          A draft invoice for <Money amount={p.total} currency={p.currency || baseCurrency} className="text-ink" /> will
          be created from {p.proposal_number}
          {p.status === 'Accepted' ? '.' : ', and the proposal will be marked as accepted.'}
        </>
      ),
      confirmLabel: 'Convert to invoice',
    })
    if (!proceed) return

    await runRow(p, 'convert', 'Could not convert the proposal', async () => {
      const res = await proposalApi.convert(p.id)
      toast.success(`Invoice ${res.invoice_number} created`)
      navigate('/invoices')
    })
  }

  function duplicate(p: Proposal) {
    return runRow(p, 'duplicate', 'Could not duplicate the proposal', async () => {
      const copy = await proposalApi.duplicate(p.id)
      toast.success(`Draft ${copy.proposal_number} created from ${p.proposal_number}`)
      await refreshForNewDraft()
    })
  }

  async function remove(p: Proposal) {
    const proceed = await confirm({
      title: `Delete proposal ${p.proposal_number}?`,
      message: p.invoice_id
        ? `"${p.title}" for ${p.client_name} will be removed. The invoice created from it is kept. This cannot be undone.`
        : `"${p.title}" for ${p.client_name} will be removed. This cannot be undone.`,
      confirmLabel: 'Delete proposal',
      tone: 'danger',
    })
    if (!proceed) return

    await runRow(p, 'delete', 'Could not delete the proposal', async () => {
      await proposalApi.delete(p.id)
      toast.success(`Proposal ${p.proposal_number} deleted`)
      await refresh()
    })
  }

  function exportList() {
    if (!proposals?.length) return
    exportCsv<Proposal>(`proposals-${todayISO()}.csv`, [
      { header: 'Number', value: (p) => p.proposal_number },
      { header: 'Title', value: (p) => p.title },
      { header: 'Client', value: (p) => p.client_name },
      { header: 'Company', value: (p) => p.client_company },
      { header: 'Client email', value: (p) => p.client_email },
      { header: 'Issued', value: (p) => p.issue_date },
      { header: 'Valid until', value: (p) => p.valid_until },
      { header: 'Currency', value: (p) => p.currency },
      { header: 'Subtotal', value: (p) => p.subtotal },
      { header: 'Discount', value: (p) => p.discount },
      { header: 'Tax', value: (p) => p.tax_amount },
      { header: 'Total', value: (p) => p.total },
      { header: 'Status', value: (p) => p.status },
      { header: 'Invoiced', value: (p) => (p.invoice_id ? 'Yes' : 'No') },
    ], proposals)
    toast.success(`Exported ${formatNumber(proposals.length)} ${proposals.length === 1 ? 'proposal' : 'proposals'}`)
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const statusOptions = useMemo(() => {
    const all = stats ? STATUSES.reduce((n, s) => n + (stats.counts[s] || 0), 0) : undefined
    const options: { id: StatusFilter; label: string; count?: number }[] = [{ id: 'All', label: 'All', count: all }]
    for (const s of STATUSES) options.push({ id: s, label: s, count: stats?.counts[s] })
    return options
  }, [stats])

  // Each currency is added up on its own; amounts in different currencies are never combined here.
  const totalsByCurrency = useMemo(() => {
    const sums = new Map<string, number>()
    for (const p of proposals || []) {
      const currency = p.currency || baseCurrency
      sums.set(currency, (sums.get(currency) || 0) + (Number(p.total) || 0))
    }
    return Array.from(sums).sort(([a], [b]) => a.localeCompare(b))
  }, [proposals, baseCurrency])

  const currencyOptions: string[] = (SUPPORTED_CURRENCIES as readonly string[]).includes(form.currency)
    ? [...SUPPORTED_CURRENCIES]
    : [form.currency, ...SUPPORTED_CURRENCIES]

  const statsLoading = !stats && !statsFailed
  const unavailable = statsFailed ? 'Could not load' : undefined
  const filtered = filter !== 'All' || query !== ''
  const noMatchHint = query
    ? `Nothing matches "${query}"${filter === 'All' ? '' : ` among the ${filter.toLowerCase()} proposals`}.`
    : `There are no ${filter.toLowerCase()} proposals right now.`

  return (
    <div className="page">
      <PageHeader
        title="Proposals"
        description="Quotes you send to clients before the work starts"
        actions={
          <button type="button" className="btn-primary" onClick={() => openForm(null)}>
            <Plus size={16} /> New proposal
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Open value" icon={Wallet} tone="accent" loading={statsLoading}
          value={stats
            ? <span title={money(stats.open_value, stats.base_currency)}>{moneyCompact(stats.open_value, stats.base_currency)}</span>
            : '—'}
          hint={stats ? `${formatNumber(stats.counts.Draft + stats.counts.Sent)} draft or sent` : unavailable}
        />
        <StatCard
          label="Accepted this year" icon={CheckCircle2} tone="good" loading={statsLoading}
          value={stats
            ? <span title={money(stats.accepted_value, stats.base_currency)}>{moneyCompact(stats.accepted_value, stats.base_currency)}</span>
            : '—'}
          hint={stats ? `Proposals won in ${thisYear()}` : unavailable}
        />
        <StatCard
          label="Win rate" icon={Percent} loading={statsLoading}
          value={stats && stats.win_rate !== null ? `${Number(stats.win_rate).toFixed(1)}%` : '—'}
          hint={unavailable || 'Accepted vs declined or expired'}
        />
        <StatCard
          label="Awaiting reply" icon={Clock} loading={statsLoading}
          value={stats ? formatNumber(stats.counts.Sent) : '—'}
          hint={stats
            ? (stats.counts.Expired ? `${formatNumber(stats.counts.Expired)} expired without a reply` : 'Sent and still valid')
            : unavailable}
        />
      </div>

      <Toolbar>
        <SearchInput
          value={search} onChange={setSearch}
          placeholder="Search client, number or title" className="w-full sm:w-72"
        />
        <Segmented<StatusFilter> options={statusOptions} value={filter} onChange={setFilter} />
        <button
          type="button" className="btn-secondary ml-auto" onClick={exportList}
          disabled={!proposals?.length} title="Export the proposals listed below"
        >
          <Download size={15} /> Export CSV
        </button>
      </Toolbar>

      <div className="table-wrap" aria-busy={fetching}>
        {loadError ? (
          <ErrorState message={loadError} onRetry={retry} />
        ) : proposals === null ? (
          <TableSkeleton rows={6} cols={7} />
        ) : proposals.length === 0 ? (
          <EmptyState
            icon={FileSignature}
            title={filtered ? 'No proposals match' : 'No proposals yet'}
            description={filtered
              ? noMatchHint
              : 'Write a quote, send it to the client and turn it into an invoice once it is accepted.'}
            action={filtered
              ? <button type="button" className="btn-secondary" onClick={clearFilters}>Clear filters</button>
              : <button type="button" className="btn-primary" onClick={() => openForm(null)}><Plus size={16} /> New proposal</button>}
          />
        ) : (
          <>
            <div className={`table-scroll transition-opacity ${fetching ? 'opacity-60' : ''}`}>
              {/* The Proposal column takes whatever width the others leave; the
                  minimum keeps it readable before the table starts to scroll. */}
              <table className="table min-w-[1050px]" aria-label="Proposals">
                <thead>
                  <tr>
                    <th className="th">Number</th>
                    <th className="th w-full">Proposal</th>
                    <th className="th">Issued</th>
                    <th className="th">Valid until</th>
                    <th className="th-num">Total</th>
                    <th className="th">Status</th>
                    <th className="th pl-0 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => {
                    const working = busy[p.id]
                    const locked = Boolean(working)
                    const note = expiryNote(p)
                    const invoiced = Boolean(p.invoice_id)
                    const undecided = p.status === 'Draft' || p.status === 'Sent'
                    const canSend = undecided || p.status === 'Expired'
                    const canConvert = p.status !== 'Declined' && !invoiced
                    const canReopen = p.status === 'Declined' || (p.status === 'Accepted' && !invoiced)
                    const clientLine = [p.client_name, p.client_company].filter(Boolean).join(' · ')
                    return (
                      <tr key={p.id} className="tr">
                        <td className="td td-strong num whitespace-nowrap">{p.proposal_number}</td>
                        <td className="td w-full max-w-0">
                          <p className="text-ink truncate" title={p.title}>{p.title}</p>
                          <p className="text-xs text-ink-3 truncate" title={clientLine}>{clientLine}</p>
                        </td>
                        <td className="td whitespace-nowrap">{formatDate(p.issue_date)}</td>
                        <td className="td whitespace-nowrap">
                          {formatDate(p.valid_until)}
                          {note && <span className="block text-xs text-warn">{note}</span>}
                        </td>
                        <td className="td-num">
                          <Money amount={p.total} currency={p.currency || baseCurrency} />
                        </td>
                        <td className="td">
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge status={p.status} />
                            {invoiced && (
                              <span className="badge-accent" title="An invoice was created from this proposal">Invoiced</span>
                            )}
                          </div>
                        </td>
                        <td className="td pl-0">
                          <div className="flex items-center justify-end">
                            <RowButton
                              label="View PDF" icon={FileText} disabled={locked}
                              onClick={() => openPdf(proposalApi.pdfUrl(p.id))}
                            />
                            {canSend && (
                              <RowButton
                                label={p.status === 'Sent' ? 'Send again by email' : 'Send by email'} icon={Send}
                                working={working === 'send'} disabled={locked} onClick={() => send(p)}
                              />
                            )}
                            {undecided && (
                              <>
                                <RowButton
                                  label="Mark accepted" icon={CheckCircle2}
                                  working={working === 'accept'} disabled={locked} onClick={() => decide(p, 'Accepted')}
                                />
                                <RowButton
                                  label="Mark declined" icon={XCircle}
                                  working={working === 'decline'} disabled={locked} onClick={() => decide(p, 'Declined')}
                                />
                              </>
                            )}
                            {canConvert && (
                              <RowButton
                                label="Convert to invoice" icon={ReceiptText}
                                working={working === 'convert'} disabled={locked} onClick={() => convert(p)}
                              />
                            )}
                            {canReopen && (
                              <RowButton
                                label={`Reopen as ${reopenTarget(p).toLowerCase()}`} icon={Undo2}
                                working={working === 'reopen'} disabled={locked} onClick={() => reopen(p)}
                              />
                            )}
                            <RowButton
                              label="Duplicate" icon={Copy}
                              working={working === 'duplicate'} disabled={locked} onClick={() => duplicate(p)}
                            />
                            {p.status !== 'Accepted' && (
                              <RowButton label="Edit" icon={Pencil} disabled={locked} onClick={() => openForm(p)} />
                            )}
                            <RowButton
                              label="Delete" icon={Trash2} danger
                              working={working === 'delete'} disabled={locked} onClick={() => remove(p)}
                            />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 border-t border-line bg-surface-2/40 text-xs text-ink-3">
              <span>
                <span className="num">{formatNumber(proposals.length)}</span> {proposals.length === 1 ? 'proposal' : 'proposals'} listed
              </span>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>{totalsByCurrency.length > 1 ? 'Totals by currency' : 'Total'}</span>
                {totalsByCurrency.map(([currency, amount]) => (
                  <Money key={currency} amount={amount} currency={currency} className="text-ink-2" />
                ))}
              </span>
            </div>
          </>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={closeForm}
        size="lg"
        title={editing ? `Edit proposal ${editing.proposal_number}` : 'New proposal'}
        subtitle={editing ? editNote(editing) : 'Saved as a draft. Nothing reaches the client until you send it.'}
        busy={saving}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={closeForm} disabled={saving}>Cancel</button>
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving && <Spinner />}
              {editing ? 'Save changes' : 'Save draft'}
            </button>
          </>
        }
      >
        <div className="space-y-6">
          <section className="space-y-3">
            <p className="eyebrow">Client</p>
            {clientsFailed && (
              <p className="text-xs text-ink-3">
                Saved clients could not be loaded. You can still type the client details below.{' '}
                <button type="button" className="link" onClick={loadClients}>Try again</button>
              </p>
            )}
            <ClientFields clients={clients} value={form.client} onChange={(client) => patch({ client })} />
            {shown.client && <p role="alert" className="text-xs text-bad">{shown.client}</p>}
          </section>

          <section className="space-y-3">
            <p className="eyebrow">Proposal</p>
            <div className="form-grid">
              <Field label="Title" required error={shown.title} className="form-full">
                <input
                  className="input" value={form.title} maxLength={200} placeholder="What the proposal is for"
                  onChange={(e) => patch({ title: e.target.value })}
                />
              </Field>
              <Field label="Summary" hint="Scope of work shown under the title" className="form-full">
                <textarea
                  className="input" rows={3} value={form.summary} maxLength={LONG_TEXT}
                  onChange={(e) => patch({ summary: e.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Issue date" required error={shown.issue_date}>
                <input
                  className="input" type="date" value={form.issue_date}
                  onChange={(e) => changeIssueDate(e.target.value)}
                />
              </Field>
              <Field label="Valid until" required error={shown.valid_until}>
                <input
                  className="input" type="date" value={form.valid_until} min={form.issue_date || undefined}
                  onChange={(e) => patch({ valid_until: e.target.value })}
                />
              </Field>
              <Field label="Currency">
                <select className="input" value={form.currency} onChange={(e) => patch({ currency: e.target.value })}>
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>{CURRENCY_SYMBOLS[c] ? `${c} — ${CURRENCY_SYMBOLS[c]}` : c}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <p className="eyebrow">Line items</p>
            <LineItemsEditor
              items={form.items} onChange={(items) => patch({ items })}
              currency={form.currency}
              taxRate={form.tax_rate} onTaxRate={(tax_rate) => patch({ tax_rate })}
              discount={form.discount} onDiscount={(discount) => patch({ discount })}
            />
            {shown.items && <p role="alert" className="text-xs text-bad">{shown.items}</p>}
          </section>

          <section className="space-y-3">
            <p className="eyebrow">Notes and terms</p>
            <div className="form-grid">
              <Field label="Notes" hint="Printed on the proposal, below the line items">
                <textarea
                  className="input" rows={4} value={form.notes} maxLength={LONG_TEXT}
                  onChange={(e) => patch({ notes: e.target.value })}
                />
              </Field>
              <Field label="Terms" hint={editing ? undefined : 'Leave empty to use the standard terms from Settings'}>
                <textarea
                  className="input" rows={4} value={form.terms} maxLength={LONG_TEXT}
                  onChange={(e) => patch({ terms: e.target.value })}
                />
              </Field>
            </div>
          </section>
        </div>
      </Modal>
    </div>
  )
}
