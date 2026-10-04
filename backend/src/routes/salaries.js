const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2, symbolFor, formatMoney } = require('../lib/money');
const { today, thisMonth, monthRange, monthLabel } = require('../lib/dates');
const { getSettings, baseCurrency } = require('../lib/settings');
const { notify } = require('../lib/notify');
const { generateSalarySlipPDF } = require('../services/pdfService');
const { isEmailConfigured, sendSalarySlipEmail } = require('../services/emailService');

// Monthly payroll payments. Paid salaries are mirrored into the expenses table
// as one automatic "<Month> Payroll" row per currency (see syncPayrollExpense).
// Those rows are the payroll cost in the dashboard and the profit reports, so
// every change to a Paid salary has to re-sync them in the same transaction.

const SALARY_TYPES = ['Monthly', 'Project', 'Hourly'];
const STATUSES = ['Pending', 'Paid'];
const COLUMNS = `s.id, s.employee_id, s.employee_name, s.position, s.department, s.salary_type,
  s.base_salary, s.bonuses, s.deductions, s.net_salary, s.currency, s.payment_month, s.payment_date,
  s.payment_method, s.status, s.slip_sent, s.slip_sent_at, s.notes, s.created_at`;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = (value) => typeof value === 'string' && MONTH_RE.test(value);
const longMonth = (ym) => monthLabel(ym, 'MMMM yyyy');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Rows carried over from the old system can hold NULL or '' in these columns.
const currencyOf = (row, base = baseCurrency()) => String(row.currency || base).trim().toUpperCase() || base;
const dateOf = (value) => (value ? String(value).slice(0, 10) : null);
const nameKey = (name) => String(name || '').trim().toLowerCase();

function loadSalary(id) {
  const sal = db.prepare('SELECT * FROM salary_payments WHERE id=?').get(id);
  if (!sal) throw new HttpError(404, 'Salary record not found');
  return sal;
}

function netSalary(baseSalary, bonuses, deductions) {
  const net = round2(baseSalary + bonuses - deductions);
  if (net < 0) throw new HttpError(400, 'Deductions cannot be more than the salary plus bonuses');
  return net;
}

function insertSalary(s) {
  const result = db.prepare(`
    INSERT INTO salary_payments (employee_id, employee_name, position, department, salary_type,
      base_salary, bonuses, deductions, net_salary, payment_month, payment_method, status, notes, currency)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'Pending',?,?)
  `).run(s.employee_id, s.employee_name, s.position, s.department, s.salary_type,
    s.base_salary, s.bonuses, s.deductions, s.net_salary, s.payment_month, s.payment_method, s.notes, s.currency);
  return Number(result.lastInsertRowid);
}

