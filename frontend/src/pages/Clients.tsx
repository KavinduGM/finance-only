import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Download, Eye, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { clientApi } from '../services/api'
import type { Client } from '../services/api'
import {
  EmptyState, ErrorState, Field, LoadingBlock, Modal, Money, PageHeader, SearchInput, Spinner,
  StatusBadge, TableSkeleton, Toolbar, useConfirm,
} from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import { exportCsv } from '../lib/files'
import { errorMessage, formatDate, formatNumber, todayISO } from '../lib/format'

type ClientDetail = Awaited<ReturnType<typeof clientApi.get>>

interface ClientForm {
  name: string
  company: string
  email: string
  phone: string
  country: string
  address: string
  notes: string
}

type FormErrors = Partial<Record<keyof ClientForm, string>>

const emptyForm = (): ClientForm => ({
  name: '', company: '', email: '', phone: '', country: 'Sri Lanka', address: '', notes: '',
})

const toForm = (c: Client): ClientForm => ({
  name: c.name || '',
  company: c.company || '',
  email: c.email || '',
  phone: c.phone || '',
  country: c.country || '',
  address: c.address || '',
  notes: c.notes || '',
})

// Same shape the server accepts, so a bad address is caught before the request.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validate(form: ClientForm): FormErrors {
  const errors: FormErrors = {}
  if (!form.name.trim()) errors.name = 'Enter the client name'
  if (form.email.trim() && !EMAIL.test(form.email.trim())) errors.email = 'Enter a valid email address'
  return errors
}

