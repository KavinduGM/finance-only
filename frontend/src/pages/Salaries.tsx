import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { addMonths, format, parseISO } from 'date-fns'
import {
  CalendarPlus, CheckCheck, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, Eraser, FileText, Mail,
  Pencil, Plus, Trash2, Undo2, Users, Wallet,
} from 'lucide-react'
import { payeeApi, salaryApi } from '../services/api'
import type { Payee, SalaryPayment } from '../services/api'
import {
  EmptyState, ErrorState, Field, Modal, Money, PageHeader, SearchInput, Spinner, StatCard, StatusBadge,
  TableSkeleton, Tabs, Toolbar, useConfirm,
} from '../components/ui'
import type { TabItem } from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import {
  CURRENCY_SYMBOLS, SUPPORTED_CURRENCIES, errorMessage, formatDate, formatMoney, formatMonth, thisMonthISO, todayISO,
} from '../lib/format'
import { exportCsv, openPdf } from '../lib/files'

type TabId = 'payments' | 'people'
type CurrencyTotal = [currency: string, total: number]

// The values the server accepts for a person's pay type.
const PAY_TYPES: readonly string[] = ['Monthly', 'Project', 'Hourly']
const PAYMENT_METHODS: readonly string[] = ['Bank Transfer', 'Cash', 'Check', 'Online']
const CURRENCIES: readonly string[] = SUPPORTED_CURRENCIES

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The years the server accepts. A year typed as "26" would otherwise be saved as
// 0026 and the payroll expense would drop out of every dated report.
const MIN_DATE = '2000-01-01'
const MAX_DATE = '2100-12-31'
const MIN_MONTH = MIN_DATE.slice(0, 7)
const MAX_MONTH = MAX_DATE.slice(0, 7)
const dateInRange = (date: string) => DATE_RE.test(date) && date >= MIN_DATE && date <= MAX_DATE
const monthInRange = (ym: string) => MONTH_RE.test(ym) && ym >= MIN_MONTH && ym <= MAX_MONTH

const round2 = (n: number) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const shiftMonth = (ym: string, by: number) => format(addMonths(parseISO(`${ym}-01`), by), 'yyyy-MM')
const nameKey = (name: string | null) => String(name || '').trim().toLowerCase()

/** A blank amount counts as zero. */
const toAmount = (value: string) => (value.trim() === '' ? 0 : Number(value))

function amountProblem(value: string, required = false): string | null {
  if (value.trim() === '') return required ? 'Enter an amount' : null
  const n = Number(value)
  if (!Number.isFinite(n)) return 'Enter a number'
  if (n < 0) return 'Cannot be negative'
  return null
}

/** Net pay added up per currency. Amounts in different currencies are never combined. */
function netByCurrency(rows: SalaryPayment[], baseCurrency: string): CurrencyTotal[] {
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) || 0) + (Number(r.net_salary) || 0))
  return Array.from(totals.entries())
    .map(([currency, total]): CurrencyTotal => [currency, round2(total)])
    .sort(([a], [b]) => (a === baseCurrency ? -1 : b === baseCurrency ? 1 : a.localeCompare(b)))
}

function joinWords(parts: string[]) {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const listTotals = (totals: CurrencyTotal[]) => joinWords(totals.map(([currency, total]) => formatMoney(total, currency)))

function departmentsOf(people: Payee[]) {
  const names = new Set(people.map((p) => (p.department || '').trim()).filter(Boolean))
  return Array.from(names).sort((a, b) => a.localeCompare(b))
}

/** A value stored by the old system stays selectable instead of silently switching to the first option. */
function withCurrent(options: readonly string[], current: string) {
  return !current || options.includes(current) ? options : [...options, current]
}

function omitKeys(errors: Record<string, string>, keys: string[]) {
  const next = { ...errors }
  for (const k of keys) delete next[k]
  return next
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function MonthStepper({ value, onChange }: { value: string; onChange: (ym: string) => void }) {
  // Browsers without a month picker show a plain text box, so a half-typed
  // value is kept here and only a complete YYYY-MM changes the page. A year
  // outside 2000–2100 (still being typed, or mistyped) never does.
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const current = thisMonthISO()
  const previous = shiftMonth(value, -1)
  const next = shiftMonth(value, 1)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button" className="btn-secondary w-9 px-0" onClick={() => onChange(previous)}
        disabled={!monthInRange(previous)} title="Previous month" aria-label="Previous month"
      >
        <ChevronLeft size={16} />
      </button>
      <input
        type="month" className="input num w-44" aria-label="Payroll month" placeholder="YYYY-MM"
        min={MIN_MONTH} max={MAX_MONTH} value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (monthInRange(e.target.value)) onChange(e.target.value)
        }}
        onBlur={() => setDraft(value)}
      />
      <button
        type="button" className="btn-secondary w-9 px-0" onClick={() => onChange(next)}
        disabled={!monthInRange(next)} title="Next month" aria-label="Next month"
      >
        <ChevronRight size={16} />
      </button>
      {value !== current && (
        <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(current)}>This month</button>
      )}
    </div>
  )
}

/** One figure per currency: a single amount, or a short list when the month has several currencies. */
function CurrencyTotals({ totals, zeroCurrency }: { totals: CurrencyTotal[]; zeroCurrency: string }) {
  if (totals.length <= 1) {
    const text = totals.length === 1 ? formatMoney(totals[0][1], totals[0][0]) : formatMoney(0, zeroCurrency)
    // The full figure is shown, so a long one steps down a size instead of being cut off in a narrow card.
    const fit = text.length > 18 ? 'text-lg leading-8' : text.length > 15 ? 'text-xl leading-8' : ''
    return <span className={fit}>{text}</span>
  }
  return (
    <span className="flex flex-col gap-0.5 text-base leading-6">
      {totals.map(([currency, total]) => (
        <span key={currency} className="truncate">{formatMoney(total, currency)}</span>
      ))}
    </span>
  )
}