// ── Payroll expense sync ─────────────────────────────────────────────────────
// Makes the automatic payroll expenses of one payroll month equal to its Paid
// salaries. There is one expense per currency AND per calendar month in which
// the money was actually paid, tagged source = "payroll:<month>:<CUR>:<paid month>".
// So a salary paid late lands in the month it left the bank, and paying it never
// moves salaries that were already reported in an earlier month.
// Call it inside the transaction that changed the salaries (it nests as a
// savepoint), so both always move together.
const syncPayrollExpense = db.transaction((month) => {
  // A carried-over row without a usable month has no payroll expense to keep in step.
  if (!isMonth(month)) return;

  const base = baseCurrency();
  const label = `${longMonth(month)} Payroll`;
  const prefix = `payroll:${month}:`;
  const notes = `Auto-recorded from payroll for ${month}`;

  // Totals are kept per currency, so nothing is ever added across currencies.
  const groups = new Map();
  const paid = db.prepare(`
    SELECT net_salary, currency, payment_date FROM salary_payments WHERE status='Paid' AND payment_month=?
  `).all(month);
  for (const row of paid) {
    const cur = currencyOf(row, base);
    // Paid rows from the old system may have no payment date at all.
    const paidOn = dateOf(row.payment_date) || fallbackPaymentDate(month);
    const paidMonth = paidOn.slice(0, 7);
    const key = `${cur}:${paidMonth}`;
    const group = groups.get(key) || { cur, paidMonth, total: 0, date: paidOn };
    group.total += Number(row.net_salary) || 0;
    if (paidOn > group.date) group.date = paidOn;
    groups.set(key, group);
  }

  // The old system kept one untagged "<Month> Payroll" expense per month. Only a
  // row it wrote itself (vendor and note exactly as it set them) is taken over;
  // an expense a person entered by hand with a similar title is left alone.
  const legacy = db.prepare(`
    SELECT id FROM expenses
    WHERE title=? AND category='Salaries' AND source IS NULL AND vendor='Payroll' AND notes=?
    ORDER BY id LIMIT 1
  `).get(label, notes);
  if (legacy) db.prepare('UPDATE expenses SET source=? WHERE id=?').run(`${prefix}legacy`, legacy.id);

  const managed = db.prepare('SELECT id, source FROM expenses WHERE source LIKE ?').all(`${prefix}%`);
  const bySource = new Map(managed.map((e) => [e.source, e]));

  for (const [key, group] of groups) {
    const source = prefix + key;
    const existing = bySource.get(source);
    bySource.delete(source);

    const title = label
      + (group.cur === base ? '' : ` (${group.cur})`)
      + (group.paidMonth === month ? '' : `, paid in ${longMonth(group.paidMonth)}`);
    const amount = round2(group.total);

    if (existing) {
      db.prepare(`
        UPDATE expenses SET title=?, category='Salaries', vendor='Payroll', amount=?, currency=?,
          payment_date=?, payment_method='Bank Transfer', notes=?
        WHERE id=?
      `).run(title, amount, group.cur, group.date, notes, existing.id);
    } else {
      db.prepare(`
        INSERT INTO expenses (title, category, vendor, amount, currency, payment_date, payment_method, notes, source)
        VALUES (?, 'Salaries', 'Payroll', ?, ?, ?, 'Bank Transfer', ?, ?)
      `).run(title, amount, group.cur, group.date, notes, source);
    }
  }

  // What is left has no paid salary behind it any more (or uses an older tag format).
  for (const stale of bySource.values()) db.prepare('DELETE FROM expenses WHERE id=?').run(stale.id);
});

// Last day of the payroll month, but never a date in the future.
function fallbackPaymentDate(month) {
  const { end } = monthRange(month);
  const now = today();
  return end > now ? now : end;
}

// ── Salary slips ─────────────────────────────────────────────────────────────

function payeeEmail(sal) {
  if (!sal.employee_id) return null;
  const row = db.prepare('SELECT email FROM employees WHERE id=?').get(sal.employee_id);
  return (row?.email && String(row.email).trim()) || null;
}

// A slip is always in the salary's own currency, not the company base currency.
function slipData(sal) {
  const currency = currencyOf(sal);
  return { ...sal, currency, currency_symbol: symbolFor(currency) };
}

const NO_SLIP_REASON = {
  no_address: 'this person has no email address',
  not_configured: 'email is not configured in Settings',
};

