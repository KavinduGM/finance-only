import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowDownLeft, ArrowUpRight, BarChart3, CheckCircle2, Download, Gift, Layers, MinusCircle, Percent, Printer,
  Receipt, RefreshCw, Scale, Tags, TrendingUp, Trophy, Users, Wallet,
} from 'lucide-react'
import { reportApi } from '../services/api'
import type { Expense, InvoiceStatus, SalaryPayment } from '../services/api'
import {
  BarList, ChartCard, ChartLegend, ColumnChart, EmptyState, ErrorState, Money, PageHeader, Segmented, Spinner,
  StatCard, StatusBadge, TableSkeleton, Tabs, Toolbar,
} from '../components/ui'
import type { BarListItem, Series, SeriesColor, TabItem } from '../components/ui'
import { useSettings } from '../context/SettingsContext'
import { exportCsv } from '../lib/files'
import {
  errorMessage, formatDate, formatMonth, formatNumber, thisMonthISO, thisYear, todayISO,
} from '../lib/format'

// ── Report shapes (GET /api/reports/*) ───────────────────────────────────────
// The server has already converted every total to `base_currency`.

type DateRange = { from: string; to: string }
interface MonthTotal { month: string; total: number }
interface ClientTotal { client_name: string; total: number; count: number }

interface ProfitLossReport {
  base_currency: string
  startDate: string
  endDate: string
  revenue: number
  revenueByService: { service_type: string; total: number }[]
  /** One line per category; payroll is the 'Salaries' line. */
  expenses: { category: string; total: number }[]
  /** Payroll included: never add salaries on top of this. */
  totalExpenses: number
  netProfit: number
  profitMargin: number
}

interface IncomeReport {
  base_currency: string
  total: number
  byClient: ClientTotal[]
  byService: { service_type: string; total: number }[]
  byMonth: MonthTotal[]
  period: DateRange
}

interface ExpenseReport {
  base_currency: string
  total: number
  byCategory: { category: string; total: number; count: number }[]
  byMonth: MonthTotal[]
  items: (Expense & { amount_base: number })[]
  period: DateRange
}

interface CashflowReport {
  base_currency: string
  year: number
  months: { month: string; label: string; inflow: number; outflow: number; net: number; cumulative: number }[]
  totals: { inflow: number; outflow: number; net: number }
}

type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

interface UnpaidInvoice {
  id: number
  invoice_number: string
  client_name: string
  issue_date: string
  due_date: string
  days_overdue: number
  total: number
  currency: string
  total_base: number
  status: InvoiceStatus
}

interface ReceivablesReport {
  base_currency: string
  as_of: string
  total: number
  buckets: Record<AgeBucket, number>
  invoices: UnpaidInvoice[]
  byClient: ClientTotal[]
}

