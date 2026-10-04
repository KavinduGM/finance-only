import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, FileClock, FileSignature, FileText, Landmark,
  LineChart, Plus, Receipt, RefreshCw, Scale, TrendingUp, Wallet,
} from 'lucide-react'
import { dashboardApi, DashboardData } from '../services/api'
import { useSettings } from '../context/SettingsContext'
import {
  BarList, ChartCard, ChartLegend, ColumnChart, Delta, EmptyState, ErrorState, Money, PageHeader, StatCard,
  StatusBadge, TableSkeleton, TrendChart,
} from '../components/ui'
import type { Series } from '../components/ui'
import {
  daysUntil, errorMessage, formatDate, formatDateTime, formatMonth, formatNumber, thisMonthISO,
} from '../lib/format'

const TREND_SERIES: Series[] = [
  { key: 'revenue', label: 'Income', color: 'income' },
  { key: 'expenses', label: 'Expenses', color: 'expense' },
]
const PROFIT_SERIES: Series[] = [{ key: 'profit', label: 'Net profit', color: 'third' }]

// Stand-in figures for the first load. The stat cards show skeletons while
// these are in place, so none of them reaches the screen.
const BLANK_STATS: DashboardData['stats'] = {
  monthRevenue: 0, lastMonthRevenue: 0, yearRevenue: 0,
  monthExpenses: 0, lastMonthExpenses: 0, yearExpenses: 0,
  monthSalaries: 0, monthOpsExpenses: 0,
  monthProfit: 0, lastMonthProfit: 0, yearProfit: 0,
  profitMargin: 0,
  revenueGrowth: null, expenseGrowth: null, profitGrowth: null,
  pendingInvoices: 0, pendingInvoiceAmount: 0,
  overdueInvoices: 0, overdueAmount: 0,
  draftInvoices: 0,
  accountsReceivable: 0,
  pendingSalaries: 0, pendingSalaryAmount: 0,
  openProposals: 0, openProposalAmount: 0,
  proposalWinRate: null,
  cashBalance: 0,
}

const plural = (n: number, noun: string) => `${formatNumber(n)} ${n === 1 ? noun : `${noun}s`}`

/** "12.5%" / "60%" with a proper minus sign; no plus sign, unlike a change figure. */
const percentText = (v: number) =>
  `${v < 0 ? '−' : ''}${formatNumber(Math.abs(v), Number.isInteger(v) ? 0 : 1)}%`

/** "today", "tomorrow", "in 3 days" for a date; null when there is no date. */
function relativeDay(dateISO?: string | null) {
  const days = daysUntil(dateISO)
  if (days === null) return null
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days > 1) return `in ${days} days`
  return days === -1 ? 'yesterday' : `${-days} days ago`
}

/** A count with its noun in a quieter weight: "3 invoices". */
function Count({ n, noun }: { n: number; noun: string }) {
  return (
    <>
      {formatNumber(n)}{' '}
      <span className="text-sm font-normal tracking-normal text-ink-3">{n === 1 ? noun : `${noun}s`}</span>
    </>
  )
}

/** Short facts for a stat card hint. Each stays whole; a narrow card breaks the line between them. */
function Facts({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={item}>
          {i > 0 && ' '}
          <span className="whitespace-nowrap">{item}{i < items.length - 1 && ' ·'}</span>
        </Fragment>
      ))}
    </>
  )
}

/** Card frame for a short list: title, optional note, a link to the full page. */
function ListCard({ title, subtitle, to, children }: {
  title: string
  subtitle?: React.ReactNode
  /** Where "View all" leads. */
  to: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div className="min-w-0">
          <h3 className="card-title">{title}</h3>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
        <Link
          to={to}
          aria-label={`View all: ${title.toLowerCase()}`}
          className="link inline-flex items-center gap-1 text-xs font-medium shrink-0"
        >
          View all <ArrowRight size={12} />
        </Link>
      </div>
      <div className="border-t border-line">{children}</div>
    </section>
  )
}

/** Two-line list row: who or what and the amount on top, the details and a status underneath. */
function ListRow({ title, amount, currency, meta, aside }: {
  title: string
  amount: number
  /** The currency the amount was recorded in; it is never converted here. */
  currency: string
  meta: React.ReactNode
  aside: React.ReactNode
}) {
  return (
    <li className="px-5 py-3 border-b border-line/70 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-ink truncate" title={title}>{title}</p>
        <Money amount={amount} currency={currency} className="text-sm text-ink shrink-0" />
      </div>
      <div className="flex items-center justify-between gap-3 mt-1.5">
        <p className="text-xs text-ink-3 truncate">{meta}</p>
        <div className="shrink-0">{aside}</div>
      </div>
    </li>
  )
}

function BarListSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="skeleton h-3.5 w-2/3" />
          <div className="skeleton h-1.5 w-full" />
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { money, moneyCompact, baseCurrency } = useSettings()

  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(true)
  // Only the newest request may update the page; an answer that arrives late is dropped.
  const latest = useRef(0)
  const loaded = useRef(false)

  const load = useCallback(async (manual = false) => {
    const id = (latest.current += 1)
    setFetching(true)
    if (!loaded.current) setError(null)
    try {
      const body = await dashboardApi.get()
      if (id !== latest.current) return
      loaded.current = true
      setData(body)
      setError(null)
      if (manual) toast.success('Dashboard updated')
    } catch (err) {
      if (id !== latest.current) return
      // With figures already on screen, keep them and report the failed refresh.
      if (loaded.current) toast.error(errorMessage(err, 'Could not refresh the dashboard'))
      else setError(errorMessage(err, 'Could not load the dashboard'))
    } finally {
      if (id === latest.current) setFetching(false)
    }
  }, [])

  useEffect(() => {
    load()
    // On unmount, a response still in flight no longer has anywhere to land.
    return () => { latest.current += 1 }
  }, [load])

  const loading = !data
  const s = data?.stats ?? BLANK_STATS
  // The API has already converted every total to this currency.
  const base = data?.base_currency || baseCurrency
  const full = (amount: number) => money(amount, base)
  const compact = (amount: number) => moneyCompact(amount, base)

  const chartData = data?.chartData ?? []
  // The newest chart month is the month the figures refer to (the server's "this month").
  const currentYm = chartData.length ? chartData[chartData.length - 1].ym : thisMonthISO()
  const monthName = formatMonth(currentYm)
  const year = formatMonth(currentYm, 'yyyy')
  const hasActivity = chartData.some((m) => m.revenue !== 0 || m.expenses !== 0)

  const breakdown = (data?.expenseBreakdown ?? []).map((e) => ({ label: e.category, value: e.total }))
  const hasBreakdown = breakdown.some((b) => b.value !== 0)
  const recentInvoices = data?.recentInvoices ?? []
  const overdueList = data?.overdueList ?? []
  const upcoming = data?.upcomingPayments ?? []
  const recentProposals = data?.recentProposals ?? []
  const showProposals = recentProposals.length > 0

  return (
    <div className="page" aria-busy={loading && !error}>
      <div className="space-y-2">
        <PageHeader
          title="Dashboard"
          description={`${monthName} at a glance`}
          actions={
            <>
              <button
                type="button" className="btn-icon" onClick={() => load(true)} disabled={fetching}
                title="Refresh" aria-label="Refresh the dashboard"
              >
                <RefreshCw size={15} className={fetching ? 'animate-spin' : ''} />
              </button>
              <Link to="/proposals?new=1" className="btn-secondary"><Plus size={15} /> New proposal</Link>
              <Link to="/invoices?new=1" className="btn-primary"><Plus size={15} /> New invoice</Link>
            </>
          }
        />
        {data?.rates_updated_at && (
          <p className="text-xs text-ink-3">
            Other currencies converted at rates from {formatDateTime(data.rates_updated_at)}
          </p>
        )}
      </div>

      {error && !data ? (
        <div className="card">
          <ErrorState message={error} onRetry={() => load()} />
        </div>
      ) : (
        <>
          {/* This month */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              label="Income this month" icon={TrendingUp} loading={loading}
              value={compact(s.monthRevenue)}
              hint={full(s.monthRevenue)}
              footer={<Delta value={s.revenueGrowth} label="vs last month" />}
            />
            <StatCard
              label="Expenses this month" icon={Receipt} loading={loading}
              value={compact(s.monthExpenses)}
              hint={<Facts items={[`Payroll ${compact(s.monthSalaries)}`, `Operating ${compact(s.monthOpsExpenses)}`]} />}
              footer={<Delta value={s.expenseGrowth} goodWhen="down" label="vs last month" />}
            />
            <StatCard
              label="Net profit this month" icon={Scale} loading={loading}
              value={<span className={s.monthProfit < 0 ? 'text-bad' : undefined}>{compact(s.monthProfit)}</span>}
              hint={
                s.monthRevenue > 0
                  ? `${percentText(s.profitMargin)} margin`
                  : 'No income yet this month'
              }
              footer={<Delta value={s.profitGrowth} label="vs last month" />}
            />
            <StatCard
              label="Cash balance" icon={Landmark} loading={loading}
              value={<span className={s.cashBalance < 0 ? 'text-bad' : undefined}>{compact(s.cashBalance)}</span>}
              hint="All-time income minus expenses"
              footer={
                <span className="text-xs text-ink-3">
                  Owed to you <span className="font-mono font-medium text-ink-2">{compact(s.accountsReceivable)}</span>
                </span>
              }
            />
          </div>

          {/* What needs attention; each card opens the matching list */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              label="Awaiting payment" icon={FileClock} loading={loading}
              value={<Count n={s.pendingInvoices} noun="invoice" />}
              hint={s.pendingInvoices > 0 ? full(s.pendingInvoiceAmount) : 'No sent invoices waiting'}
              onClick={() => navigate('/invoices?status=Sent')}
            />
            <StatCard
              label="Overdue" icon={AlertTriangle} tone={s.overdueInvoices > 0 ? 'bad' : 'neutral'} loading={loading}
              value={<Count n={s.overdueInvoices} noun="invoice" />}
              hint={s.overdueInvoices > 0 ? full(s.overdueAmount) : 'Nothing past its due date'}
              onClick={() => navigate('/invoices?status=Overdue')}
            />
            <StatCard
              label="Open proposals" icon={FileSignature} loading={loading}
              value={<Count n={s.openProposals} noun="proposal" />}
              hint={
                <Facts
                  items={[
                    s.openProposals > 0 ? compact(s.openProposalAmount) : 'None open',
                    s.proposalWinRate === null ? 'no win rate yet' : `win rate ${percentText(s.proposalWinRate)}`,
                  ]}
                />
              }
              onClick={() => navigate('/proposals')}
            />
            <StatCard
              label="Payroll to pay" icon={Wallet} loading={loading}
              value={<Count n={s.pendingSalaries} noun="payment" />}
              hint={s.pendingSalaries > 0 ? full(s.pendingSalaryAmount) : 'No salaries waiting'}
              onClick={() => navigate('/payroll')}
            />
          </div>

          {/* Trend and this month's spending */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <ChartCard
              className="xl:col-span-2"
              title="Income and expenses"
              subtitle={`Last 12 months, in ${base}`}
              right={hasActivity ? <ChartLegend series={TREND_SERIES} /> : undefined}
            >
              {loading ? (
                <div className="skeleton h-[280px]" />
              ) : hasActivity ? (
                <TrendChart data={chartData} xKey="month" series={TREND_SERIES} format={full} currency={base} />
              ) : (
                <EmptyState
                  icon={LineChart}
                  title="No income or expenses in the last 12 months"
                  description="Paid invoices, income entries and expenses appear here as they are recorded."
                />
              )}
            </ChartCard>

            <ChartCard
              title="Where the money went"
              subtitle={`${monthName}, by category`}
              right={<Link to="/expenses" className="link text-xs font-medium shrink-0">View expenses</Link>}
            >
              {loading ? (
                <BarListSkeleton />
              ) : (
                <>
                  <BarList items={breakdown} format={full} color="expense" emptyLabel="No expenses recorded this month" />
                  {hasBreakdown && (
                    <div className="flex items-baseline justify-between gap-3 mt-4 pt-3 border-t border-line text-sm">
                      <span className="text-ink-3">Total this month</span>
                      <span className="num font-medium text-ink">{full(s.monthExpenses)}</span>
                    </div>
                  )}
                </>
              )}
            </ChartCard>
          </div>

          {/* Profit per month, with the year so far beside the title */}
          {(loading || hasActivity) && (
            <ChartCard
              title="Monthly profit"
              subtitle="Income minus expenses for each of the last 12 months"
              right={
                !loading && (
                  <dl className="flex flex-wrap gap-x-6 gap-y-2">
                    {([
                      [`Income ${year}`, s.yearRevenue],
                      [`Expenses ${year}`, s.yearExpenses],
                      [`Net profit ${year}`, s.yearProfit],
                    ] as [string, number][]).map(([label, amount]) => (
                      <div key={label}>
                        <dt className="eyebrow">{label}</dt>
                        <dd className="num text-sm text-ink mt-0.5">{full(amount)}</dd>
                      </div>
                    ))}
                  </dl>
                )
              }
            >
              {loading ? (
                <div className="skeleton h-[240px]" />
              ) : (
                <ColumnChart data={chartData} xKey="month" series={PROFIT_SERIES} format={full} currency={base} height={240} />
              )}
            </ChartCard>
          )}

          {/* Short lists; every amount is shown in the currency it was recorded in */}
          <div className={`grid grid-cols-1 gap-4 ${showProposals ? 'lg:grid-cols-2' : 'xl:grid-cols-3'}`}>
            <ListCard
              title="Recent invoices"
              subtitle={s.draftInvoices > 0 ? `Newest first · ${plural(s.draftInvoices, 'draft')} not sent yet` : 'Newest first'}
              to="/invoices"
            >
              {loading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : recentInvoices.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title="No invoices yet"
                  description="The invoices you create are listed here."
                  action={<Link to="/invoices?new=1" className="btn-secondary btn-sm"><Plus size={14} /> New invoice</Link>}
                />
              ) : (
                <ul>
                  {recentInvoices.map((inv) => (
                    <ListRow
                      key={inv.id}
                      title={inv.client_name}
                      amount={inv.total}
                      currency={inv.currency || base}
                      meta={
                        <>
                          <span className="num">{inv.invoice_number}</span>
                          {inv.status === 'Paid' && inv.paid_date
                            ? ` · paid ${formatDate(inv.paid_date)}`
                            : ` · due ${formatDate(inv.due_date)}`}
                        </>
                      }
                      aside={<StatusBadge status={inv.status} />}
                    />
                  ))}
                </ul>
              )}
            </ListCard>

            <ListCard
              title="Overdue invoices"
              subtitle={
                s.overdueInvoices > overdueList.length
                  ? `The ${overdueList.length} longest overdue of ${formatNumber(s.overdueInvoices)}`
                  : 'Longest overdue first'
              }
              to="/invoices?status=Overdue"
            >
              {loading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : overdueList.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Nothing overdue"
                  description="No sent invoice has passed its due date."
                />
              ) : (
                <ul>
                  {overdueList.map((inv) => (
                    <ListRow
                      key={inv.id}
                      title={inv.client_name}
                      amount={inv.total}
                      currency={inv.currency || base}
                      meta={
                        <>
                          <span className="num">{inv.invoice_number}</span>
                          {` · due ${formatDate(inv.due_date)}`}
                        </>
                      }
                      aside={
                        <span className="text-xs font-medium text-bad">
                          {inv.days_overdue > 0 ? `${plural(inv.days_overdue, 'day')} overdue` : 'Overdue'}
                        </span>
                      }
                    />
                  ))}
                </ul>
              )}
            </ListCard>

            <ListCard title="Upcoming payments" subtitle="Recurring, due in the next 14 days" to="/recurring">
              {loading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : upcoming.length === 0 ? (
                <EmptyState
                  icon={CalendarCheck}
                  title="Nothing due soon"
                  description="No recurring payment falls due in the next 14 days."
                />
              ) : (
                <ul>
                  {upcoming.map((p) => {
                    const when = relativeDay(p.next_payment_date)
                    return (
                      <ListRow
                        key={p.id}
                        title={p.name}
                        amount={p.amount}
                        currency={p.currency || base}
                        meta={
                          <>
                            {formatDate(p.next_payment_date)}
                            {when && <> · <span className={when === 'today' ? 'font-medium text-warn' : undefined}>{when}</span></>}
                            {p.billing_cycle && ` · ${p.billing_cycle}`}
                          </>
                        }
                        aside={<StatusBadge status={p.type} />}
                      />
                    )
                  })}
                </ul>
              )}
            </ListCard>

            {showProposals && (
              <ListCard title="Recent proposals" subtitle="Newest first" to="/proposals">
                <ul>
                  {recentProposals.map((p) => (
                    <ListRow
                      key={p.id}
                      title={p.title || p.client_name}
                      amount={p.total}
                      currency={p.currency || base}
                      meta={
                        <>
                          <span className="num">{p.proposal_number}</span>
                          {p.title && p.client_name ? ` · ${p.client_name}` : ''}
                        </>
                      }
                      aside={<StatusBadge status={p.status} />}
                    />
                  ))}
                </ul>
              </ListCard>
            )}
          </div>
        </>
      )}
    </div>
  )
}
