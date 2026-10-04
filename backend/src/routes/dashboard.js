const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap } = require('../lib/http');
const { symbolFor } = require('../lib/money');
const { today, shiftDate, monthLabel } = require('../lib/dates');
const { baseConverter, getCachedRatesData } = require('../services/currencyService');
const { refreshOverdue } = require('../services/invoiceService');

const CHART_MONTHS = 12;
const UPCOMING_DAYS = 14;
const BREAKDOWN_SIZE = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

// Totals are added up in base-currency cents and returned with two decimals,
// so the dashboard shows the same figures as the reports and the lists.
const whole = (cents) => Math.round(cents) / 100;
// Differences of two-decimal numbers pick up binary noise; trim it off.
const tidy = (n) => Math.round(n * 100) / 100;
const percent = (part, of) => Math.round((part / of) * 1000) / 10;
// Change against the previous period; null when there is nothing to compare with.
const growth = (current, previous) =>
  (previous === 0 ? null : percent(current - previous, Math.abs(previous)));

const categoryOf = (row) => String(row.category || '').trim() || 'Uncategorized';

// Whole calendar days from one YYYY-MM-DD date to another.
function daysBetween(from, to) {
  const at = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  const days = Math.round((at(to) - at(from)) / DAY_MS);
  return Number.isFinite(days) ? days : 0;
}

// A sent proposal past its validity date counts as Expired here even if the
// proposals page has not updated the row yet.
function proposalStatus(p, todayStr) {
  const expired = p.status === 'Sent' && p.valid_until && String(p.valid_until).slice(0, 10) < todayStr;
  return expired ? 'Expired' : p.status;
}

// Largest categories first; everything beyond the limit is folded into one 'Other' line.
function topCategories(centsByCategory, limit) {
  const all = [...centsByCategory]
    .map(([category, cents]) => ({ category, cents }))
    .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category));
  if (all.length <= limit) return all;
  // A category that is itself called 'Other' joins the remainder instead of appearing twice.
  const top = all.filter((c) => c.category !== 'Other').slice(0, limit);
  const rest = all.filter((c) => !top.includes(c)).reduce((sum, c) => sum + c.cents, 0);
  return [...top, { category: 'Other', cents: rest }];
}