const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`

// Document tables inside the "View" dialog: short rows, and a long list scrolls
// under a header that stays in view instead of stretching the dialog.
const COMPACT_SCROLL = 'table-scroll max-h-[19rem] overflow-y-auto'
const COMPACT_TH = 'py-2 sticky top-0 z-10 bg-surface-2 shadow-[inset_0_-1px_0_rgb(var(--line))]'

export default function Clients() {
  const { baseCurrency, money } = useSettings()
  const confirm = useConfirm()

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [clients, setClients] = useState<Client[] | null>(null)
  // The search the rows on screen were loaded for (the box may already say something newer).
  const [shownQuery, setShownQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Client | null>(null)
  const [form, setForm] = useState<ClientForm>(emptyForm)
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)

  const [viewing, setViewing] = useState<Client | null>(null)
  const [detail, setDetail] = useState<ClientDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Each request takes a ticket; a response is ignored once a newer one is out.
  const listTicket = useRef(0)
  const detailTicket = useRef(0)

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

  const load = useCallback(async () => {
    const ticket = ++listTicket.current
    setFetching(true)
    setError(null)
    try {
      const list = await clientApi.list({ search: query || undefined })
      if (ticket !== listTicket.current) return
      setClients(list)
      setShownQuery(query)
    } catch (err) {
      if (ticket !== listTicket.current) return
      setClients(null)
      setError(errorMessage(err, 'Could not load clients'))
    } finally {
      if (ticket === listTicket.current) setFetching(false)
    }
  }, [query])

  useEffect(() => {
    load()
  }, [load])

  const loadDetail = useCallback(async (id: number) => {
    const ticket = ++detailTicket.current
    setDetail(null)
    setDetailError(null)
    try {
      const data = await clientApi.get(id)
      if (ticket !== detailTicket.current) return
      setDetail(data)
    } catch (err) {
      if (ticket !== detailTicket.current) return
      setDetailError(errorMessage(err, 'Could not load this client'))
    }
  }, [])

  function openView(client: Client) {
    setViewing(client)
    loadDetail(client.id)
  }

  function closeView() {
    detailTicket.current++
    setViewing(null)
  }

  function openNew() {
    setEditing(null)
    setForm(emptyForm())
    setErrors({})
    setFormOpen(true)
  }

  function openEdit(client: Client) {
    setEditing(client)
    setForm(toForm(client))
    setErrors({})
    setFormOpen(true)
  }

  function setField(field: keyof ClientForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    const problems = validate(form)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    const text = (value: string) => value.trim() || null
    const body: Partial<Client> = {
      name: form.name.trim(),
      company: text(form.company),
      email: text(form.email),
      phone: text(form.phone),
      country: text(form.country),
      address: text(form.address),
      notes: text(form.notes),
    }

    setSaving(true)
    try {
      if (editing) {
        await clientApi.update(editing.id, body)
        toast.success('Client updated')
      } else {
        await clientApi.create(body)
        toast.success('Client added')
      }
      setFormOpen(false)
      load()
    } catch (err) {
      toast.error(errorMessage(err, editing ? 'Could not update the client' : 'Could not add the client'))
    } finally {
      setSaving(false)
    }
  }

  async function remove(client: Client) {
    const invoices = client.invoice_count || 0
    const proposals = client.proposal_count || 0
    const documents = [
      invoices ? plural(invoices, 'invoice', 'invoices') : '',
      proposals ? plural(proposals, 'proposal', 'proposals') : '',
    ].filter(Boolean).join(' and ')

    const ok = await confirm({
      title: `Delete ${client.name}?`,
      message: (
        <>
          <p>
            {documents
              ? `${client.name} has ${documents}. They are kept and still show the client's name; only the link to the saved client is removed.`
              : "Any invoices, proposals and income entries for this client are kept and still show the client's name."}
          </p>
          <p className="mt-2">The saved contact details are deleted. This cannot be undone.</p>
        </>
      ),
      confirmLabel: 'Delete client',
      tone: 'danger',
    })
    if (!ok) return

    setBusyId(client.id)
    try {
      await clientApi.delete(client.id)
      toast.success('Client deleted')
      setClients((list) => (list ? list.filter((c) => c.id !== client.id) : list))
      load()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the client'))
    } finally {
      setBusyId(null)
    }
  }

  function exportClients() {
    if (!clients?.length) return
    exportCsv<Client>(`clients-${todayISO()}.csv`, [
      { header: 'Name', value: (c) => c.name },
      { header: 'Company', value: (c) => c.company },
      { header: 'Email', value: (c) => c.email },
      { header: 'Phone', value: (c) => c.phone },
      { header: 'Country', value: (c) => c.country },
      { header: 'Address', value: (c) => c.address },
      { header: 'Invoices', value: (c) => c.invoice_count ?? 0 },
      { header: 'Proposals', value: (c) => c.proposal_count ?? 0 },
      { header: `Total billed (${baseCurrency})`, value: (c) => c.total_billed ?? 0 },
      { header: `Outstanding (${baseCurrency})`, value: (c) => c.outstanding ?? 0 },
      { header: 'Notes', value: (c) => c.notes },
    ], clients)
  }

  return (
    <div className="page">
      <PageHeader
        title="Clients"
        description="The people and companies you send proposals and invoices to"
        actions={
          <button type="button" className="btn-primary" onClick={openNew}>
            <Plus size={15} /> Add client
          </button>
        }
      />

      <Toolbar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, company, email or phone"
          className="w-full sm:w-80"
        />
        <div className="flex items-center gap-3 ml-auto">
          {fetching && clients && <Spinner className="text-ink-3" />}
          <button type="button" className="btn-secondary" onClick={exportClients} disabled={!clients?.length}>
            <Download size={15} /> Export CSV
          </button>
        </div>
      </Toolbar>

      <div className="table-wrap">
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : clients === null ? (
          <TableSkeleton rows={6} cols={6} />
        ) : clients.length === 0 ? (
          shownQuery ? (
            <EmptyState
              icon={Users}
              title="No clients match your search"
              description={<>Nothing found for "{shownQuery}". Try a shorter name, or the company or email instead.</>}
              action={<button type="button" className="btn-secondary" onClick={() => setSearch('')}>Clear search</button>}
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No clients yet"
              description="Save a client once and their details fill in automatically on every proposal and invoice."
              action={
                <button type="button" className="btn-primary" onClick={openNew}>
                  <Plus size={15} /> Add client
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
                    <th scope="col" className="th">Name</th>
                    <th scope="col" className="th">Contact</th>
                    <th scope="col" className="th">Country</th>
                    <th scope="col" className="th-num">Invoices</th>
                    <th scope="col" className="th-num">Total billed</th>
                    <th scope="col" className="th-num">Outstanding</th>
                    <th scope="col" className="th-num">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const busy = busyId === c.id
                    const outstanding = Number(c.outstanding) || 0
                    return (
                      <tr key={c.id} className="tr">
                        <td className="td td-strong">
                          <button
                            type="button"
                            className="block max-w-[260px] truncate text-left hover:text-accent transition-colors"
                            title={c.name}
                            onClick={() => openView(c)}
                          >
                            {c.name}
                          </button>
                          {c.company && (
                            <div className="max-w-[260px] truncate text-xs font-normal text-ink-3 mt-0.5" title={c.company}>
                              {c.company}
                            </div>
                          )}
                        </td>
                        <td className="td">
                          {c.email || c.phone ? (
                            <>
                              {c.email && (
                                <a
                                  href={`mailto:${c.email}`}
                                  className="block max-w-[240px] truncate hover:text-ink transition-colors"
                                  title={c.email}
                                >
                                  {c.email}
                                </a>
                              )}
                              {c.phone && (
                                <div className={`num whitespace-nowrap ${c.email ? 'text-xs text-ink-3 mt-0.5' : ''}`}>
                                  {c.phone}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap">{c.country || <span className="text-ink-3">—</span>}</td>
                        <td className="td-num">{formatNumber(c.invoice_count)}</td>
                        <td className="td-num whitespace-nowrap">{money(c.total_billed)}</td>
                        <td className={`td-num whitespace-nowrap ${outstanding > 0 ? '' : 'text-ink-3'}`}>
                          {money(outstanding)}
                        </td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              type="button" className="btn-icon" onClick={() => openView(c)} disabled={busy}
                              title="View" aria-label={`View ${c.name}`}
                            >
                              <Eye size={15} />
                            </button>
                            <button
                              type="button" className="btn-icon" onClick={() => openEdit(c)} disabled={busy}
                              title="Edit" aria-label={`Edit ${c.name}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button" className="btn-icon-danger" onClick={() => remove(c)} disabled={busy}
                              title="Delete" aria-label={`Delete ${c.name}`}
                            >
                              {busy ? <Spinner size={14} /> : <Trash2 size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 border-t border-line bg-surface-2/40 text-xs text-ink-3">
              <span>{plural(clients.length, 'client', 'clients')}{shownQuery ? ' found' : ''}</span>
              <span>Billed and outstanding amounts are converted to {baseCurrency}</span>
            </div>
          </>
        )}
      </div>

      {/* Add / edit */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Edit client' : 'Add client'}
        subtitle={
          editing
            ? 'Changes apply to new documents. Invoices and proposals already issued keep the details they were sent with.'
            : 'These details are offered whenever you create a proposal or an invoice.'
        }
        busy={saving}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="client-form" className="btn-primary" disabled={saving}>
              {saving && <Spinner size={14} />}
              {editing ? 'Save changes' : 'Add client'}
            </button>
          </>
        }
      >
        <form id="client-form" onSubmit={submit} noValidate className="form-grid">
          <Field label="Name" required error={errors.name}>
            <input
              className="input" value={form.name} maxLength={200} autoComplete="off"
              aria-invalid={!!errors.name} onChange={(e) => setField('name', e.target.value)}
            />
          </Field>
          <Field label="Company">
            <input
              className="input" value={form.company} maxLength={200} autoComplete="off"
              onChange={(e) => setField('company', e.target.value)}
            />
          </Field>
          <Field label="Email" error={errors.email} hint="Needed to send proposals and invoices by email">
            <input
              className="input" type="email" value={form.email} maxLength={254} autoComplete="off"
              aria-invalid={!!errors.email} onChange={(e) => setField('email', e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <input
              className="input" type="tel" value={form.phone} maxLength={50} autoComplete="off"
              onChange={(e) => setField('phone', e.target.value)}
            />
          </Field>
          <Field label="Country">
            <input
              className="input" value={form.country} maxLength={100} autoComplete="off"
              onChange={(e) => setField('country', e.target.value)}
            />
          </Field>
          <Field label="Address" className="form-full" hint="Printed under the client name on documents">
            <textarea
              className="input resize-y" rows={2} value={form.address} maxLength={500}
              onChange={(e) => setField('address', e.target.value)}
            />
          </Field>
          <Field label="Notes" className="form-full" hint="Only visible here, never printed on a document">
            <textarea
              className="input resize-y" rows={3} value={form.notes} maxLength={2000}
              onChange={(e) => setField('notes', e.target.value)}
            />
          </Field>
        </form>
      </Modal>

      {/* View */}
      {viewing && (
        <Modal
          open
          onClose={closeView}
          size="lg"
          title={viewing.name}
          subtitle={viewing.company || undefined}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closeView}>Close</button>
              <button
                type="button" className="btn-primary"
                onClick={() => {
                  const client = detail || viewing
                  closeView()
                  openEdit(client)
                }}
              >
                <Pencil size={14} /> Edit client
              </button>
            </>
          }
        >
          {detailError ? (
            <ErrorState message={detailError} onRetry={() => loadDetail(viewing.id)} />
          ) : !detail ? (
            <LoadingBlock label="Loading client" />
          ) : (
            <ClientDetails summary={viewing} detail={detail} />
          )}
        </Modal>
      )}
    </div>
  )
}

/** Body of the "View" dialog: figures, contact details, then the latest documents. */
function ClientDetails({ summary, detail }: { summary: Client; detail: ClientDetail }) {
  const { baseCurrency, money } = useSettings()
  const invoices = detail.invoices || []
  const proposals = detail.proposals || []
  const none = <span className="text-ink-3">—</span>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 rounded-xl border border-line bg-surface-2/40 divide-y sm:divide-y-0 sm:divide-x divide-line">
        <Figure label="Invoices" value={formatNumber(summary.invoice_count)} />
        <Figure label="Total billed" value={money(summary.total_billed)} />
        <Figure label="Outstanding" value={money(summary.outstanding)} />
      </div>

      <section>
        <h3 className="eyebrow mb-3">Contact details</h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <Detail label="Email">
            {detail.email ? <a href={`mailto:${detail.email}`} className="link break-all">{detail.email}</a> : none}
          </Detail>
          <Detail label="Phone">
            {detail.phone ? <a href={`tel:${detail.phone}`} className="num hover:text-accent">{detail.phone}</a> : none}
          </Detail>
          <Detail label="Country">{detail.country || none}</Detail>
          <Detail label="Client since">{formatDate(detail.created_at)}</Detail>
          <Detail label="Address" full>
            {detail.address ? <span className="whitespace-pre-line">{detail.address}</span> : none}
          </Detail>
          {detail.notes && (
            <Detail label="Notes" full>
              <span className="whitespace-pre-line text-ink-2">{detail.notes}</span>
            </Detail>
          )}
        </dl>
      </section>

      <section>
        <SectionHeading title="Recent invoices" shown={invoices.length} total={summary.invoice_count} />
        {invoices.length === 0 ? (
          <EmptyNote>No invoices for this client yet. Create one from the Invoices page and pick this client.</EmptyNote>
        ) : (
          <div className="rounded-xl border border-line overflow-hidden">
            <div className={COMPACT_SCROLL}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Number</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Issued</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Due</th>
                    <th scope="col" className={`th-num ${COMPACT_TH}`}>Amount</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="tr">
                      <td className="td td-strong num py-2 whitespace-nowrap">{inv.invoice_number}</td>
                      <td className="td py-2 whitespace-nowrap">{formatDate(inv.issue_date)}</td>
                      <td className="td py-2 whitespace-nowrap">{formatDate(inv.due_date)}</td>
                      <td className="td-num py-2"><Money amount={inv.total} currency={inv.currency || baseCurrency} /></td>
                      <td className="td py-2"><StatusBadge status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Recent proposals" shown={proposals.length} total={summary.proposal_count} />
        {proposals.length === 0 ? (
          <EmptyNote>No proposals for this client yet. Create one from the Proposals page and pick this client.</EmptyNote>
        ) : (
          <div className="rounded-xl border border-line overflow-hidden">
            <div className={COMPACT_SCROLL}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Number</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Title</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Issued</th>
                    <th scope="col" className={`th-num ${COMPACT_TH}`}>Amount</th>
                    <th scope="col" className={`th ${COMPACT_TH}`}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.id} className="tr">
                      <td className="td td-strong num py-2 whitespace-nowrap">{p.proposal_number}</td>
                      <td className="td py-2">
                        <div className="max-w-[260px] truncate" title={p.title || undefined}>{p.title || none}</div>
                      </td>
                      <td className="td py-2 whitespace-nowrap">{formatDate(p.issue_date)}</td>
                      <td className="td-num py-2"><Money amount={p.total} currency={p.currency || baseCurrency} /></td>
                      <td className="td py-2"><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3 min-w-0">
      <p className="eyebrow">{label}</p>
      <p className="num text-base font-semibold text-ink mt-1 truncate" title={value}>{value}</p>
    </div>
  )
}

function Detail({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 ${full ? 'sm:col-span-2' : ''}`}>
      <dt className="eyebrow">{label}</dt>
      <dd className="text-sm text-ink mt-1 break-words">{children}</dd>
    </div>
  )
}

/** The server returns the latest 20 documents; say so when the client has more. */
function SectionHeading({ title, shown, total }: { title: string; shown: number; total?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2">
      <h3 className="eyebrow">{title}</h3>
      {total !== undefined && total > shown && shown > 0 && (
        <span className="text-xs text-ink-3">Latest {formatNumber(shown)} of {formatNumber(total)}</span>
      )}
    </div>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line px-4 py-5 text-sm text-ink-3 text-center">{children}</p>
  )
}