// Emails the slip. A PDF or mail problem is returned, not thrown, so the caller
// decides how to report it (paying a salary must not fail because of an email).
async function emailSlip(sal, to) {
  if (!to) return { sent: false, reason: 'no_address' };
  try {
    const settings = getSettings();
    if (!isEmailConfigured(settings)) return { sent: false, reason: 'not_configured' };
    const slip = slipData(sal);
    const pdf = await generateSalarySlipPDF(slip, settings);
    await sendSalarySlipEmail(slip, to, pdf, settings);
  } catch (err) {
    console.error(`Salary slip email failed (salary ${sal.id}): ${err.message}`);
    return { sent: false, reason: 'failed', error: err.message || 'unknown error' };
  }
  db.prepare('UPDATE salary_payments SET slip_sent=1, slip_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(sal.id);
  return { sent: true };
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/', wrap((req, res) => {
  const month = v.month(req.query.month, 'Month');
  const status = v.oneOf(req.query.status, 'Status', STATUSES);

  const where = [];
  const params = [];
  if (month) { where.push('s.payment_month = ?'); params.push(month); }
  if (status) { where.push('s.status = ?'); params.push(status); }

  const rows = db.prepare(`
    SELECT ${COLUMNS}, e.email AS employee_email
    FROM salary_payments s LEFT JOIN employees e ON e.id = s.employee_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.employee_name COLLATE NOCASE, s.payment_month DESC, s.id
  `).all(...params);

  const base = baseCurrency();
  res.json(rows.map((r) => ({ ...r, currency: currencyOf(r, base) })));
}));

router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const employeeId = v.int(body.employee_id, 'Person', { min: 1 });
  const payee = employeeId ? db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId) : null;
  if (employeeId && !payee) throw new HttpError(400, 'Selected person no longer exists');

  // Details left out of the request are copied from the selected person.
  const name = v.str(body.employee_name, 'Name', { max: 200 }) || payee?.name;
  if (!name) throw new HttpError(400, 'Name is required');
  const position = body.position === undefined ? payee?.position || null : v.str(body.position, 'Position', { max: 200 });
  const department = body.department === undefined ? payee?.department || null : v.str(body.department, 'Department', { max: 200 });
  const salaryType = v.oneOf(body.salary_type, 'Salary type', SALARY_TYPES, { def: payee?.salary_type || 'Monthly' });

  const baseSalary = round2(v.num(body.base_salary, 'Basic salary', { required: true, min: 0 }));
  const bonuses = round2(v.num(body.bonuses, 'Bonuses', { min: 0, def: 0 }));
  const deductions = round2(v.num(body.deductions, 'Deductions', { min: 0, def: 0 }));
  const net = netSalary(baseSalary, bonuses, deductions);

  const id = insertSalary({
    employee_id: employeeId,
    employee_name: name,
    position,
    department,
    salary_type: salaryType,
    base_salary: baseSalary,
    bonuses,
    deductions,
    net_salary: net,
    payment_month: v.month(body.payment_month, 'Payment month', { required: true }),
    payment_method: v.str(body.payment_method, 'Payment method', { max: 50 }) || 'Bank Transfer',
    notes: v.str(body.notes, 'Notes', { max: 2000 }),
    currency: v.currency(body.currency, payee?.currency || baseCurrency()),
  });
  res.status(201).json({ id, net_salary: net, message: 'Salary record added' });
}));

// Creates a Pending record for every active person who has none in that month yet.
router.post('/generate', wrap((req, res) => {
  const month = v.month(req.body?.payment_month, 'Payment month') || thisMonth();
  const label = longMonth(month);
  const base = baseCurrency();

  const payees = db.prepare(`SELECT * FROM employees WHERE status='Active' ORDER BY name COLLATE NOCASE, id`).all();
  if (payees.length === 0) throw new HttpError(400, 'Add people to payroll first');

  const created = db.transaction(() => {
    // Records typed in by hand have no link to a person, so those are matched by
    // name: skipping one is safer than generating a second salary for someone.
    const linked = new Set();
    const unlinkedNames = new Set();
    const existing = db.prepare('SELECT employee_id, employee_name FROM salary_payments WHERE payment_month=?').all(month);
    for (const row of existing) {
      if (row.employee_id) linked.add(Number(row.employee_id));
      else unlinkedNames.add(nameKey(row.employee_name));
    }

    let count = 0;
    for (const p of payees) {
      if (linked.has(p.id) || unlinkedNames.has(nameKey(p.name))) continue;
      const salary = Math.max(0, round2(p.base_salary));
      insertSalary({
        employee_id: p.id,
        employee_name: p.name,
        position: p.position || null,
        department: p.department || null,
        salary_type: p.salary_type || 'Monthly',
        base_salary: salary,
        bonuses: 0,
        deductions: 0,
        net_salary: salary,
        payment_month: month,
        payment_method: 'Bank Transfer',
        notes: null,
        currency: currencyOf(p, base),
      });
      count += 1;
    }
    return count;
  })();

  if (created === 0) throw new HttpError(400, `Payroll for ${label} is already generated`);
  const skipped = payees.length - created;
  res.json({
    created,
    skipped,
    message: `Created ${plural(created, 'salary record', 'salary records')} for ${label}`
      + (skipped ? ` (${plural(skipped, 'person', 'people')} already had one)` : ''),
  });
}));