interface PayrollReport {
  base_currency: string
  month: string
  records: SalaryPayment[]
  totals: {
    total_bonuses: number
    total_deductions: number
    total_net: number
    count: number
    paid_count: number
    pending_count: number
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

type TabId = 'pl' | 'income' | 'expenses' | 'cashflow' | 'receivables' | 'payroll'
type PlMode = 'month' | 'year'

const TABS: TabItem<TabId>[] = [
  { id: 'pl', label: 'Profit & loss' },
  { id: 'income', label: 'Income' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'cashflow', label: 'Cash flow' },
  { id: 'receivables', label: 'Receivables' },
  { id: 'payroll', label: 'Payroll' },
]

const PL_MODES: { id: PlMode; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]

const INCOME_SERIES: Series[] = [{ key: 'total', label: 'Income', color: 'income' }]
const EXPENSE_SERIES: Series[] = [{ key: 'total', label: 'Expenses', color: 'expense' }]
const CASH_SERIES: Series[] = [
  { key: 'inflow', label: 'Money in', color: 'income' },
  { key: 'outflow', label: 'Money out', color: 'expense' },
]

const AGE_BUCKETS: { id: AgeBucket; label: string }[] = [
  { id: 'current', label: 'Not yet due' },
  { id: 'd1_30', label: '1–30 days' },
  { id: 'd31_60', label: '31–60 days' },
  { id: 'd61_90', label: '61–90 days' },
  { id: 'd90_plus', label: '90+ days' },
]

/** A breakdown card lists at most this many bars; the CSV has them all. */
const MAX_BARS = 10
/** A long expense list starts with this many rows on screen. */
const ROW_LIMIT = 100
/** The year select offers this many years, newest first. */
const YEARS_OFFERED = 6

const GRID_4 = 'grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-4'
const GRID_3 = 'grid grid-cols-1 sm:grid-cols-3 gap-4'
const GRID_AGEING = 'grid grid-cols-2 md:grid-cols-3 gap-4'

const NUM = 'td-num whitespace-nowrap'
const FOOT = 'td td-strong border-t border-line border-b-0 bg-surface-2/60'
const FOOT_NUM = 'td-num whitespace-nowrap font-semibold border-t border-line border-b-0 bg-surface-2/60'
const CONTROL_LABEL = 'flex items-center gap-2 text-xs text-ink-3'

// The app shell is a fixed-height frame that scrolls inside. On paper the report
// has to run over as many pages as it needs, without the menu and the top bar.
// Charts are drawn at their screen size, so they are scaled to the paper, and a
// table that breaks across pages repeats its heading but not its total.
const PRINT_CSS = `
@media print {
  aside, header { display: none !important; }
  .app-backdrop, .app-backdrop > div { display: block !important; height: auto !important; overflow: visible !important; }
  .app-backdrop { background: none !important; }
  main { overflow: visible !important; }
  main > div { max-width: none !important; padding: 0 !important; }
  .page { animation: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .card { break-inside: avoid; }
  .table-wrap, .table-scroll { overflow: visible !important; }
  .th, .td { padding-top: 0.4rem !important; padding-bottom: 0.4rem !important; }
  tr { break-inside: avoid; }
  tfoot { display: table-row-group; }
  div:has(> .recharts-responsive-container), .recharts-responsive-container, .recharts-wrapper, .recharts-surface { height: auto !important; }
  .recharts-wrapper { width: 100% !important; }
  .recharts-cartesian-grid line { stroke: rgb(var(--line)) !important; }
  .recharts-cartesian-axis-line { stroke: rgb(var(--line-strong)) !important; }
}`

// ── Helpers ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`
const entries = (n: number) => plural(n, 'entry', 'entries')

/** "12.5%" with a real minus sign; unlike a change figure it carries no plus sign. */
const percentText = (v: number) => `${v < 0 ? '−' : ''}${formatNumber(Math.abs(v), Number.isInteger(v) ? 0 : 1)}%`

/** Amounts go into a CSV as plain numbers so a spreadsheet can add them up. */
const plain = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100

const wholeYear = (): DateRange => ({ from: `${thisYear()}-01-01`, to: `${thisYear()}-12-31` })
const rangeText = ({ from, to }: DateRange) => `${formatDate(from)} – ${formatDate(to)}`

const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

function isDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  // The round trip rejects days that do not exist (30 February).
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** What stops a month from being sent, or null when it is fine. */
function monthProblem(month: string) {
  if (!month) return 'Choose a month'
  return isMonth(month) ? null : 'Enter the month as YYYY-MM'
}

/** What stops a From/To pair from being sent, or null when it is fine. */
function rangeProblem({ from, to }: DateRange) {
  if (!from || !to) return 'Choose both a From and a To date'
  if (!isDate(from) || !isDate(to)) return 'Enter both dates as YYYY-MM-DD'
  if (from > to) return 'The From date must be on or before the To date'
  return null
}

/** A profit and loss report covers one month or one whole year. */
function plPeriod(d: ProfitLossReport) {
  const year = d.startDate.slice(5) === '01-01' && d.endDate.slice(5) === '12-31'
  return year
    ? { label: formatDate(d.startDate, 'yyyy'), tag: d.startDate.slice(0, 4) }
    : { label: formatDate(d.startDate, 'MMMM yyyy'), tag: d.startDate.slice(0, 7) }
}

const monthBars = (months: MonthTotal[]) => months.map((m) => ({ label: formatMonth(m.month, 'MMM yy'), total: m.total }))
const highestMonth = (months: MonthTotal[]) =>
  months.reduce<MonthTotal | null>((top, m) => (m.total > (top?.total ?? 0) ? m : top), null)

// Same day limits as the server uses for the ageing totals.
function ageBucket(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'current'
  if (daysOverdue <= 30) return 'd1_30'
  if (daysOverdue <= 60) return 'd31_60'
  if (daysOverdue <= 90) return 'd61_90'
  return 'd90_plus'
}

/** True when a report came back with nothing in it for the period. */
const isEmpty = {
  pl: (d: ProfitLossReport) => d.revenueByService.length === 0 && d.expenses.length === 0,
  income: (d: IncomeReport) => d.byClient.length === 0,
  expenses: (d: ExpenseReport) => d.items.length === 0,
  cashflow: (d: CashflowReport) => d.months.every((m) => m.inflow === 0 && m.outflow === 0),
  receivables: (d: ReceivablesReport) => d.invoices.length === 0,
  payroll: (d: PayrollReport) => d.records.length === 0,
}

// ── Profit and loss statement ────────────────────────────────────────────────

interface StatementLine {
  kind: 'heading' | 'item' | 'note' | 'net'
  section: 'Income' | 'Expenses' | 'Result'
  label: string
  /** Label in the CSV, where a heading with a figure reads better as a total. */
  exportLabel?: string
  amount: number | null
}

/** The rows of the statement, in the order they are shown and exported. */
function statementLines(d: ProfitLossReport): StatementLine[] {
  const income: StatementLine[] = d.revenueByService.map((s) => (
    { kind: 'item', section: 'Income', label: s.service_type, amount: s.total }
  ))
  // expenses[] already has payroll in it as the 'Salaries' category.
  const expenses: StatementLine[] = d.expenses.map((e) => (
    { kind: 'item', section: 'Expenses', label: e.category, amount: e.total }
  ))
  return [
    { kind: 'heading', section: 'Income', label: 'Income', exportLabel: 'Total income', amount: d.revenue },
    ...(income.length ? income : [{ kind: 'note', section: 'Income', label: 'No income in this period', amount: null } as StatementLine]),
    { kind: 'heading', section: 'Expenses', label: 'Expenses', amount: null },
    ...(expenses.length ? expenses : [{ kind: 'note', section: 'Expenses', label: 'No expenses in this period', amount: null } as StatementLine]),
    { kind: 'heading', section: 'Expenses', label: 'Total expenses', amount: d.totalExpenses },
    { kind: 'net', section: 'Result', label: 'Net profit', amount: d.netProfit },
  ]
}

// ── CSV exports (each returns the number of rows written) ────────────────────

function exportProfitLoss(d: ProfitLossReport) {
  const rows = statementLines(d).filter((line) => line.amount !== null)
  exportCsv<StatementLine>(`profit-and-loss-${plPeriod(d).tag}.csv`, [
    { header: 'Section', value: (l) => l.section },
    { header: 'Line', value: (l) => l.exportLabel || l.label },
    { header: `Amount (${d.base_currency})`, value: (l) => plain(l.amount) },
  ], rows)
  return rows.length
}

interface BreakdownRow { group: string; item: string; count: number | null; amount: number }

function exportIncome(d: IncomeReport) {
  const rows: BreakdownRow[] = [
    ...d.byMonth.map((m) => ({ group: 'By month', item: m.month, count: null, amount: m.total })),
    ...d.byClient.map((c) => ({ group: 'By client', item: c.client_name, count: c.count, amount: c.total })),
    ...d.byService.map((s) => ({ group: 'By service', item: s.service_type, count: null, amount: s.total })),
    { group: 'Total', item: 'Total income', count: d.byClient.reduce((n, c) => n + c.count, 0), amount: d.total },
  ]
  exportCsv<BreakdownRow>(`income-${d.period.from}-to-${d.period.to}.csv`, [
    { header: 'Breakdown', value: (r) => r.group },
    { header: 'Item', value: (r) => r.item },
    { header: 'Entries', value: (r) => r.count },
    { header: `Amount (${d.base_currency})`, value: (r) => plain(r.amount) },
  ], rows)
  return rows.length
}

function exportExpenses(d: ExpenseReport) {
  exportCsv<ExpenseReport['items'][number]>(`expenses-${d.period.from}-to-${d.period.to}.csv`, [
    { header: 'Date', value: (e) => (e.payment_date || '').slice(0, 10) },
    { header: 'Title', value: (e) => e.title },
    { header: 'Category', value: (e) => e.category || 'Uncategorized' },
    { header: 'Vendor', value: (e) => e.vendor },
    { header: 'Amount', value: (e) => plain(e.amount) },
    { header: 'Currency', value: (e) => e.currency || d.base_currency },
    { header: `Amount (${d.base_currency})`, value: (e) => plain(e.amount_base) },
  ], d.items)
  return d.items.length
}

interface CashRow { month: string; inflow: number; outflow: number; net: number; cumulative: number | null }

function exportCashflow(d: CashflowReport) {
  const rows: CashRow[] = [
    ...d.months.map((m) => ({ month: m.month, inflow: m.inflow, outflow: m.outflow, net: m.net, cumulative: m.cumulative })),
    { month: 'Total', ...d.totals, cumulative: null },
  ]
  const base = d.base_currency
  exportCsv<CashRow>(`cash-flow-${d.year}.csv`, [
    { header: 'Month', value: (r) => r.month },
    { header: `Money in (${base})`, value: (r) => plain(r.inflow) },
    { header: `Money out (${base})`, value: (r) => plain(r.outflow) },
    { header: `Net (${base})`, value: (r) => plain(r.net) },
    { header: `Running total (${base})`, value: (r) => (r.cumulative === null ? null : plain(r.cumulative)) },
  ], rows)
  return rows.length
}

function exportReceivables(d: ReceivablesReport) {
  exportCsv<UnpaidInvoice>(`receivables-${d.as_of}.csv`, [
    { header: 'Invoice', value: (i) => i.invoice_number },
    { header: 'Client', value: (i) => i.client_name },
    { header: 'Issued', value: (i) => (i.issue_date || '').slice(0, 10) },
    { header: 'Due date', value: (i) => (i.due_date || '').slice(0, 10) },
    { header: 'Days overdue', value: (i) => i.days_overdue },
    { header: 'Amount', value: (i) => plain(i.total) },
    { header: 'Currency', value: (i) => i.currency },
    { header: `Amount (${d.base_currency})`, value: (i) => plain(i.total_base) },
    { header: 'Status', value: (i) => i.status },
  ], d.invoices)
  return d.invoices.length
}

function exportPayroll(d: PayrollReport) {
  exportCsv<SalaryPayment>(`payroll-${d.month}.csv`, [
    { header: 'Person', value: (r) => r.employee_name },
    { header: 'Position', value: (r) => r.position },
    { header: 'Base', value: (r) => plain(r.base_salary) },
    { header: 'Bonuses', value: (r) => plain(r.bonuses) },
    { header: 'Deductions', value: (r) => plain(r.deductions) },
    { header: 'Net', value: (r) => plain(r.net_salary) },
    { header: 'Currency', value: (r) => r.currency || d.base_currency },
    { header: 'Status', value: (r) => r.status },
    { header: 'Paid on', value: (r) => (r.payment_date || '').slice(0, 10) },
  ], d.records)
  return d.records.length
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** Follows a value once it has stopped changing, so typing a date sends one request. */
function useDebounced<T>(value: T, ms = 300) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

type ReportParams = Record<string, string | number>
/** For a report without period controls. */
const NO_PARAMS: ReportParams = {}

interface Report<T> {
  data: T | null
  /** Set when a load failed and there is nothing to show for the period asked for. */
  error: string | null
  fetching: boolean
  /** Loads the same period again; `announce` confirms a manual refresh. */
  reload: (announce?: boolean) => void
}

/**
 * One report tab. Nothing is requested until the tab is first opened; after
 * that it loads again whenever its period changes. `params` is null while the
 * period controls hold something that cannot be sent.
 */
function useReport<T>(
  open: boolean,
  params: ReportParams | null,
  request: (params: ReportParams) => Promise<T>,
  name: string,
): Report<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; fetching: boolean }>(
    { data: null, error: null, fetching: false },
  )
  const key = params ? JSON.stringify(params) : null
  // Only the newest request may update the tab; an answer that arrives late is dropped.
  const ticket = useRef(0)
  /** The period last asked for. */
  const requested = useRef<string | null>(null)
  /** The period the figures on screen belong to. */
  const shown = useRef<string | null>(null)

  const run = useCallback(async (forKey: string, announce = false) => {
    const id = (ticket.current += 1)
    requested.current = forKey
    setState((s) => ({ data: s.data, error: null, fetching: true }))
    try {
      const body = await request(JSON.parse(forKey))
      if (id !== ticket.current) return
      shown.current = forKey
      setState({ data: body, error: null, fetching: false })
      if (announce) toast.success('Report updated')
    } catch (err) {
      if (id !== ticket.current) return
      const message = errorMessage(err, `Could not load the ${name}`)
      if (shown.current === forKey) {
        // A refresh of what is on screen failed: keep the figures and say so.
        toast.error(message)
        setState((s) => ({ ...s, fetching: false }))
      } else {
        // The figures on screen belong to another period; do not leave them standing under this one.
        shown.current = null
        setState({ data: null, error: message, fetching: false })
      }
    }
  }, [request, name])

  useEffect(() => {
    if (open && key !== null && key !== requested.current) run(key)
  }, [open, key, run])

  // Leaving the page: an answer still on its way has nowhere to land.
  useEffect(() => () => {
    ticket.current += 1
    requested.current = null
  }, [])

  const reload = useCallback((announce = false) => {
    const target = key ?? requested.current
    if (target !== null) run(target, announce)
  }, [key, run])

  return { ...state, reload }
}

/** Money formatters tied to the currency a report was converted to. */
function useBaseMoney(base: string) {
  const { money, moneyCompact } = useSettings()
  return {
    full: (amount: number) => money(amount, base),
    compact: (amount: number) => moneyCompact(amount, base),
  }
}

/** Paper is white: print with the light theme whatever the screen uses. */
function usePrintInLightTheme() {
  useEffect(() => {
    const root = document.documentElement
    let screenTheme: string | null = null
    const before = () => {
      if (screenTheme !== null) return
      screenTheme = root.getAttribute('data-theme') || 'dark'
      root.setAttribute('data-theme', 'light')
    }
    const after = () => {
      if (screenTheme === null) return
      root.setAttribute('data-theme', screenTheme)
      screenTheme = null
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      after()
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])
}

// ── Small pieces ─────────────────────────────────────────────────────────────

/** A stat card hint that may run onto a second line in a narrow card instead of being cut off. */
function Note({ children }: { children: React.ReactNode }) {
  return <span className="whitespace-normal">{children}</span>
}

/** Title block of a table card. */
function CardHead({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-4">
      <div className="min-w-0">
        <h3 className="card-title">{title}</h3>
        {sub && <p className="card-sub">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

/** The period controls of a tab, with a spinner while it reloads and the reason when it cannot. */
function PeriodBar({ busy, problem, children }: { busy: boolean; problem?: string | null; children: React.ReactNode }) {
  return (
    <Toolbar className="no-print">
      {children}
      {busy && (
        <span role="status" aria-label="Updating the report" className="inline-flex text-ink-3">
          <Spinner />
        </span>
      )}
      {problem && <p role="alert" className="w-full text-xs text-bad">{problem}</p>}
    </Toolbar>
  )
}

function MonthInput({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  return (
    <label className={CONTROL_LABEL}>
      Month
      <input
        type="month" className="input w-[10.5rem]" placeholder="YYYY-MM"
        value={value} onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function YearSelect({ value, onChange }: { value: number; onChange: (year: number) => void }) {
  const newest = thisYear()
  return (
    <label className={CONTROL_LABEL}>
      Year
      <select className="input w-auto" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: YEARS_OFFERED }, (_, i) => newest - i).map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </label>
  )
}

function RangeInputs({ range, onChange }: { range: DateRange; onChange: (range: DateRange) => void }) {
  return (
    <>
      <label className={CONTROL_LABEL}>
        From
        <input
          type="date" className="input w-[9.5rem]" value={range.from} max={range.to || undefined}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
        />
      </label>
      <label className={CONTROL_LABEL}>
        To
        <input
          type="date" className="input w-[9.5rem]" value={range.to} min={range.from || undefined}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
        />
      </label>
    </>
  )
}

/** Ranked bars in a card, cut to the largest few with a note about the rest. */
function BreakdownCard({ title, subtitle, items, noun, color, format, max = MAX_BARS, className }: {
  title: string
  subtitle: string
  items: BarListItem[]
  /** What the bars are, in the plural ("clients"), for the note when some are left out. */
  noun: string
  color: SeriesColor
  format: (value: number) => string
  max?: number
  className?: string
}) {
  return (
    <ChartCard title={title} subtitle={subtitle} className={className}>
      <BarList items={items.slice(0, max)} format={format} color={color} />
      {items.length > max && (
        <p className="text-xs text-ink-3 mt-4">
          Showing the {max} largest of {formatNumber(items.length)} {noun}
        </p>
      )}
    </ChartCard>
  )
}

/** First load, failure, nothing for the period, or the report itself. */
function ReportBody<T>({ report, labels, grid, empty, isEmpty: nothingIn, children }: {
  report: Report<T>
  /** Stat card labels, shown with placeholders during the first load. */
  labels: string[]
  /** Grid classes of the stat card row. */
  grid: string
  isEmpty: (data: T) => boolean
  empty: (data: T) => React.ReactNode
  children: (data: T) => React.ReactNode
}) {
  if (report.error) {
    return (
      <div className="card">
        <ErrorState message={report.error} onRetry={() => report.reload()} />
      </div>
    )
  }
  if (!report.data) {
    return (
      <div className="space-y-5" aria-busy="true">
        <span className="sr-only" role="status">Loading the report</span>
        <div className={grid}>
          {labels.map((label) => <StatCard key={label} label={label} value="" loading />)}
        </div>
        <div className="table-wrap">
          <TableSkeleton rows={8} cols={4} />
        </div>
      </div>
    )
  }
  // While another period loads, the previous figures stay on screen, dimmed.
  return (
    <div className={`space-y-5 transition-opacity ${report.fetching ? 'opacity-60' : ''}`} aria-busy={report.fetching}>
      {nothingIn(report.data) ? <div className="card">{empty(report.data)}</div> : children(report.data)}
    </div>
  )
}

// ── Profit and loss ──────────────────────────────────────────────────────────

function StatementRow({ line, format }: { line: StatementLine; format: (amount: number) => string }) {
  const amount = line.amount === null ? null : format(line.amount)
  if (line.kind === 'note') {
    return (
      <tr>
        <td colSpan={2} className="td pl-10 text-ink-3">{line.label}</td>
      </tr>
    )
  }
  if (line.kind === 'item') {
    return (
      <tr className="tr">
        <th scope="row" className="td pl-10 text-left font-normal">
          <div className="max-w-[420px] truncate" title={line.label}>{line.label}</div>
        </th>
        <td className={`${NUM} text-ink-2`}>{amount}</td>
      </tr>
    )
  }
  if (line.kind === 'net') {
    const loss = (line.amount ?? 0) < 0
    return (
      <tr className="bg-surface-2/60">
        <th scope="row" className="td border-b-0 text-left text-ink font-bold">{line.label}</th>
        <td className={`${NUM} border-b-0 text-base font-bold ${loss ? 'text-bad' : 'text-accent'}`}>{amount}</td>
      </tr>
    )
  }
  return (
    <tr>
      <th scope="row" className="td td-strong text-left">{line.label}</th>
      <td className={`${NUM} font-semibold`}>{amount}</td>
    </tr>
  )
}

function ProfitLossView({ data }: { data: ProfitLossReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const loss = data.netProfit < 0
  const hasIncome = data.revenue > 0

  return (
    <>
      <div className={GRID_4}>
        <StatCard label="Income" icon={TrendingUp} value={compact(data.revenue)} hint={full(data.revenue)} />
        {/* totalExpenses already includes payroll. */}
        <StatCard
          label="Total expenses" icon={Receipt}
          value={compact(data.totalExpenses)} hint={full(data.totalExpenses)}
        />
        <StatCard
          label="Net profit" icon={Scale} tone={loss ? 'bad' : 'neutral'}
          value={<span className={loss ? 'text-bad' : undefined}>{compact(data.netProfit)}</span>}
          hint={full(data.netProfit)}
        />
        <StatCard
          label="Margin" icon={Percent}
          value={hasIncome ? percentText(data.profitMargin) : '—'}
          hint={<Note>{hasIncome ? 'Net profit as a share of income' : 'No income in this period'}</Note>}
        />
      </div>

      <section className="table-wrap">
        <CardHead
          title={`Statement for ${plPeriod(data).label}`}
          sub={`${rangeText({ from: data.startDate, to: data.endDate })} · amounts in ${data.base_currency}`}
        />
        <div className="table-scroll border-t border-line">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Line</th>
                <th scope="col" className="th-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {statementLines(data).map((line) => (
                <StatementRow key={`${line.section}:${line.kind}:${line.label}`} line={line} format={full} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// ── Income ───────────────────────────────────────────────────────────────────

function IncomeView({ data }: { data: IncomeReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const scope = `Received, in ${data.base_currency} · ${rangeText(data.period)}`
  const payments = data.byClient.reduce((n, c) => n + c.count, 0)
  const topClient = data.byClient[0]
  const best = highestMonth(data.byMonth)

  return (
    <>
      <div className={GRID_4}>
        <StatCard label="Total income" icon={TrendingUp} value={compact(data.total)} hint={full(data.total)} />
        <StatCard
          label="Payments" icon={Layers}
          value={formatNumber(payments)}
          hint={<Note>from {plural(data.byClient.length, 'client')}</Note>}
        />
        <StatCard
          label="Top client" icon={Trophy}
          value={topClient ? <span title={topClient.client_name}>{topClient.client_name}</span> : '—'}
          hint={topClient ? full(topClient.total) : undefined}
        />
        <StatCard
          label="Best month" icon={BarChart3}
          value={best ? compact(best.total) : '—'}
          hint={best ? formatMonth(best.month) : undefined}
        />
      </div>

      {/* The subtitle names the currency, so the axis keeps to bare figures (a symbol wraps its ticks). */}
      <ChartCard title="Income by month" subtitle={scope}>
        <ColumnChart data={monthBars(data.byMonth)} xKey="label" series={INCOME_SERIES} format={full} />
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard
          title="Top clients" subtitle={scope} noun="clients" color="income" format={full}
          items={data.byClient.map((c) => ({ label: c.client_name, value: c.total, hint: entries(c.count) }))}
        />
        <BreakdownCard
          title="By service" subtitle={scope} noun="services" color="income" format={full}
          items={data.byService.map((s) => ({ label: s.service_type, value: s.total }))}
        />
      </div>
    </>
  )
}

// ── Expenses ─────────────────────────────────────────────────────────────────

function ExpensesView({ data }: { data: ExpenseReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const [showAll, setShowAll] = useState(false)
  const base = data.base_currency
  const period = rangeText(data.period)
  const largest = data.byCategory[0]
  const highest = highestMonth(data.byMonth)
  const rows = showAll ? data.items : data.items.slice(0, ROW_LIMIT)

  return (
    <>
      <div className={GRID_4}>
        <StatCard label="Total expenses" icon={Receipt} value={compact(data.total)} hint={full(data.total)} />
        <StatCard
          label="Entries" icon={Layers}
          value={formatNumber(data.items.length)}
          hint={<Note>in {plural(data.byCategory.length, 'category', 'categories')}</Note>}
        />
        <StatCard
          label="Largest category" icon={Tags}
          value={largest ? <span title={largest.category}>{largest.category}</span> : '—'}
          hint={largest ? full(largest.total) : undefined}
        />
        <StatCard
          label="Highest month" icon={BarChart3}
          value={highest ? compact(highest.total) : '—'}
          hint={highest ? formatMonth(highest.month) : undefined}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <ChartCard className="xl:col-span-2" title="Expenses by month" subtitle={`Paid, in ${base} · ${period}`}>
          <ColumnChart data={monthBars(data.byMonth)} xKey="label" series={EXPENSE_SERIES} format={full} />
        </ChartCard>
        <BreakdownCard
          title="By category" subtitle={`In ${base} · payroll is the Salaries line`}
          noun="categories" color="expense" format={full}
          items={data.byCategory.map((c) => ({ label: c.category, value: c.total, hint: entries(c.count) }))}
        />
      </div>

      <section className="table-wrap">
        <CardHead title="Expense entries" sub={`${entries(data.items.length)} · ${period} · newest first`} />
        <div className="table-scroll border-t border-line">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Date</th>
                <th scope="col" className="th">Title</th>
                <th scope="col" className="th">Category</th>
                <th scope="col" className="th">Vendor</th>
                <th scope="col" className="th-num">Amount</th>
                <th scope="col" className="th-num">In {base}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="tr">
                  <td className="td whitespace-nowrap">{formatDate(e.payment_date)}</td>
                  <td className="td td-strong">
                    <div className="max-w-[280px] truncate" title={e.title}>{e.title}</div>
                  </td>
                  <td className="td whitespace-nowrap">{e.category || 'Uncategorized'}</td>
                  <td className="td">
                    {e.vendor
                      ? <div className="max-w-[200px] truncate" title={e.vendor}>{e.vendor}</div>
                      : <span className="text-ink-3">—</span>}
                  </td>
                  {/* The amount as it was paid, then what the report counted it as. */}
                  <td className="td-num"><Money amount={e.amount} currency={e.currency || base} /></td>
                  <td className={NUM}>{full(e.amount_base)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5} className={`${FOOT} text-left`}>Total</th>
                <td className={FOOT_NUM}>{full(data.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {data.items.length > ROW_LIMIT && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-line text-xs text-ink-3">
            <span>
              {showAll
                ? `Showing all ${entries(data.items.length)}`
                : `Showing the newest ${ROW_LIMIT} of ${entries(data.items.length)}; the total and the CSV cover them all`}
            </span>
            <button type="button" className="btn-ghost btn-sm no-print" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show the newest ${ROW_LIMIT} only` : 'Show all'}
            </button>
          </div>
        )}
      </section>
    </>
  )
}

// ── Cash flow ────────────────────────────────────────────────────────────────

function CashflowView({ data }: { data: CashflowReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const base = data.base_currency
  const { inflow, outflow, net } = data.totals
  const tone = (amount: number) => (amount < 0 ? 'text-bad' : '')

  return (
    <>
      <div className={GRID_3}>
        <StatCard label="Money in" icon={ArrowDownLeft} value={compact(inflow)} hint={full(inflow)} />
        <StatCard label="Money out" icon={ArrowUpRight} value={compact(outflow)} hint={full(outflow)} />
        <StatCard
          label="Net cash flow" icon={Scale} tone={net < 0 ? 'bad' : 'neutral'}
          value={<span className={net < 0 ? 'text-bad' : undefined}>{compact(net)}</span>}
          hint={full(net)}
        />
      </div>

      <ChartCard
        title="Money in and out"
        subtitle={`Each month of ${data.year}, in ${base}`}
        right={<ChartLegend series={CASH_SERIES} />}
      >
        <ColumnChart data={data.months} xKey="label" series={CASH_SERIES} format={full} />
      </ChartCard>

      <section className="table-wrap">
        <CardHead
          title={`Cash flow by month, ${data.year}`}
          sub={`Income on the day it was paid, expenses on their payment date · amounts in ${base}`}
        />
        <div className="table-scroll border-t border-line">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Month</th>
                <th scope="col" className="th-num">Money in</th>
                <th scope="col" className="th-num">Money out</th>
                <th scope="col" className="th-num">Net</th>
                <th scope="col" className="th-num">Running total</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.month} className="tr">
                  <th scope="row" className="td td-strong text-left whitespace-nowrap">{formatMonth(m.month)}</th>
                  <td className={NUM}>{full(m.inflow)}</td>
                  <td className={NUM}>{full(m.outflow)}</td>
                  <td className={`${NUM} ${tone(m.net)}`}>{full(m.net)}</td>
                  <td className={`${NUM} ${tone(m.cumulative)}`}>{full(m.cumulative)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={`${FOOT} text-left`}>Total for {data.year}</th>
                <td className={FOOT_NUM}>{full(inflow)}</td>
                <td className={FOOT_NUM}>{full(outflow)}</td>
                <td className={`${FOOT_NUM} ${tone(net)}`}>{full(net)}</td>
                <td className={FOOT_NUM} />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </>
  )
}

// ── Receivables ──────────────────────────────────────────────────────────────

function ReceivablesView({ data }: { data: ReceivablesReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const base = data.base_currency
  // How many invoices sit in each ageing band (a count, so currencies do not matter).
  const counts: Record<AgeBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
  for (const inv of data.invoices) counts[ageBucket(inv.days_overdue)] += 1

  return (
    <>
      <p className="text-xs text-ink-3">
        Sent and overdue invoices that were still unpaid on {formatDate(data.as_of)}
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className={`${GRID_AGEING} xl:col-span-2 content-start`}>
          <StatCard
            label="Total outstanding"
            value={compact(data.total)} hint={full(data.total)}
            footer={<span className="text-xs text-ink-3">{plural(data.invoices.length, 'invoice')}</span>}
          />
          {AGE_BUCKETS.map((bucket) => {
            const amount = data.buckets[bucket.id]
            const late = bucket.id === 'd90_plus' && amount > 0
            return (
              <StatCard
                key={bucket.id}
                label={bucket.label}
                value={<span className={late ? 'text-bad' : undefined}>{compact(amount)}</span>}
                hint={full(amount)}
                footer={<span className="text-xs text-ink-3">{plural(counts[bucket.id], 'invoice')}</span>}
              />
            )
          })}
        </div>
        <BreakdownCard
          title="Owed by client" subtitle={`Unpaid invoices, in ${base}`}
          noun="clients" color="third" format={full} max={6}
          items={data.byClient.map((c) => ({ label: c.client_name, value: c.total, hint: plural(c.count, 'invoice') }))}
        />
      </div>

      <section className="table-wrap">
        <CardHead
          title="Unpaid invoices"
          sub="Oldest due date first"
          right={<Link to="/invoices" className="link text-xs font-medium shrink-0 no-print">Open invoices</Link>}
        />
        <div className="table-scroll border-t border-line">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Invoice</th>
                <th scope="col" className="th">Client</th>
                <th scope="col" className="th">Due date</th>
                <th scope="col" className="th-num">Days overdue</th>
                <th scope="col" className="th-num">Amount</th>
                <th scope="col" className="th-num">In {base}</th>
                <th scope="col" className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((inv) => (
                <tr key={inv.id} className="tr">
                  <td className="td td-strong num whitespace-nowrap">{inv.invoice_number}</td>
                  <td className="td">
                    <div className="max-w-[240px] truncate" title={inv.client_name}>{inv.client_name}</div>
                  </td>
                  <td className="td whitespace-nowrap">{formatDate(inv.due_date)}</td>
                  <td className={NUM}>
                    {inv.days_overdue > 0
                      ? formatNumber(inv.days_overdue)
                      : <span className="text-ink-3" title="Not yet due">—</span>}
                  </td>
                  <td className="td-num"><Money amount={inv.total} currency={inv.currency || base} /></td>
                  <td className={NUM}>{full(inv.total_base)}</td>
                  <td className="td"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5} className={`${FOOT} text-left`}>Total outstanding</th>
                <td className={FOOT_NUM}>{full(data.total)}</td>
                <td className={FOOT} />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </>
  )
}

// ── Payroll ──────────────────────────────────────────────────────────────────

function PayrollView({ data }: { data: PayrollReport }) {
  const { full, compact } = useBaseMoney(data.base_currency)
  const base = data.base_currency
  const t = data.totals

  return (
    <>
      <div className={GRID_4}>
        <StatCard label="Net payroll" icon={Wallet} value={compact(t.total_net)} hint={full(t.total_net)} />
        <StatCard label="Bonuses" icon={Gift} value={compact(t.total_bonuses)} hint={full(t.total_bonuses)} />
        <StatCard
          label="Deductions" icon={MinusCircle}
          value={compact(t.total_deductions)} hint={full(t.total_deductions)}
        />
        <StatCard
          label="People" icon={Users}
          value={formatNumber(t.count)}
          hint={<Note>{formatNumber(t.paid_count)} paid · {formatNumber(t.pending_count)} pending</Note>}
        />
      </div>

      <section className="table-wrap">
        <CardHead
          title={`Payroll for ${formatMonth(data.month)}`}
          sub={`Each row is in the currency it is paid in; the totals above are in ${base}`}
          right={<Link to="/payroll" className="link text-xs font-medium shrink-0 no-print">Open payroll</Link>}
        />
        <div className="table-scroll border-t border-line">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="th">Person</th>
                <th scope="col" className="th">Position</th>
                <th scope="col" className="th-num">Base</th>
                <th scope="col" className="th-num">Bonuses</th>
                <th scope="col" className="th-num">Deductions</th>
                <th scope="col" className="th-num">Net</th>
                <th scope="col" className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => {
                const currency = r.currency || base
                return (
                  <tr key={r.id} className="tr">
                    <td className="td td-strong">
                      <div className="max-w-[220px] truncate" title={r.employee_name}>{r.employee_name}</div>
                    </td>
                    <td className="td">
                      {r.position
                        ? <div className="max-w-[200px] truncate" title={r.position}>{r.position}</div>
                        : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="td-num"><Money amount={r.base_salary} currency={currency} /></td>
                    <td className="td-num"><Money amount={r.bonuses} currency={currency} /></td>
                    <td className="td-num"><Money amount={r.deductions} currency={currency} /></td>
                    <td className="td-num font-semibold"><Money amount={r.net_salary} currency={currency} /></td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Reports() {
  const { baseCurrency, companyName } = useSettings()
  const [searchParams, setSearchParams] = useSearchParams()
  const wanted = searchParams.get('tab')
  const tab: TabId = TABS.find((t) => t.id === wanted)?.id ?? 'pl'
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? 'Reports'

  // Period controls: each report keeps its own.
  const [plMode, setPlMode] = useState<PlMode>('month')
  const [plMonth, setPlMonth] = useState(thisMonthISO)
  const [plYear, setPlYear] = useState(thisYear)
  const [incomeRange, setIncomeRange] = useState(wholeYear)
  const [expenseRange, setExpenseRange] = useState(wholeYear)
  const [cashYear, setCashYear] = useState(thisYear)
  const [payMonth, setPayMonth] = useState(thisMonthISO)

  // Typed values are sent once the typing stops.
  const plMonthSettled = useDebounced(plMonth)
  const incomeSettled = useDebounced(incomeRange)
  const expenseSettled = useDebounced(expenseRange)
  const payMonthSettled = useDebounced(payMonth)

  const plProblem = plMode === 'month' ? monthProblem(plMonthSettled) : null
  const incomeProblem = rangeProblem(incomeSettled)
  const expenseProblem = rangeProblem(expenseSettled)
  const payProblem = monthProblem(payMonthSettled)

  const pl = useReport<ProfitLossReport>(
    tab === 'pl',
    plMode === 'year' ? { year: plYear } : plProblem ? null : { month: plMonthSettled },
    reportApi.pl, 'profit and loss report',
  )
  const income = useReport<IncomeReport>(
    tab === 'income', incomeProblem ? null : incomeSettled, reportApi.revenue, 'income report',
  )
  const expenses = useReport<ExpenseReport>(
    tab === 'expenses', expenseProblem ? null : expenseSettled, reportApi.expenses, 'expense report',
  )
  const cashflow = useReport<CashflowReport>(
    tab === 'cashflow', { year: cashYear }, reportApi.cashflow, 'cash flow report',
  )
  const receivables = useReport<ReceivablesReport>(
    tab === 'receivables', NO_PARAMS, reportApi.receivables, 'receivables report',
  )
  const payroll = useReport<PayrollReport>(
    tab === 'payroll', payProblem ? null : { month: payMonthSettled }, reportApi.payroll, 'payroll report',
  )

  usePrintInLightTheme()

  const current = { pl, income, expenses, cashflow, receivables, payroll }[tab]
  // Something worth exporting or printing is on screen.
  const hasContent = {
    pl: !!pl.data && !isEmpty.pl(pl.data),
    income: !!income.data && !isEmpty.income(income.data),
    expenses: !!expenses.data && !isEmpty.expenses(expenses.data),
    cashflow: !!cashflow.data && !isEmpty.cashflow(cashflow.data),
    receivables: !!receivables.data && !isEmpty.receivables(receivables.data),
    payroll: !!payroll.data && !isEmpty.payroll(payroll.data),
  }[tab]
  // Totals are in the currency the server converted them to.
  const base = current.data?.base_currency || baseCurrency

  function selectTab(id: TabId) {
    setSearchParams(id === 'pl' ? {} : { tab: id }, { replace: true })
  }

  function exportCurrent() {
    try {
      let count = 0
      if (tab === 'pl' && pl.data) count = exportProfitLoss(pl.data)
      else if (tab === 'income' && income.data) count = exportIncome(income.data)
      else if (tab === 'expenses' && expenses.data) count = exportExpenses(expenses.data)
      else if (tab === 'cashflow' && cashflow.data) count = exportCashflow(cashflow.data)
      else if (tab === 'receivables' && receivables.data) count = exportReceivables(receivables.data)
      else if (tab === 'payroll' && payroll.data) count = exportPayroll(payroll.data)
      else return
      toast.success(`Exported ${plural(count, 'row')}`)
    } catch {
      toast.error('Could not create the CSV file')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        description={`Totals are in ${base}; other currencies are converted at the saved rates`}
        actions={
          <>
            <button
              type="button" className="btn-icon no-print" onClick={() => current.reload(true)}
              disabled={current.fetching} title="Refresh" aria-label="Refresh this report"
            >
              <RefreshCw size={15} className={current.fetching ? 'animate-spin' : ''} />
            </button>
            <button type="button" className="btn-secondary no-print" onClick={exportCurrent} disabled={!hasContent}>
              <Download size={15} /> Export CSV
            </button>
            <button type="button" className="btn-secondary no-print" onClick={() => window.print()} disabled={!hasContent}>
              <Printer size={15} /> Print
            </button>
          </>
        }
      />

      <div className="no-print">
        <Tabs tabs={TABS} value={tab} onChange={selectTab} />
      </div>
      {/* On paper the tabs are gone, so name the report instead. */}
      <p className="hidden print:block text-sm font-semibold text-ink">
        {tabLabel} · {companyName} · printed {formatDate(todayISO())}
      </p>

      <div role="tabpanel" aria-label={tabLabel} className="space-y-5">
        {tab === 'pl' && (
          <>
            <PeriodBar busy={pl.fetching && !!pl.data} problem={plProblem}>
              <Segmented<PlMode> options={PL_MODES} value={plMode} onChange={setPlMode} />
              {plMode === 'month'
                ? <MonthInput value={plMonth} onChange={setPlMonth} />
                : <YearSelect value={plYear} onChange={setPlYear} />}
            </PeriodBar>
            <ReportBody
              report={pl} grid={GRID_4} labels={['Income', 'Total expenses', 'Net profit', 'Margin']}
              isEmpty={isEmpty.pl}
              empty={(d) => (
                <EmptyState
                  icon={Scale}
                  title={`Nothing recorded for ${plPeriod(d).label}`}
                  description="Income counts on the day it is paid and expenses on their payment date."
                />
              )}
            >
              {(d) => <ProfitLossView data={d} />}
            </ReportBody>
          </>
        )}

        {tab === 'income' && (
          <>
            <PeriodBar busy={income.fetching && !!income.data} problem={incomeProblem}>
              <RangeInputs range={incomeRange} onChange={setIncomeRange} />
            </PeriodBar>
            <ReportBody
              report={income} grid={GRID_4} labels={['Total income', 'Payments', 'Top client', 'Best month']}
              isEmpty={isEmpty.income}
              empty={(d) => (
                <EmptyState
                  icon={TrendingUp}
                  title="No income received in this period"
                  description={`Nothing was paid between ${formatDate(d.period.from)} and ${formatDate(d.period.to)}. Paid invoices and income entries appear here.`}
                />
              )}
            >
              {(d) => <IncomeView data={d} />}
            </ReportBody>
          </>
        )}

        {tab === 'expenses' && (
          <>
            <PeriodBar busy={expenses.fetching && !!expenses.data} problem={expenseProblem}>
              <RangeInputs range={expenseRange} onChange={setExpenseRange} />
            </PeriodBar>
            <ReportBody
              report={expenses} grid={GRID_4}
              labels={['Total expenses', 'Entries', 'Largest category', 'Highest month']}
              isEmpty={isEmpty.expenses}
              empty={(d) => (
                <EmptyState
                  icon={Receipt}
                  title="No expenses in this period"
                  description={`Nothing was paid out between ${formatDate(d.period.from)} and ${formatDate(d.period.to)}.`}
                />
              )}
            >
              {/* A new period starts again with the short list. */}
              {(d) => <ExpensesView key={`${d.period.from}:${d.period.to}`} data={d} />}
            </ReportBody>
          </>
        )}

        {tab === 'cashflow' && (
          <>
            <PeriodBar busy={cashflow.fetching && !!cashflow.data}>
              <YearSelect value={cashYear} onChange={setCashYear} />
            </PeriodBar>
            <ReportBody
              report={cashflow} grid={GRID_3} labels={['Money in', 'Money out', 'Net cash flow']}
              isEmpty={isEmpty.cashflow}
              empty={(d) => (
                <EmptyState
                  icon={BarChart3}
                  title={`No money in or out in ${d.year}`}
                  description="Paid income and expenses dated in this year appear here month by month."
                />
              )}
            >
              {(d) => <CashflowView data={d} />}
            </ReportBody>
          </>
        )}

        {tab === 'receivables' && (
          <ReportBody
            report={receivables} grid={GRID_AGEING}
            labels={['Total outstanding', ...AGE_BUCKETS.map((b) => b.label)]}
            isEmpty={isEmpty.receivables}
            empty={() => (
              <EmptyState
                icon={CheckCircle2}
                title="Nothing outstanding"
                description="Every invoice you have sent has been paid."
              />
            )}
          >
            {(d) => <ReceivablesView data={d} />}
          </ReportBody>
        )}

        {tab === 'payroll' && (
          <>
            <PeriodBar busy={payroll.fetching && !!payroll.data} problem={payProblem}>
              <MonthInput value={payMonth} onChange={setPayMonth} />
            </PeriodBar>
            <ReportBody
              report={payroll} grid={GRID_4} labels={['Net payroll', 'Bonuses', 'Deductions', 'People']}
              isEmpty={isEmpty.payroll}
              empty={(d) => (
                <EmptyState
                  icon={Users}
                  title={`No payroll for ${formatMonth(d.month)}`}
                  description="Generate the month on the Payroll page and it will show up here."
                  action={<Link to="/payroll" className="btn-secondary">Open payroll</Link>}
                />
              )}
            >
              {(d) => <PayrollView data={d} />}
            </ReportBody>
          </>
        )}
      </div>

      <style>{PRINT_CSS}</style>
    </div>
  )
}