function CurrencySelect({ value, onChange }: { value: string; onChange: (currency: string) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {withCurrent(CURRENCIES, value).map((c) => (
        <option key={c} value={c}>{CURRENCY_SYMBOLS[c] ? `${c} — ${CURRENCY_SYMBOLS[c]}` : c}</option>
      ))}
    </select>
  )
}

function NetPay({ net, currency }: { net: number; currency: string }) {
  const negative = net < 0
  return (
    <div className="form-full">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2 px-4 py-3">
        <div>
          <p className="eyebrow">Net pay</p>
          <p className="text-xs text-ink-3 mt-0.5">Base + bonuses − deductions</p>
        </div>
        <span aria-live="polite">
          <Money amount={net} currency={currency} className={`text-lg font-semibold ${negative ? 'text-bad' : 'text-accent'}`} />
        </span>
      </div>
      {negative && (
        <p role="alert" className="text-xs text-bad mt-1">Deductions cannot be more than the base plus bonuses</p>
      )}
    </div>
  )
}

// ── Add or edit a payment ────────────────────────────────────────────────────

interface PaymentFormState {
  employee_id: string
  employee_name: string
  position: string
  department: string
  salary_type: string
  payment_month: string
  base_salary: string
  bonuses: string
  deductions: string
  currency: string
  payment_method: string
  notes: string
}