// Marks the whole month as paid in one go. Slips are not emailed from here.
router.post('/pay-all', wrap((req, res) => {
  const month = v.month(req.body?.payment_month, 'Payment month', { required: true });
  const paymentDate = v.date(req.body?.payment_date, 'Payment date');
  const label = longMonth(month);

  const count = db.transaction(() => {
    // A date given here applies to every row; otherwise a date already entered on a row is kept.
    const result = db.prepare(`
      UPDATE salary_payments SET status='Paid', payment_date=COALESCE(?, NULLIF(payment_date, ''), ?)
      WHERE payment_month=? AND status='Pending'
    `).run(paymentDate, today(), month);
    if (result.changes > 0) {
      syncPayrollExpense(month);
      notify('success', 'Payroll paid', `${plural(result.changes, 'salary', 'salaries')} marked as paid for ${label}`);
    }
    return result.changes;
  })();

  res.json({
    count,
    message: count
      ? `${plural(count, 'salary', 'salaries')} marked as paid for ${label}`
      : `There are no pending salaries for ${label}`,
  });
}));

// Pending rows are not part of any payroll expense, so nothing needs re-syncing.
router.delete('/pending', wrap((req, res) => {
  const month = v.month(req.query.month, 'Month', { required: true });
  const result = db.prepare(`DELETE FROM salary_payments WHERE status='Pending' AND payment_month=?`).run(month);
  res.json({
    count: result.changes,
    message: `Deleted ${plural(result.changes, 'pending salary record', 'pending salary records')} for ${longMonth(month)}`,
  });
}));

// Never changes the status: use pay / unpay for that.
router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const body = req.body || {};
  const sal = loadSalary(id);
  // A field left out of the body keeps its stored value.
  const sent = (key) => body[key] !== undefined;

  const baseSalary = round2(sent('base_salary')
    ? v.num(body.base_salary, 'Basic salary', { required: true, min: 0 })
    : sal.base_salary);
  const bonuses = round2(sent('bonuses') ? v.num(body.bonuses, 'Bonuses', { min: 0, def: 0 }) : sal.bonuses);
  const deductions = round2(sent('deductions') ? v.num(body.deductions, 'Deductions', { min: 0, def: 0 }) : sal.deductions);
  const net = netSalary(baseSalary, bonuses, deductions);

  const isPaid = sal.status === 'Paid';
  let paymentDate = sent('payment_date') ? v.date(body.payment_date, 'Payment date') : dateOf(sal.payment_date);
  // A paid salary keeps its payment date: the payroll expense is dated by it.
  if (isPaid && !paymentDate) paymentDate = dateOf(sal.payment_date);

  const paymentMethod = sent('payment_method')
    ? v.str(body.payment_method, 'Payment method', { max: 50 }) || 'Bank Transfer'
    : sal.payment_method;
  const notes = sent('notes') ? v.str(body.notes, 'Notes', { max: 2000 }) : sal.notes;
  const currency = v.currency(body.currency, currencyOf(sal));

  db.transaction(() => {
    db.prepare(`
      UPDATE salary_payments SET base_salary=?, bonuses=?, deductions=?, net_salary=?,
        payment_date=?, payment_method=?, notes=?, currency=?
      WHERE id=?
    `).run(baseSalary, bonuses, deductions, net, paymentDate, paymentMethod, notes, currency, id);
    if (isPaid) syncPayrollExpense(sal.payment_month);
  })();
  res.json({ message: 'Salary record updated', net_salary: net });
}));