router.get('/', wrap((req, res) => {
  refreshOverdue();

  // One snapshot of exchange rates for every figure in the response. Each row
  // is converted and rounded to cents once, the same way the reports do it.
  const conv = baseConverter();
  const cents = (amount, currency) => Math.round(conv.toBase(amount, currency) * 100);

  const todayStr = today();
  const month = todayStr.slice(0, 7);
  const year = todayStr.slice(0, 4);
  const lastMonth = shiftDate(`${month}-01`, { months: -1 }).slice(0, 7);

  // ── Money in and out ───────────────────────────────────────────────────────
  // The cash balance needs every row anyway, so both tables are read once and
  // bucketed by month here instead of running one query per period.
  const incomeRows = db.prepare(`
    SELECT invoice_date AS date, amount, currency FROM revenue WHERE payment_status='Paid'
  `).all();
  const expenseRows = db.prepare(`
    SELECT payment_date AS date, category, amount, currency FROM expenses
  `).all();

  // 'YYYY-MM' → cents. Rows without a date only count toward the cash balance.
  const months = new Map();
  const monthOf = (date) => String(date || '').slice(0, 7);
  const bucketFor = (ym) => {
    if (!months.has(ym)) months.set(ym, { revenue: 0, expenses: 0, salaries: 0 });
    return months.get(ym);
  };

  let incomeAllTime = 0;
  let expensesAllTime = 0;
  const monthCategories = new Map();

  for (const r of incomeRows) {
    const c = cents(r.amount, r.currency);
    incomeAllTime += c;
    bucketFor(monthOf(r.date)).revenue += c;
  }

  // Payroll is already here as 'Salaries' expenses, so salary_payments is never added on top.
  for (const r of expenseRows) {
    const c = cents(r.amount, r.currency);
    const ym = monthOf(r.date);
    const category = categoryOf(r);
    const bucket = bucketFor(ym);
    expensesAllTime += c;
    bucket.expenses += c;
    if (category === 'Salaries') bucket.salaries += c;
    if (ym === month) monthCategories.set(category, (monthCategories.get(category) || 0) + c);
  }

  const inMonth = (ym) => months.get(ym) || { revenue: 0, expenses: 0, salaries: 0 };
  const inYear = { revenue: 0, expenses: 0 };
  for (const [ym, m] of months) {
    if (ym.startsWith(`${year}-`)) {
      inYear.revenue += m.revenue;
      inYear.expenses += m.expenses;
    }
  }

  // Profit and the ops/salary split are derived from the rounded figures so
  // the numbers on screen always add up.
  const monthRevenue = whole(inMonth(month).revenue);
  const monthExpenses = whole(inMonth(month).expenses);
  const monthSalaries = whole(inMonth(month).salaries);
  const monthProfit = tidy(monthRevenue - monthExpenses);
  const lastMonthRevenue = whole(inMonth(lastMonth).revenue);
  const lastMonthExpenses = whole(inMonth(lastMonth).expenses);
  const lastMonthProfit = tidy(lastMonthRevenue - lastMonthExpenses);
  const yearRevenue = whole(inYear.revenue);
  const yearExpenses = whole(inYear.expenses);

  const chartStart = shiftDate(`${month}-01`, { months: -(CHART_MONTHS - 1) });
  const chartData = Array.from({ length: CHART_MONTHS }, (_, i) => {
    const ym = shiftDate(chartStart, { months: i }).slice(0, 7);
    const revenue = whole(inMonth(ym).revenue);
    const expenses = whole(inMonth(ym).expenses);
    return { month: monthLabel(ym, 'MMM'), ym, revenue, expenses, profit: tidy(revenue - expenses) };
  });

  const expenseBreakdown = topCategories(monthCategories, BREAKDOWN_SIZE)
    .map((c) => ({ category: c.category, total: whole(c.cents) }));

  // ── Invoices and receivables ───────────────────────────────────────────────
  const openInvoices = db.prepare(`
    SELECT id, invoice_number, client_name, total, currency, due_date, status
    FROM invoices WHERE status IN ('Draft', 'Sent', 'Overdue')
    ORDER BY due_date, id
  `).all();
  const invoiceTotals = {
    Draft: { count: 0, cents: 0 },
    Sent: { count: 0, cents: 0 },
    Overdue: { count: 0, cents: 0 },
  };
  for (const inv of openInvoices) {
    invoiceTotals[inv.status].count += 1;
    invoiceTotals[inv.status].cents += cents(inv.total, inv.currency);
  }
  const pendingInvoiceAmount = whole(invoiceTotals.Sent.cents);
  const overdueAmount = whole(invoiceTotals.Overdue.cents);

  const overdueList = openInvoices
    .filter((inv) => inv.status === 'Overdue')
    .slice(0, 5)
    .map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number,
      client_name: inv.client_name,
      total: inv.total,
      currency: inv.currency || conv.base,
      due_date: inv.due_date,
      days_overdue: Math.max(0, daysBetween(inv.due_date, todayStr)),
    }));

  const recentInvoices = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC LIMIT 6').all();

  // ── Payroll still to be paid ───────────────────────────────────────────────
  const pendingSalaryRows = db.prepare(`
    SELECT net_salary, currency FROM salary_payments WHERE status='Pending'
  `).all();
  const pendingSalaryCents = pendingSalaryRows.reduce((sum, s) => sum + cents(s.net_salary, s.currency), 0);

  // ── Proposals ──────────────────────────────────────────────────────────────
  const proposalCounts = { Draft: 0, Sent: 0, Accepted: 0, Declined: 0, Expired: 0 };
  let openProposalCents = 0;
  for (const p of db.prepare('SELECT status, valid_until, total, currency FROM proposals').all()) {
    const status = proposalStatus(p, todayStr);
    if (!(status in proposalCounts)) continue;
    proposalCounts[status] += 1;
    if (status === 'Draft' || status === 'Sent') openProposalCents += cents(p.total, p.currency);
  }
  const decided = proposalCounts.Accepted + proposalCounts.Declined + proposalCounts.Expired;

  const recentProposals = db.prepare('SELECT * FROM proposals ORDER BY created_at DESC, id DESC LIMIT 5').all()
    .map((p) => ({ ...p, status: proposalStatus(p, todayStr) }));

  // ── Recurring payments coming up ───────────────────────────────────────────
  const upcomingPayments = db.prepare(`
    SELECT * FROM recurring_payments
    WHERE status='Active' AND next_payment_date >= ? AND next_payment_date <= ?
    ORDER BY next_payment_date, id LIMIT 6
  `).all(todayStr, shiftDate(todayStr, { days: UPCOMING_DAYS }));

  res.json({
    base_currency: conv.base,
    currency_symbol: symbolFor(conv.base),
    rates_updated_at: getCachedRatesData()?.updated_at || null,
    stats: {
      monthRevenue,
      lastMonthRevenue,
      yearRevenue,
      monthExpenses,
      lastMonthExpenses,
      yearExpenses,
      monthSalaries,
      monthOpsExpenses: tidy(monthExpenses - monthSalaries),
      monthProfit,
      lastMonthProfit,
      yearProfit: tidy(yearRevenue - yearExpenses),
      profitMargin: monthRevenue > 0 ? percent(monthProfit, monthRevenue) : 0,
      revenueGrowth: growth(monthRevenue, lastMonthRevenue),
      expenseGrowth: growth(monthExpenses, lastMonthExpenses),
      profitGrowth: growth(monthProfit, lastMonthProfit),
      pendingInvoices: invoiceTotals.Sent.count,
      pendingInvoiceAmount,
      overdueInvoices: invoiceTotals.Overdue.count,
      overdueAmount,
      draftInvoices: invoiceTotals.Draft.count,
      accountsReceivable: tidy(pendingInvoiceAmount + overdueAmount),
      pendingSalaries: pendingSalaryRows.length,
      pendingSalaryAmount: whole(pendingSalaryCents),
      openProposals: proposalCounts.Draft + proposalCounts.Sent,
      openProposalAmount: whole(openProposalCents),
      proposalWinRate: decided > 0 ? percent(proposalCounts.Accepted, decided) : null,
      cashBalance: whole(incomeAllTime - expensesAllTime),
    },
    chartData,
    expenseBreakdown,
    recentInvoices,
    overdueList,
    upcomingPayments,
    recentProposals,
  });
}));

module.exports = router;