function PaymentFormModal({ payment, month, monthRows, people, defaultCurrency, onClose, onSaved }: {
  /** The payment being edited, or null to add one by hand. */
  payment: SalaryPayment | null
  month: string
  /** Payments already listed for `month`, to warn before adding a second one for the same person. */
  monthRows: SalaryPayment[]
  /** null while the list of people is not loaded. */
  people: Payee[] | null
  defaultCurrency: string
  onClose: () => void
  onSaved: (month: string) => void
}) {
  const editing = payment !== null
  const [form, setForm] = useState<PaymentFormState>(() => ({
    employee_id: payment?.employee_id ? String(payment.employee_id) : '',
    employee_name: payment?.employee_name || '',
    position: payment?.position || '',
    department: payment?.department || '',
    salary_type: payment?.salary_type || 'Monthly',
    payment_month: payment?.payment_month || month,
    base_salary: payment ? String(payment.base_salary ?? '') : '',
    bonuses: payment?.bonuses ? String(payment.bonuses) : '',
    deductions: payment?.deductions ? String(payment.deductions) : '',
    currency: payment?.currency || defaultCurrency,
    payment_method: payment?.payment_method || 'Bank Transfer',
    notes: payment?.notes || '',
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const activePeople = useMemo(() => (people || []).filter((p) => p.status === 'Active'), [people])
  const net = round2(toAmount(form.base_salary) + toAmount(form.bonuses) - toAmount(form.deductions))
  const duplicate = !editing && form.employee_id !== '' && form.payment_month === month
    && monthRows.some((r) => r.employee_id === Number(form.employee_id))

  const personHint = duplicate
    ? <span className="text-warn">This person already has a payment for {formatMonth(month)}. Saving adds a second one.</span>
    : people === null ? 'The list of people is not loaded yet. You can still type the details below.'
    : activePeople.length === 0 ? 'There are no active people yet. Add them on the People tab, or type a one-off payment below.'
    : 'Pick someone to fill in their details, or type a one-off payment below'

  const set = (patch: Partial<PaymentFormState>) => {
    setForm((f) => ({ ...f, ...patch }))
    setErrors((e) => omitKeys(e, Object.keys(patch)))
  }

  function pickPerson(id: string) {
    const p = activePeople.find((x) => x.id === Number(id))
    if (!p) return set({ employee_id: '' })
    set({
      employee_id: String(p.id),
      employee_name: p.name,
      position: p.position || '',
      department: p.department || '',
      salary_type: p.salary_type || 'Monthly',
      base_salary: String(p.base_salary ?? ''),
      currency: p.currency || defaultCurrency,
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const found: Record<string, string> = {}
    if (!editing) {
      if (!form.employee_name.trim()) found.employee_name = 'Enter the name of the person being paid'
      if (!MONTH_RE.test(form.payment_month)) found.payment_month = 'Choose the month this payment is for'
      else if (!monthInRange(form.payment_month)) found.payment_month = 'The month must be between 2000 and 2100'
    }
    const base = amountProblem(form.base_salary, true)
    const bonuses = amountProblem(form.bonuses)
    const deductions = amountProblem(form.deductions)
    if (base) found.base_salary = base
    if (bonuses) found.bonuses = bonuses
    if (deductions) found.deductions = deductions
    setErrors(found)
    // A negative net is explained next to the net figure.
    if (Object.keys(found).length > 0 || net < 0) return

    const amounts = {
      base_salary: round2(toAmount(form.base_salary)),
      bonuses: round2(toAmount(form.bonuses)),
      deductions: round2(toAmount(form.deductions)),
      currency: form.currency,
      payment_method: form.payment_method,
      notes: form.notes.trim() || null,
    }

    setSaving(true)
    try {
      if (payment) {
        await salaryApi.update(payment.id, amounts)
        toast.success('Payment updated')
      } else {
        await salaryApi.create({
          ...amounts,
          employee_id: form.employee_id ? Number(form.employee_id) : null,
          employee_name: form.employee_name.trim(),
          position: form.position.trim() || null,
          department: form.department.trim() || null,
          salary_type: form.salary_type,
          payment_month: form.payment_month,
        })
        toast.success(`Payment added for ${formatMonth(form.payment_month)}`)
      }
      onSaved(form.payment_month)
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save this payment'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      title={editing ? 'Edit payment' : 'Add payment'}
      subtitle={payment
        ? `${payment.employee_name} · ${formatMonth(payment.payment_month)}`
        : 'A single payment added by hand. It starts as pending.'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="payroll-payment-form" className="btn-primary" disabled={saving}>
            {saving && <Spinner />}
            {editing ? 'Save changes' : 'Add payment'}
          </button>
        </>
      }
    >
      <form id="payroll-payment-form" onSubmit={submit} className="form-grid" noValidate>
        {payment?.status === 'Paid' && (
          <p className="form-full text-xs text-ink-2 bg-info/10 border border-info/20 rounded-lg px-3 py-2">
            This salary is already paid. Saving also updates the payroll expense for {formatMonth(payment.payment_month)}.
          </p>
        )}

        {!editing && (
          <>
            <Field label="Person" className="form-full" hint={personHint}>
              <select className="input" value={form.employee_id} onChange={(e) => pickPerson(e.target.value)}>
                <option value="">— One-off payment (person not on the list) —</option>
                {activePeople.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.position ? ` · ${p.position}` : ''}</option>
                ))}
              </select>
            </Field>
            <Field label="Name" required error={errors.employee_name}>
              <input className="input" value={form.employee_name} maxLength={200} onChange={(e) => set({ employee_name: e.target.value })} />
            </Field>
            <Field label="Month" required error={errors.payment_month}>
              <input
                type="month" className="input" placeholder="YYYY-MM" min={MIN_MONTH} max={MAX_MONTH}
                value={form.payment_month}
                onChange={(e) => set({ payment_month: e.target.value })}
              />
            </Field>
            <Field label="Position">
              <input className="input" value={form.position} maxLength={200} onChange={(e) => set({ position: e.target.value })} />
            </Field>
            <Field label="Department">
              <input className="input" value={form.department} maxLength={200} onChange={(e) => set({ department: e.target.value })} />
            </Field>
            <p className="form-full eyebrow pt-1">Amounts</p>
          </>
        )}

        <Field label="Currency">
          <CurrencySelect value={form.currency} onChange={(currency) => set({ currency })} />
        </Field>
        <Field label="Base" required error={errors.base_salary}>
          <input
            type="number" min="0" step="any" inputMode="decimal" className="input-num" placeholder="0.00"
            value={form.base_salary} onChange={(e) => set({ base_salary: e.target.value })}
          />
        </Field>
        <Field label="Bonuses" error={errors.bonuses}>
          <input
            type="number" min="0" step="any" inputMode="decimal" className="input-num" placeholder="0.00"
            value={form.bonuses} onChange={(e) => set({ bonuses: e.target.value })}
          />
        </Field>
        <Field label="Deductions" error={errors.deductions}>
          <input
            type="number" min="0" step="any" inputMode="decimal" className="input-num" placeholder="0.00"
            value={form.deductions} onChange={(e) => set({ deductions: e.target.value })}
          />
        </Field>

        <NetPay net={net} currency={form.currency} />

        <Field label="Method">
          <select className="input" value={form.payment_method} onChange={(e) => set({ payment_method: e.target.value })}>
            {withCurrent(PAYMENT_METHODS, form.payment_method).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Notes" className="form-full">
          <textarea className="input resize-y" rows={2} maxLength={2000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </form>
    </Modal>
  )
}

// ── Mark one salary as paid ──────────────────────────────────────────────────

function PayModal({ payment, email, onClose, onPaid }: {
  payment: SalaryPayment
  /** The person's address; '' when they have none, null when it is not known. */
  email: string | null
  onClose: () => void
  onPaid: () => void
}) {
  const [date, setDate] = useState(todayISO)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!DATE_RE.test(date)) return setError('Choose the date the salary was paid')
    if (!dateInRange(date)) return setError('The date must be between 2000 and 2100')
    setSaving(true)
    try {
      const res = await salaryApi.pay(payment.id, date)
      // The message says whether the slip was emailed and, if not, why.
      toast.success(res.message, { duration: 6000 })
      onPaid()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not mark this salary as paid'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      busy={saving}
      title="Mark salary as paid"
      subtitle={`${payment.employee_name} · ${formatMonth(payment.payment_month)}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="payroll-pay-form" className="btn-primary" disabled={saving}>
            {saving ? <Spinner /> : <CheckCircle2 size={15} />}
            Mark as paid
          </button>
        </>
      }
    >
      <form id="payroll-pay-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <p className="eyebrow">Net pay</p>
          <Money amount={payment.net_salary} currency={payment.currency} className="text-lg font-semibold text-accent" />
        </div>
        <Field label="Payment date" required error={error}>
          <input
            type="date" className="input" min={MIN_DATE} max={MAX_DATE} value={date}
            onChange={(e) => { setDate(e.target.value); setError(null) }}
          />
        </Field>
        <p className="text-xs text-ink-3 leading-relaxed">
          The amount is added to the payroll expense for {formatMonth(payment.payment_month)}.
          {email ? ` The salary slip is emailed to ${email} when email is set up in Settings.` : ''}
          {email === '' ? ' No slip is emailed because this person has no email address. You can send one from the list afterwards.' : ''}
        </p>
      </form>
    </Modal>
  )
}

// ── Email a salary slip ──────────────────────────────────────────────────────

function SlipEmailModal({ payment, defaultEmail, onClose, onSent }: {
  payment: SalaryPayment
  /** The person's address; '' when they have none, null when it is not known. */
  defaultEmail: string | null
  onClose: () => void
  onSent: () => void
}) {
  const [email, setEmail] = useState(defaultEmail || '')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const to = email.trim()
    if (!to) return setError('Enter the address to send the slip to')
    if (!EMAIL_RE.test(to)) return setError('Enter a valid email address')
    setSending(true)
    try {
      const res = await salaryApi.sendSlip(payment.id, to)
      toast.success(res.message)
      onSent()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the salary slip'))
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      busy={sending}
      title="Email salary slip"
      subtitle={`${payment.employee_name} · ${formatMonth(payment.payment_month)}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={sending}>Cancel</button>
          <button type="submit" form="payroll-slip-form" className="btn-primary" disabled={sending}>
            {sending ? <Spinner /> : <Mail size={15} />}
            Send slip
          </button>
        </>
      }
    >
      <form id="payroll-slip-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field
          label="Send to" required error={error}
          hint={defaultEmail
            ? 'Filled in from this person’s details. Change it to send the slip somewhere else.'
            : defaultEmail === ''
              ? 'No email address is saved for this person. Enter one for this slip, or add it on the People tab.'
              : undefined}
        >
          <input
            type="email" className="input" autoComplete="off" placeholder="name@example.com" value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null) }}
          />
        </Field>
        <p className="text-xs text-ink-3 leading-relaxed">
          The slip is attached as a PDF.
          {payment.slip_sent ? ' One was already sent for this payment; this sends it again.' : ''}
        </p>
      </form>
    </Modal>
  )
}

// ── Add or edit a person ─────────────────────────────────────────────────────

interface PersonFormState {
  name: string
  position: string
  department: string
  email: string
  phone: string
  salary_type: string
  base_salary: string
  currency: string
  start_date: string
  bank_details: string
  notes: string
  status: Payee['status']
}

function PersonFormModal({ person, departments, defaultCurrency, onClose, onSaved }: {
  /** The person being edited, or null to add one. */
  person: Payee | null
  departments: string[]
  defaultCurrency: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<PersonFormState>(() => ({
    name: person?.name || '',
    position: person?.position || '',
    department: person?.department || '',
    email: person?.email || '',
    phone: person?.phone || '',
    salary_type: person?.salary_type || 'Monthly',
    base_salary: person ? String(person.base_salary ?? '') : '',
    currency: person?.currency || defaultCurrency,
    start_date: (person?.start_date || '').slice(0, 10),
    bank_details: person?.bank_details || '',
    notes: person?.notes || '',
    status: person?.status === 'Inactive' ? 'Inactive' : 'Active',
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const set = (patch: Partial<PersonFormState>) => {
    setForm((f) => ({ ...f, ...patch }))
    setErrors((e) => omitKeys(e, Object.keys(patch)))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const found: Record<string, string> = {}
    if (!form.name.trim()) found.name = 'Enter a name'
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) found.email = 'Enter a valid email address'
    const salary = amountProblem(form.base_salary)
    if (salary) found.base_salary = salary
    if (form.start_date && !DATE_RE.test(form.start_date)) found.start_date = 'Enter a valid date'
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const body: Partial<Payee> = {
      name: form.name.trim(),
      position: form.position.trim() || null,
      department: form.department.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      salary_type: form.salary_type,
      base_salary: round2(toAmount(form.base_salary)),
      currency: form.currency,
      start_date: form.start_date || null,
      bank_details: form.bank_details.trim() || null,
      notes: form.notes.trim() || null,
    }

    setSaving(true)
    try {
      if (person) {
        await payeeApi.update(person.id, { ...body, status: form.status })
        toast.success('Person updated')
      } else {
        await payeeApi.create(body)
        toast.success('Person added to payroll')
      }
      onSaved()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save this person'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={saving}
      title={person ? 'Edit person' : 'Add person'}
      subtitle={person ? person.name : 'Someone you pay each month'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="payroll-person-form" className="btn-primary" disabled={saving}>
            {saving && <Spinner />}
            {person ? 'Save changes' : 'Add person'}
          </button>
        </>
      }
    >
      <form id="payroll-person-form" onSubmit={submit} className="form-grid" noValidate>
        <Field label="Name" required error={errors.name}>
          <input className="input" value={form.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Position">
          <input className="input" value={form.position} maxLength={200} onChange={(e) => set({ position: e.target.value })} />
        </Field>
        <Field label="Department">
          <input
            className="input" list="payroll-departments" value={form.department} maxLength={200}
            onChange={(e) => set({ department: e.target.value })}
          />
        </Field>
        <Field label="Email" hint="Used to email salary slips" error={errors.email}>
          <input type="email" className="input" autoComplete="off" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input type="tel" className="input" autoComplete="off" value={form.phone} maxLength={50} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Start date" error={errors.start_date}>
          <input type="date" className="input" value={form.start_date} onChange={(e) => set({ start_date: e.target.value })} />
        </Field>

        <p className="form-full eyebrow pt-1">Pay</p>
        <Field label="Pay type">
          <select className="input" value={form.salary_type} onChange={(e) => set({ salary_type: e.target.value })}>
            {withCurrent(PAY_TYPES, form.salary_type).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Currency">
          <CurrencySelect value={form.currency} onChange={(currency) => set({ currency })} />
        </Field>
        <Field
          label="Base salary" error={errors.base_salary}
          hint={person
            ? 'Used the next time payroll is generated. Payments already created keep their amount.'
            : 'The amount used when payroll is generated. Each payment can still be changed.'}
        >
          <input
            type="number" min="0" step="any" inputMode="decimal" className="input-num" placeholder="0.00"
            value={form.base_salary} onChange={(e) => set({ base_salary: e.target.value })}
          />
        </Field>
        {person && (
          <Field label="Status" hint="Inactive people are skipped when payroll is generated">
            <select className="input" value={form.status} onChange={(e) => set({ status: e.target.value as Payee['status'] })}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </Field>
        )}
        <Field label="Bank details" className="form-full" hint="Shown only here, for making the transfer">
          <textarea
            className="input resize-y" rows={3} maxLength={1000} placeholder="Bank, branch, account name and number"
            value={form.bank_details} onChange={(e) => set({ bank_details: e.target.value })}
          />
        </Field>
        <Field label="Notes" className="form-full">
          <textarea className="input resize-y" rows={2} maxLength={2000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </form>
      <datalist id="payroll-departments">
        {departments.map((d) => <option key={d} value={d} />)}
      </datalist>
    </Modal>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Salaries() {
  const { baseCurrency } = useSettings()
  const confirm = useConfirm()

  const [tab, setTab] = useState<TabId>('payments')
  const [month, setMonth] = useState(thisMonthISO)

  const [people, setPeople] = useState<Payee[] | null>(null)
  const [peopleError, setPeopleError] = useState<string | null>(null)
  const [departments, setDepartments] = useState<string[]>([])
  const [search, setSearch] = useState('')

  // Rows are stored with the month they belong to, so another month never shows them.
  const [payments, setPayments] = useState<{ month: string; rows: SalaryPayment[] } | null>(null)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)

  const [bulkBusy, setBulkBusy] = useState<'generate' | 'payAll' | 'clear' | null>(null)
  const [rowBusy, setRowBusy] = useState<{ id: number; action: 'unpay' | 'delete' } | null>(null)
  const [personBusy, setPersonBusy] = useState<number | null>(null)

  const [paymentForm, setPaymentForm] = useState<{ payment: SalaryPayment | null } | null>(null)
  const [payTarget, setPayTarget] = useState<SalaryPayment | null>(null)
  const [slipTarget, setSlipTarget] = useState<SalaryPayment | null>(null)
  const [personForm, setPersonForm] = useState<{ person: Payee | null } | null>(null)

  const monthRef = useRef(month)
  monthRef.current = month
  // Request counters: a response is ignored when a newer request has been issued.
  const paymentsSeq = useRef(0)
  const peopleSeq = useRef(0)
  // What is on screen, so a failed refresh can keep it instead of replacing it with an error.
  const shownMonth = useRef<string | null>(null)
  const peopleShown = useRef(false)

  const loadPeople = useCallback(async () => {
    const seq = ++peopleSeq.current
    try {
      const [list, saved] = await Promise.all([
        payeeApi.list(),
        // Suggestions only: when this call fails they are taken from the list itself.
        payeeApi.departments().catch(() => null),
      ])
      if (seq !== peopleSeq.current) return
      peopleShown.current = true
      setPeople(list)
      setDepartments(saved ?? departmentsOf(list))
      setPeopleError(null)
    } catch (err) {
      if (seq !== peopleSeq.current) return
      const message = errorMessage(err, 'Could not load the people on payroll')
      // A failed refresh keeps the list already on screen.
      if (peopleShown.current) toast.error(message)
      else setPeopleError(message)
    }
  }, [])

  const loadPayments = useCallback(async (ym: string) => {
    const seq = ++paymentsSeq.current
    try {
      const rows = await salaryApi.list({ month: ym })
      if (seq !== paymentsSeq.current) return
      shownMonth.current = ym
      setPayments({ month: ym, rows })
      setPaymentsError(null)
    } catch (err) {
      if (seq !== paymentsSeq.current) return
      const message = errorMessage(err, 'Could not load the payments for this month')
      if (shownMonth.current === ym) toast.error(message)
      else setPaymentsError(message)
    }
  }, [])

  /** Reloads whichever month is on screen now (it may have changed while a request was running). */
  const refreshPayments = useCallback(() => loadPayments(monthRef.current), [loadPayments])

  useEffect(() => {
    loadPeople()
  }, [loadPeople])

  useEffect(() => {
    setPaymentsError(null)
    loadPayments(month)
  }, [month, loadPayments])

  const rows = payments && payments.month === month ? payments.rows : null
  const paymentsLoading = rows === null && !paymentsError
  const monthLabel = formatMonth(month)

  const summary = useMemo(() => {
    const list = rows || []
    const paid = list.filter((r) => r.status === 'Paid')
    const pending = list.filter((r) => r.status !== 'Paid')
    const currencies = new Set(list.map((r) => r.currency))
    return {
      total: list.length,
      paidCount: paid.length,
      pendingCount: pending.length,
      paidTotals: netByCurrency(paid, baseCurrency),
      pendingTotals: netByCurrency(pending, baseCurrency),
      zeroCurrency: currencies.size === 1 ? list[0].currency : baseCurrency,
    }
  }, [rows, baseCurrency])

  const activeCount = useMemo(() => (people || []).filter((p) => p.status === 'Active').length, [people])

  // Active people who would get a payment from "Generate payroll" (same matching
  // as the server). Only decides which toolbar button is highlighted.
  const leftToGenerate = useMemo(() => {
    if (!rows || !people) return null
    const linked = new Set(rows.filter((r) => r.employee_id).map((r) => r.employee_id))
    const unlinked = new Set(rows.filter((r) => !r.employee_id).map((r) => nameKey(r.employee_name)))
    return people.filter((p) => p.status === 'Active' && !linked.has(p.id) && !unlinked.has(nameKey(p.name))).length
  }, [rows, people])

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!people || !q) return people || []
    return people.filter((p) => [p.name, p.email, p.position, p.department].some((v) => (v || '').toLowerCase().includes(q)))
  }, [people, search])

  /** '' when the person has no address, null when the list of people is not loaded. */
  const emailOf = (r: SalaryPayment) => {
    if (!people) return null
    return (r.employee_id && people.find((p) => p.id === r.employee_id)?.email) || ''
  }

  // ── Month actions ──────────────────────────────────────────────────────────

  async function generate() {
    setBulkBusy('generate')
    try {
      const res = await salaryApi.generate(month)
      toast.success(res.message)
      await refreshPayments()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not generate the payroll'))
    } finally {
      setBulkBusy(null)
    }
  }

  async function payAll() {
    const ok = await confirm({
      title: 'Pay all pending salaries?',
      message: `${plural(summary.pendingCount, 'pending payment', 'pending payments')} for ${monthLabel} `
        + `(${listTotals(summary.pendingTotals)}) will be marked as paid with today’s date and added to Expenses. `
        + 'Salary slips are not emailed from here; send them from each row afterwards.',
      confirmLabel: 'Mark all as paid',
    })
    if (!ok) return
    setBulkBusy('payAll')
    try {
      const res = await salaryApi.payAll(month)
      if (res.count > 0) toast.success(res.message)
      else toast(res.message)
      await refreshPayments()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not mark the salaries as paid'))
    } finally {
      setBulkBusy(null)
    }
  }

  async function clearPending() {
    const ok = await confirm({
      title: 'Clear pending payments?',
      message: `${plural(summary.pendingCount, 'pending payment', 'pending payments')} for ${monthLabel} will be deleted. `
        + 'Paid salaries are not affected, and you can generate payroll again afterwards.',
      confirmLabel: 'Delete pending',
      tone: 'danger',
    })
    if (!ok) return
    setBulkBusy('clear')
    try {
      const res = await salaryApi.clearPending(month)
      toast.success(`Deleted ${plural(res.count, 'pending payment', 'pending payments')} for ${monthLabel}`)
      await refreshPayments()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not clear the pending payments'))
    } finally {
      setBulkBusy(null)
    }
  }

  function exportPayments() {
    if (!rows || rows.length === 0) return
    exportCsv<SalaryPayment>(`payroll-${month}.csv`, [
      { header: 'Person', value: (r) => r.employee_name },
      { header: 'Position', value: (r) => r.position },
      { header: 'Department', value: (r) => r.department },
      { header: 'Month', value: (r) => r.payment_month },
      { header: 'Currency', value: (r) => r.currency },
      { header: 'Base', value: (r) => r.base_salary },
      { header: 'Bonuses', value: (r) => r.bonuses },
      { header: 'Deductions', value: (r) => r.deductions },
      { header: 'Net', value: (r) => r.net_salary },
      { header: 'Method', value: (r) => r.payment_method },
      { header: 'Paid on', value: (r) => (r.status === 'Paid' ? r.payment_date : '') },
      { header: 'Status', value: (r) => r.status },
      { header: 'Slip sent', value: (r) => (r.slip_sent ? 'Yes' : 'No') },
      { header: 'Notes', value: (r) => r.notes },
    ], rows)
  }

  // ── Row actions ────────────────────────────────────────────────────────────

  async function unpay(r: SalaryPayment) {
    const ok = await confirm({
      title: 'Mark this salary as unpaid?',
      message: `The ${formatMonth(r.payment_month)} salary for ${r.employee_name} goes back to pending, and the payroll expense `
        + `for that month is reduced by ${formatMoney(r.net_salary, r.currency)}.`,
      confirmLabel: 'Mark as unpaid',
    })
    if (!ok) return
    setRowBusy({ id: r.id, action: 'unpay' })
    try {
      const res = await salaryApi.unpay(r.id)
      toast.success(res.message)
      await refreshPayments()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not mark this salary as unpaid'))
    } finally {
      setRowBusy(null)
    }
  }

  async function removePayment(r: SalaryPayment) {
    const ok = await confirm({
      title: 'Delete this payment?',
      message: r.status === 'Paid'
        ? `The paid ${formatMonth(r.payment_month)} salary for ${r.employee_name} will be deleted, and the payroll expense `
          + `for that month is reduced by ${formatMoney(r.net_salary, r.currency)}. This cannot be undone.`
        : `The pending ${formatMonth(r.payment_month)} payment for ${r.employee_name} will be deleted.`,
      confirmLabel: 'Delete payment',
      tone: 'danger',
    })
    if (!ok) return
    setRowBusy({ id: r.id, action: 'delete' })
    try {
      await salaryApi.delete(r.id)
      toast.success('Payment deleted')
      await refreshPayments()
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete this payment'))
    } finally {
      setRowBusy(null)
    }
  }

  function paymentSaved(savedMonth: string) {
    setPaymentForm(null)
    // A payment added to another month opens that month, so it is visible straight away.
    if (savedMonth !== month && monthInRange(savedMonth)) setMonth(savedMonth)
    else void refreshPayments()
  }

  async function removePerson(p: Payee) {
    const ok = await confirm({
      title: `Remove ${p.name} from payroll?`,
      message: 'Their past payments are kept and stay in the payroll history. '
        + 'To stop paying someone without removing them, set their status to Inactive instead.',
      confirmLabel: 'Remove person',
      tone: 'danger',
    })
    if (!ok) return
    setPersonBusy(p.id)
    try {
      const res = await payeeApi.delete(p.id)
      toast.success(res.message)
      // Their payments stay but are no longer linked to a person.
      await Promise.all([loadPeople(), refreshPayments()])
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove this person'))
    } finally {
      setPersonBusy(null)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const tabs: TabItem<TabId>[] = [
    { id: 'payments', label: 'Payments', icon: Wallet },
    { id: 'people', label: 'People', icon: Users, count: people ? people.length : undefined },
  ]
  const generateIsNextStep = leftToGenerate !== 0
  // One change at a time: month actions and row actions lock each other while a request runs.
  const working = bulkBusy !== null || rowBusy !== null
  const dash = <span className="text-ink-3">—</span>

  return (
    <div className="page">
      <PageHeader
        title="Payroll"
        description="Monthly salary payments. Paid salaries are added to Expenses automatically."
      />
      <Tabs<TabId> tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'payments' && (
        <>
          <Toolbar className="justify-between">
            <MonthStepper value={month} onChange={setMonth} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary" onClick={exportPayments} disabled={!rows || rows.length === 0}>
                <Download size={15} /> Export CSV
              </button>
              {summary.pendingCount > 0 && (
                <>
                  <button type="button" className="btn-danger" onClick={clearPending} disabled={working}>
                    {bulkBusy === 'clear' ? <Spinner /> : <Eraser size={15} />}
                    Clear pending
                  </button>
                  <button
                    type="button" className={generateIsNextStep ? 'btn-secondary' : 'btn-primary'}
                    onClick={payAll} disabled={working}
                  >
                    {bulkBusy === 'payAll' ? <Spinner /> : <CheckCheck size={15} />}
                    Pay all pending
                  </button>
                </>
              )}
              <button type="button" className="btn-secondary" onClick={() => setPaymentForm({ payment: null })}>
                <Plus size={15} /> Add payment
              </button>
              <button
                type="button" className={generateIsNextStep ? 'btn-primary' : 'btn-secondary'}
                onClick={generate} disabled={working}
                title="Creates a pending payment for every active person who does not have one yet"
              >
                {bulkBusy === 'generate' ? <Spinner /> : <CalendarPlus size={15} />}
                Generate payroll for {monthLabel}
              </button>
            </div>
          </Toolbar>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              label="People paid" icon={Users} loading={paymentsLoading}
              value={rows ? `${summary.paidCount} / ${summary.total}` : '—'}
              hint={!rows ? undefined
                : summary.total === 0 ? 'No payments for this month yet'
                : summary.pendingCount === 0 ? 'Everyone is paid'
                : `${plural(summary.pendingCount, 'payment', 'payments')} still pending`}
            />
            <StatCard
              label="Paid so far" icon={CheckCircle2} tone="good" loading={paymentsLoading}
              value={rows ? <CurrencyTotals totals={summary.paidTotals} zeroCurrency={summary.zeroCurrency} /> : '—'}
              hint={!rows ? undefined : summary.paidCount > 0 ? 'Recorded in Expenses as payroll' : 'Nothing paid yet'}
            />
            <StatCard
              label="Still to pay" icon={Clock} tone={summary.pendingCount > 0 ? 'warn' : 'neutral'} loading={paymentsLoading}
              value={rows ? <CurrencyTotals totals={summary.pendingTotals} zeroCurrency={summary.zeroCurrency} /> : '—'}
              hint={!rows ? undefined
                : summary.pendingCount > 0 ? plural(summary.pendingCount, 'pending payment', 'pending payments')
                : 'Nothing pending'}
            />
          </div>

          <div className="table-wrap">
            {rows === null ? (
              paymentsError
                ? <ErrorState message={paymentsError} onRetry={() => { setPaymentsError(null); loadPayments(month) }} />
                : <TableSkeleton rows={6} cols={8} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title={`No payments for ${monthLabel}`}
                description="Add the people you pay on the People tab first, then press “Generate payroll” to create a pending payment for each active person."
                action={people && activeCount === 0 ? (
                  <button type="button" className="btn-primary" onClick={() => setTab('people')}>
                    <Users size={15} /> Go to people
                  </button>
                ) : (
                  <button type="button" className="btn-primary" onClick={generate} disabled={working}>
                    {bulkBusy === 'generate' ? <Spinner /> : <CalendarPlus size={15} />}
                    Generate payroll for {monthLabel}
                  </button>
                )}
              />
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <caption className="sr-only">Salary payments for {monthLabel}</caption>
                  <thead>
                    <tr>
                      <th className="th">Person</th>
                      <th className="th-num">Base</th>
                      <th className="th-num">Bonuses</th>
                      <th className="th-num">Deductions</th>
                      <th className="th-num">Net</th>
                      <th className="th">Method</th>
                      <th className="th">Paid on</th>
                      <th className="th">Status</th>
                      <th className="th-num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const running = rowBusy?.id === r.id ? rowBusy.action : null
                      const paid = r.status === 'Paid'
                      return (
                        <tr key={r.id} className="tr">
                          <td className="td td-strong">
                            <div className="max-w-[220px] truncate" title={r.employee_name}>{r.employee_name}</div>
                            {r.position && (
                              <div className="max-w-[220px] truncate text-xs font-normal text-ink-3" title={r.position}>{r.position}</div>
                            )}
                          </td>
                          <td className="td-num"><Money amount={r.base_salary} currency={r.currency} /></td>
                          <td className="td-num">{r.bonuses > 0 ? <Money amount={r.bonuses} currency={r.currency} /> : dash}</td>
                          <td className="td-num">{r.deductions > 0 ? <Money amount={r.deductions} currency={r.currency} /> : dash}</td>
                          <td className="td-num td-strong"><Money amount={r.net_salary} currency={r.currency} /></td>
                          <td className="td whitespace-nowrap">{r.payment_method || dash}</td>
                          <td className="td whitespace-nowrap">{paid ? formatDate(r.payment_date) : dash}</td>
                          <td className="td">
                            <div className="flex items-center gap-1.5">
                              <StatusBadge status={r.status} />
                              {r.slip_sent ? <span className="badge-neutral">Slip sent</span> : null}
                            </div>
                          </td>
                          <td className="td">
                            <div className="flex items-center justify-end gap-0.5">
                              {paid ? (
                                <button
                                  type="button" className="btn-icon" disabled={working} onClick={() => unpay(r)}
                                  title="Mark as unpaid" aria-label={`Mark the salary of ${r.employee_name} as unpaid`}
                                >
                                  {running === 'unpay' ? <Spinner size={14} /> : <Undo2 size={15} />}
                                </button>
                              ) : (
                                <button
                                  type="button" className="btn-icon text-accent hover:text-accent" disabled={working}
                                  onClick={() => setPayTarget(r)}
                                  title="Pay" aria-label={`Pay ${r.employee_name}`}
                                >
                                  <CheckCircle2 size={15} />
                                </button>
                              )}
                              <button
                                type="button" className="btn-icon" onClick={() => openPdf(salaryApi.pdfUrl(r.id))}
                                title="View slip PDF" aria-label={`View the salary slip of ${r.employee_name}`}
                              >
                                <FileText size={15} />
                              </button>
                              {paid && (
                                <button
                                  type="button" className="btn-icon" disabled={working} onClick={() => setSlipTarget(r)}
                                  title="Email slip" aria-label={`Email the salary slip of ${r.employee_name}`}
                                >
                                  <Mail size={15} />
                                </button>
                              )}
                              <button
                                type="button" className="btn-icon" disabled={working} onClick={() => setPaymentForm({ payment: r })}
                                title="Edit" aria-label={`Edit the payment of ${r.employee_name}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button" className="btn-icon-danger" disabled={working} onClick={() => removePayment(r)}
                                title="Delete" aria-label={`Delete the payment of ${r.employee_name}`}
                              >
                                {running === 'delete' ? <Spinner size={14} /> : <Trash2 size={15} />}
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
        </>
      )}

      {tab === 'people' && (
        <>
          <Toolbar className="justify-between">
            <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
              <SearchInput value={search} onChange={setSearch} placeholder="Search people" className="w-full sm:w-72" />
              {people && people.length > 0 && (
                <span className="text-xs text-ink-3">
                  <span className="num">{activeCount}</span> active
                  {people.length > activeCount && <> · <span className="num">{people.length - activeCount}</span> inactive</>}
                </span>
              )}
            </div>
            <button type="button" className="btn-primary" onClick={() => setPersonForm({ person: null })}>
              <Plus size={15} /> Add person
            </button>
          </Toolbar>

          <div className="table-wrap">
            {people === null ? (
              peopleError
                ? <ErrorState message={peopleError} onRetry={() => { setPeopleError(null); loadPeople() }} />
                : <TableSkeleton rows={5} cols={6} />
            ) : people.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No people yet"
                description="Add everyone you pay each month. Payroll for a month is generated from the active people on this list."
                action={
                  <button type="button" className="btn-primary" onClick={() => setPersonForm({ person: null })}>
                    <Plus size={15} /> Add person
                  </button>
                }
              />
            ) : filteredPeople.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No people match your search"
                description="Try a different name, position, department or email."
                action={<button type="button" className="btn-secondary" onClick={() => setSearch('')}>Clear search</button>}
              />
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <caption className="sr-only">People on payroll</caption>
                  <thead>
                    <tr>
                      <th className="th">Name</th>
                      <th className="th">Position</th>
                      <th className="th">Department</th>
                      <th className="th">Pay type</th>
                      <th className="th-num">Base salary</th>
                      <th className="th">Status</th>
                      <th className="th-num">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPeople.map((p) => {
                      const busy = personBusy === p.id
                      return (
                        <tr key={p.id} className="tr">
                          <td className="td td-strong">
                            <div className="max-w-[240px] truncate" title={p.name}>{p.name}</div>
                            {p.email && (
                              <div className="max-w-[240px] truncate text-xs font-normal text-ink-3" title={p.email}>{p.email}</div>
                            )}
                          </td>
                          <td className="td">
                            {p.position ? <div className="max-w-[200px] truncate" title={p.position}>{p.position}</div> : dash}
                          </td>
                          <td className="td">
                            {p.department ? <div className="max-w-[200px] truncate" title={p.department}>{p.department}</div> : dash}
                          </td>
                          <td className="td whitespace-nowrap">{p.salary_type || 'Monthly'}</td>
                          <td className="td-num"><Money amount={p.base_salary} currency={p.currency || baseCurrency} /></td>
                          <td className="td"><StatusBadge status={p.status} /></td>
                          <td className="td">
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                type="button" className="btn-icon" disabled={busy} onClick={() => setPersonForm({ person: p })}
                                title="Edit" aria-label={`Edit ${p.name}`}
                              >
                                <Pencil size={15} />
                              </button>
                              <button
                                type="button" className="btn-icon-danger" disabled={busy} onClick={() => removePerson(p)}
                                title="Delete" aria-label={`Remove ${p.name} from payroll`}
                              >
                                {busy ? <Spinner size={14} /> : <Trash2 size={15} />}
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
        </>
      )}

      {paymentForm && (
        <PaymentFormModal
          payment={paymentForm.payment}
          month={month}
          monthRows={rows || []}
          people={people}
          defaultCurrency={baseCurrency}
          onClose={() => setPaymentForm(null)}
          onSaved={paymentSaved}
        />
      )}
      {payTarget && (
        <PayModal
          payment={payTarget}
          email={emailOf(payTarget)}
          onClose={() => setPayTarget(null)}
          onPaid={() => { setPayTarget(null); void refreshPayments() }}
        />
      )}
      {slipTarget && (
        <SlipEmailModal
          payment={slipTarget}
          defaultEmail={emailOf(slipTarget)}
          onClose={() => setSlipTarget(null)}
          onSent={() => { setSlipTarget(null); void refreshPayments() }}
        />
      )}
      {personForm && (
        <PersonFormModal
          person={personForm.person}
          departments={departments}
          defaultCurrency={baseCurrency}
          onClose={() => setPersonForm(null)}
          onSaved={() => { setPersonForm(null); void loadPeople() }}
        />
      )}
    </div>
  )
}
