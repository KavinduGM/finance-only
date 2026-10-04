const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { today, shiftDate, monthRange, monthLabel } = require('../lib/dates');
const { baseConverter } = require('../services/currencyService');
const { refreshOverdue } = require('../services/invoiceService');

// Every amount in these reports is in the company base currency.
//
// Each row is converted with one snapshot of rates and rounded to cents once;
// every total is then a sum of those cents. That keeps all breakdowns of a
// report (by month, by category, by client) adding up to the same figure, and
// matches how the dashboard counts the same rows.
function converter() {
  const conv = baseConverter();
  return {
    base: conv.base,
    cents: (amount, currency) => Math.round(conv.toBase(amount, currency) * 100),
  };
}
const money = (cents) => cents / 100;
const percent = (part, of) => Math.round((part / of) * 1000) / 10;
const sumCents = (rows) => rows.reduce((sum, r) => sum + r.cents, 0);

const DAY_MS = 24 * 60 * 60 * 1000;
// Longer periods list only the months that have data instead of every month.
const MAX_FILLED_MONTHS = 120;

const monthOf = (date) => String(date).slice(0, 7);
const labelOr = (value, fallback) => String(value || '').trim() || fallback;
const categoryOf = (row) => labelOr(row.category, 'Uncategorized');

// ── Query parameters ─────────────────────────────────────────────────────────

// v.date lets through day numbers that do not exist in the month (2026-02-30
// rolls over into March), so make sure the date survives a round trip.
function readDate(value, name) {
  const date = v.date(value, name);
  if (date && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, `${name} must be a valid date (YYYY-MM-DD)`);
  }
  return date;
}

function readYear(value) {
  const year = v.int(value, 'Year', { min: 1900, max: 2100 });
  return year === null ? today().slice(0, 4) : String(year);
}

// ?from=&to= → defaults to the current year. When only one end is given the
// other falls on the same side of that year, so the period is never inverted.
function readPeriod(query) {
  const givenFrom = readDate(query.from, 'From date');
  const givenTo = readDate(query.to, 'To date');
  if (givenFrom && givenTo && givenFrom > givenTo) {
    throw new HttpError(400, 'From date must be on or before the To date');
  }
  const year = today().slice(0, 4);
  const fromYear = givenTo && givenTo.slice(0, 4) < year ? givenTo.slice(0, 4) : year;
  const toYear = givenFrom && givenFrom.slice(0, 4) > year ? givenFrom.slice(0, 4) : year;
  return { from: givenFrom || `${fromYear}-01-01`, to: givenTo || `${toYear}-12-31` };
}

// ── Data ─────────────────────────────────────────────────────────────────────

// Income counts once it is paid, on its invoice_date (the paid date for
// invoice-linked rows).
function paidIncome(from, to, cents) {
  const rows = db.prepare(`
    SELECT client_name, service_type, invoice_date AS date, amount, currency
    FROM revenue
    WHERE payment_status='Paid' AND invoice_date >= ? AND invoice_date <= ?
  `).all(from, to);
  for (const r of rows) r.cents = cents(r.amount, r.currency);
  return rows;
}

// Expenses count on their payment_date. Payroll is already in here under the
// 'Salaries' category, so salary_payments is never added to an expense total.
function expensesBetween(from, to, cents, columns = 'category, payment_date, amount, currency') {
  const rows = db.prepare(`
    SELECT ${columns} FROM expenses
    WHERE payment_date >= ? AND payment_date <= ?
    ORDER BY payment_date DESC, id DESC
  `).all(from, to);
  for (const r of rows) r.cents = cents(r.amount, r.currency);
  return rows;
}

// Groups rows by key → [{ key, cents, count }], largest total first.
function totalsBy(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!groups.has(key)) groups.set(key, { key, cents: 0, count: 0 });
    const group = groups.get(key);
    group.cents += r.cents;
    group.count += 1;
  }
  return [...groups.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
}