router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  const sal = loadSalary(id);
  db.transaction(() => {
    db.prepare('DELETE FROM salary_payments WHERE id=?').run(id);
    if (sal.status === 'Paid') syncPayrollExpense(sal.payment_month);
  })();
  res.json({ message: 'Salary record deleted' });
}));

router.post('/:id/pay', wrap(async (req, res) => {
  const id = v.id(req);
  const requestedDate = v.date(req.body?.payment_date, 'Payment date');

  const sal = db.transaction(() => {
    const row = loadSalary(id);
    if (row.status === 'Paid') throw new HttpError(400, 'This salary is already marked as paid');
    if (!isMonth(row.payment_month)) {
      throw new HttpError(400, 'This salary record has no valid payment month. Delete it and add it again.');
    }
    // A date already entered on the record is kept unless this request gives one.
    const paidOn = requestedDate || dateOf(row.payment_date) || today();
    db.prepare(`UPDATE salary_payments SET status='Paid', payment_date=? WHERE id=?`).run(paidOn, id);
    syncPayrollExpense(row.payment_month);
    notify('success', 'Salary paid',
      `${row.employee_name} was paid ${formatMoney(row.net_salary, currencyOf(row))} for ${longMonth(row.payment_month)}`,
      { relatedType: 'salary', relatedId: id });
    return loadSalary(id);
  })();

  // The payment is committed; whatever happens to the email cannot undo it.
  const to = payeeEmail(sal);
  const slip = await emailSlip(sal, to);
  let message;
  if (slip.sent) message = `Salary paid and the slip was emailed to ${to}`;
  else if (slip.reason === 'failed') message = `Salary marked as paid, but the slip email failed: ${slip.error}`;
  else message = `Salary marked as paid. No slip was emailed because ${NO_SLIP_REASON[slip.reason]}.`;
  res.json({ message, slipSent: slip.sent });
}));

router.post('/:id/unpay', wrap((req, res) => {
  const id = v.id(req);
  const sal = loadSalary(id);
  if (sal.status !== 'Paid') throw new HttpError(400, 'This salary is not marked as paid');

  db.transaction(() => {
    db.prepare(`UPDATE salary_payments SET status='Pending', payment_date=NULL WHERE id=?`).run(id);
    syncPayrollExpense(sal.payment_month);
  })();
  res.json({ message: 'Salary marked as unpaid' });
}));

router.post('/:id/send-slip', wrap(async (req, res) => {
  const sal = loadSalary(v.id(req));
  const to = v.email(req.body?.email, 'Email') || payeeEmail(sal);
  if (!to) {
    throw new HttpError(400, 'There is no email address for this person. Add one to their details or enter an address.');
  }

  const slip = await emailSlip(sal, to);
  if (slip.reason === 'not_configured') {
    throw new HttpError(400, 'Email is not configured. Add the SMTP details in Settings first.');
  }
  if (!slip.sent) throw new HttpError(400, `The slip could not be sent: ${slip.error}`);
  res.json({ message: `Salary slip sent to ${to}`, slipSent: true });
}));

router.get('/:id/pdf', wrap(async (req, res) => {
  const sal = loadSalary(v.id(req));
  const pdf = await generateSalarySlipPDF(slipData(sal), getSettings());
  const safeName = `${sal.employee_name}-${sal.payment_month}`.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="SalarySlip-${safeName}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
module.exports.syncPayrollExpense = syncPayrollExpense;