// Totals per month, oldest first, with empty months listed as zero so a chart
// shows the gap instead of closing it.
function monthlyTotals(rows, dateOf, from, to) {
  const byMonth = new Map(totalsBy(rows, (r) => monthOf(dateOf(r))).map((g) => [g.key, g.cents]));
  const first = `${monthOf(from)}-01`;
  const span = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
    + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  const months = span <= MAX_FILLED_MONTHS
    ? Array.from({ length: span }, (_, i) => monthOf(shiftDate(first, { months: i })))
    : [...byMonth.keys()].sort();
  return months.map((month) => ({ month, total: money(byMonth.get(month) || 0) }));
}

// Whole calendar days from one YYYY-MM-DD date to another.
function daysBetween(from, to) {
  const at = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  const days = Math.round((at(to) - at(from)) / DAY_MS);
  return Number.isFinite(days) ? days : 0;
}

function ageBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

// ── Profit and loss ──────────────────────────────────────────────────────────
// ?month=YYYY-MM for one month, otherwise ?year=YYYY (default: the current year).
router.get('/pl', wrap((req, res) => {
  const month = v.month(req.query.month, 'Month');
  let period;
  let startDate;
  let endDate;
  if (month) {
    const range = monthRange(month);
    period = range.label;
    startDate = range.start;
    endDate = range.end;
  } else {
    const year = readYear(req.query.year);
    period = `Year ${year}`;
    startDate = `${year}-01-01`;
    endDate = `${year}-12-31`;
  }

  const { base, cents } = converter();
  const income = paidIncome(startDate, endDate, cents);
  const categories = totalsBy(expensesBetween(startDate, endDate, cents), categoryOf);

  const revenue = sumCents(income);
  const totalExpenses = categories.reduce((sum, c) => sum + c.cents, 0);
  const salaries = categories.find((c) => c.key === 'Salaries')?.cents || 0;
  const opsExpenses = totalExpenses - salaries;
  const netProfit = revenue - totalExpenses;

  res.json({
    base_currency: base,
    period,
    startDate,
    endDate,
    revenue: money(revenue),
    revenueByService: totalsBy(income, (r) => labelOr(r.service_type, 'Other'))
      .map((g) => ({ service_type: g.key, total: money(g.cents) })),
    expenses: categories.map((c) => ({ category: c.key, total: money(c.cents) })),
    totalExpenses: money(totalExpenses),
    salaries: money(salaries),
    opsExpenses: money(opsExpenses),
    grossProfit: money(revenue - opsExpenses),
    netProfit: money(netProfit),
    profitMargin: revenue > 0 ? percent(netProfit, revenue) : 0,
  });
}));

// ── Income ───────────────────────────────────────────────────────────────────
router.get('/revenue', wrap((req, res) => {
  const { from, to } = readPeriod(req.query);
  const { base, cents } = converter();
  const income = paidIncome(from, to, cents);

  res.json({
    base_currency: base,
    total: money(sumCents(income)),
    byClient: totalsBy(income, (r) => labelOr(r.client_name, 'Unknown'))
      .map((g) => ({ client_name: g.key, total: money(g.cents), count: g.count })),
    byService: totalsBy(income, (r) => labelOr(r.service_type, 'Other'))
      .map((g) => ({ service_type: g.key, total: money(g.cents) })),
    byMonth: monthlyTotals(income, (r) => r.date, from, to),
    period: { from, to },
  });
}));

// ── Expenses ─────────────────────────────────────────────────────────────────
router.get('/expenses', wrap((req, res) => {
  const { from, to } = readPeriod(req.query);
  const { base, cents } = converter();
  const rows = expensesBetween(from, to, cents, '*');

  res.json({
    base_currency: base,
    total: money(sumCents(rows)),
    byCategory: totalsBy(rows, categoryOf)
      .map((g) => ({ category: g.key, total: money(g.cents), count: g.count })),
    byMonth: monthlyTotals(rows, (r) => r.payment_date, from, to),
    items: rows.map(({ cents: rowCents, ...row }) => ({ ...row, amount_base: money(rowCents) })),
    period: { from, to },
  });
}));

// ── Payroll ──────────────────────────────────────────────────────────────────
// Records keep their own currency; the totals are in the base currency.
router.get('/payroll', wrap((req, res) => {
  const month = v.month(req.query.month, 'Month') || today().slice(0, 7);
  const { base, cents } = converter();
  const records = db.prepare(`
    SELECT * FROM salary_payments WHERE payment_month=? ORDER BY employee_name COLLATE NOCASE, id
  `).all(month);

  const totals = { base: 0, bonuses: 0, deductions: 0, net: 0 };
  for (const r of records) {
    totals.base += cents(r.base_salary, r.currency);
    totals.bonuses += cents(r.bonuses, r.currency);
    totals.deductions += cents(r.deductions, r.currency);
    totals.net += cents(r.net_salary, r.currency);
  }

  res.json({
    base_currency: base,
    month,
    records,
    totals: {
      total_base: money(totals.base),
      total_bonuses: money(totals.bonuses),
      total_deductions: money(totals.deductions),
      total_net: money(totals.net),
      count: records.length,
      paid_count: records.filter((r) => r.status === 'Paid').length,
      pending_count: records.filter((r) => r.status === 'Pending').length,
    },
  });
}));

// ── Cash flow ────────────────────────────────────────────────────────────────
// Money received and paid out per month; `cumulative` is the running net
// since 1 January of that year.
router.get('/cashflow', wrap((req, res) => {
  const year = readYear(req.query.year);
  const { base, cents } = converter();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const monthCents = (rows, dateOf) =>
    new Map(totalsBy(rows, (r) => monthOf(dateOf(r))).map((g) => [g.key, g.cents]));
  const inflowByMonth = monthCents(paidIncome(from, to, cents), (r) => r.date);
  const outflowByMonth = monthCents(expensesBetween(from, to, cents), (r) => r.payment_date);

  const totals = { inflow: 0, outflow: 0 };
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const inflow = inflowByMonth.get(month) || 0;
    const outflow = outflowByMonth.get(month) || 0;
    totals.inflow += inflow;
    totals.outflow += outflow;
    return {
      month,
      label: monthLabel(month, 'MMM'),
      inflow: money(inflow),
      outflow: money(outflow),
      net: money(inflow - outflow),
      cumulative: money(totals.inflow - totals.outflow),
    };
  });

  res.json({
    base_currency: base,
    year: Number(year),
    months,
    totals: {
      inflow: money(totals.inflow),
      outflow: money(totals.outflow),
      net: money(totals.inflow - totals.outflow),
    },
  });
}));

// ── Receivables ageing ───────────────────────────────────────────────────────
// Unpaid invoices grouped by how long they are past their due date today.
router.get('/receivables', wrap((req, res) => {
  refreshOverdue();
  const { base, cents } = converter();
  const asOf = today();
  const rows = db.prepare(`
    SELECT id, invoice_number, client_name, issue_date, due_date, total, currency, status
    FROM invoices WHERE status IN ('Sent', 'Overdue')
    ORDER BY due_date, id
  `).all();

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const r of rows) {
    r.cents = cents(r.total, r.currency);
    r.days_overdue = Math.max(0, daysBetween(r.due_date, asOf));
    buckets[ageBucket(r.days_overdue)] += r.cents;
  }

  res.json({
    base_currency: base,
    as_of: asOf,
    total: money(sumCents(rows)),
    buckets: {
      current: money(buckets.current),
      d1_30: money(buckets.d1_30),
      d31_60: money(buckets.d31_60),
      d61_90: money(buckets.d61_90),
      d90_plus: money(buckets.d90_plus),
    },
    invoices: rows.map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      client_name: r.client_name,
      issue_date: r.issue_date,
      due_date: r.due_date,
      days_overdue: r.days_overdue,
      total: r.total,
      currency: r.currency || base,
      total_base: money(r.cents),
      status: r.status,
    })),
    byClient: totalsBy(rows, (r) => labelOr(r.client_name, 'Unknown'))
      .map((g) => ({ client_name: g.key, total: money(g.cents), count: g.count })),
  });
}));

module.exports = router;
