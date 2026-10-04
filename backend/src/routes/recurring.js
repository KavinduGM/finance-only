const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2, formatMoney } = require('../lib/money');
const { today, nextCycleDate, BILLING_CYCLES } = require('../lib/dates');
const { baseCurrency } = require('../lib/settings');

const TYPES = ['Income', 'Expense'];
const STATUSES = ['Active', 'Paused', 'Cancelled'];
// The status list has no "finished" entry: a payment that does not renew ends as Cancelled.
const FINISHED_STATUS = 'Cancelled';

// v.date lets impossible days such as 2026-02-31 through (JavaScript rolls them
// into March), and the cycle arithmetic cannot work with those.
function calendarDate(value, name, opts) {
  const d = v.date(value, name, opts);
  if (d === null) return null;
  const [year, month, day] = d.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new HttpError(400, `${name} is not a real calendar date`);
  }
  if (year < 2000 || year > 2100) throw new HttpError(400, `${name} must be between the years 2000 and 2100`);
  return d;
}

// A date already stored on a row, or null when it is missing or unusable
// (rows from the old system were never validated).
function storedDate(value) {
  try {
    return calendarDate(value, 'Date');
  } catch {
    return null;
  }
}

const cycleOf = (row) => (BILLING_CYCLES.includes(row?.billing_cycle) ? row.billing_cycle : 'Monthly');
const renews = (row) => Number(row.auto_renewal ?? 1) !== 0;

// `existing` is the current row when editing: fields left out of the request keep their value.
function readRecurring(body, existing = null) {
  const name = v.str(body.name, 'Name', { required: true, max: 200 });
  const type = v.oneOf(body.type, 'Type', TYPES, { required: true });
  const amount = round2(v.num(body.amount, 'Amount', { required: true }));
  if (amount <= 0) throw new HttpError(400, 'Amount must be greater than 0');

  const keptReminderDays = Number.isInteger(existing?.reminder_days) ? Math.min(60, Math.max(0, existing.reminder_days)) : 3;
  const reminderDays = v.int(body.reminder_days, 'Reminder days', { def: keptReminderDays });
  if (reminderDays < 0 || reminderDays > 60) throw new HttpError(400, 'Reminder days must be between 0 and 60');

  return {
    name,
    type,
    category: v.str(body.category, 'Category', { max: 100 }),
    billing_cycle: v.oneOf(body.billing_cycle, 'Billing cycle', BILLING_CYCLES, { def: cycleOf(existing) }),
    amount,
    currency: v.currency(body.currency, existing?.currency || baseCurrency()),
    next_payment_date: calendarDate(body.next_payment_date, 'Next payment date', { required: true }),
    auto_renewal: v.isBlank(body.auto_renewal) ? (existing && !renews(existing) ? 0 : 1) : v.flag(body.auto_renewal),
    status: v.oneOf(body.status, 'Status', STATUSES, { def: existing?.status || 'Active' }),
    client_vendor: v.str(body.client_vendor, 'Client / vendor', { max: 200 }),
    email: v.email(body.email, 'Reminder email'),
    reminder_days: reminderDays,
    notes: v.str(body.notes, 'Notes', { max: 2000 }),
  };
}

router.get('/', wrap((req, res) => {
  const type = v.oneOf(req.query.type, 'Type', TYPES);
  const status = v.oneOf(req.query.status, 'Status', STATUSES);

  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }

  // Rows without a date (old data) go last instead of first.
  res.json(db.prepare(`
    SELECT * FROM recurring_payments
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY (next_payment_date IS NULL OR next_payment_date = ''), next_payment_date, id
  `).all(...params));
}));

router.post('/', wrap((req, res) => {
  const r = readRecurring(req.body || {});
  const result = db.prepare(`
    INSERT INTO recurring_payments (name, type, category, billing_cycle, amount, currency, next_payment_date,
      auto_renewal, status, client_vendor, email, reminder_days, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(r.name, r.type, r.category, r.billing_cycle, r.amount, r.currency, r.next_payment_date,
    r.auto_renewal, r.status, r.client_vendor, r.email, r.reminder_days, r.notes);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const existing = db.prepare('SELECT * FROM recurring_payments WHERE id=?').get(id);
  if (!existing) throw new HttpError(404, 'Recurring payment not found');

  const r = readRecurring(req.body || {}, existing);
  // A reminder already sent was for the old date; a new date gets its own reminder.
  const lastReminder = existing.next_payment_date === r.next_payment_date ? existing.last_reminder_sent : null;

  db.prepare(`
    UPDATE recurring_payments SET name=?, type=?, category=?, billing_cycle=?, amount=?, currency=?,
      next_payment_date=?, auto_renewal=?, status=?, client_vendor=?, email=?, reminder_days=?, notes=?,
      last_reminder_sent=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(r.name, r.type, r.category, r.billing_cycle, r.amount, r.currency,
    r.next_payment_date, r.auto_renewal, r.status, r.client_vendor, r.email, r.reminder_days, r.notes,
    lastReminder ?? null, id);
  res.json({ message: 'Recurring payment updated' });
}));

// Income and expenses already recorded from this item stay in the books.
router.delete('/:id', wrap((req, res) => {
  const result = db.prepare('DELETE FROM recurring_payments WHERE id=?').run(v.id(req));
  if (!result.changes) throw new HttpError(404, 'Recurring payment not found');
  res.json({ message: 'Recurring payment deleted' });
}));

// `record` decides whether money is written to the books, so only a clear
// yes or no is accepted rather than guessing from an unexpected value.
function readRecordFlag(value) {
  if (v.isBlank(value)) return true;
  if ([true, 1, '1', 'true'].includes(value)) return true;
  if ([false, 0, '0', 'false'].includes(value)) return false;
  throw new HttpError(400, 'Record must be true or false');
}

// Writes the income or expense row for one occurrence. Runs inside the
// transaction of /process. `occurrence` is the due date being settled.
function recordOccurrence(item, occurrence, paidDate) {
  const amount = round2(item.amount);
  if (amount <= 0) {
    throw new HttpError(400, 'Set an amount greater than 0 on this recurring payment before recording it');
  }
  const currency = item.currency || baseCurrency();
  const name = item.name || 'Recurring payment';

  if (item.type === 'Expense') {
    try {
      const result = db.prepare(`
        INSERT INTO expenses (title, category, vendor, amount, currency, payment_date,
          is_recurring, billing_cycle, notes, source)
        VALUES (?,?,?,?,?,?,1,?,?,?)
      `).run(name, item.category || 'Recurring', item.client_vendor || null, amount, currency, paidDate,
        cycleOf(item), item.notes || null, `recurring:${item.id}:${occurrence}`);
      return { type: 'expense', id: Number(result.lastInsertRowid), amount, currency };
    } catch (err) {
      // The unique index on expenses.source is what stops an occurrence being recorded twice.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'This payment was already recorded', 'ALREADY_RECORDED');
      throw err;
    }
  }

  if (item.type === 'Income') {
    // due_date keeps the occurrence this income settles, as invoice income keeps the invoice due date.
    try {
      const result = db.prepare(`
        INSERT INTO revenue (client_name, service_type, amount, currency, invoice_date, due_date,
          payment_status, is_recurring, billing_cycle, notes, source)
        VALUES (?,?,?,?,?,?,'Paid',1,?,?,?)
      `).run(item.client_vendor || name, item.category || null, amount, currency, paidDate, occurrence,
        cycleOf(item), `Recurring: ${name}`, `recurring:${item.id}:${occurrence}`);
      return { type: 'income', id: Number(result.lastInsertRowid), amount, currency };
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'This payment was already recorded', 'ALREADY_RECORDED');
      throw err;
    }
  }

  throw new HttpError(400, 'Set the type to Income or Expense before recording this payment');
}

// Pause or resume only. Nothing else on the item is touched, so a list that is
// out of date cannot write old amounts or dates back.
router.post('/:id/status', wrap((req, res) => {
  const id = v.id(req);
  const status = v.oneOf(req.body?.status, 'Status', ['Active', 'Paused'], { required: true });
  const result = db.prepare('UPDATE recurring_payments SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, id);
  if (!result.changes) throw new HttpError(404, 'Recurring payment not found');
  res.json({ message: status === 'Paused' ? 'Recurring payment paused' : 'Recurring payment resumed', status });
}));

// Settles the current occurrence: records the money (unless record is false),
// then moves to the next cycle or closes an item that does not renew.
router.post('/:id/process', wrap((req, res) => {
  const id = v.id(req);
  const body = req.body || {};
  const record = readRecordFlag(body.record);
  const paidDate = calendarDate(body.paid_date, 'Paid date') || today();
  // Optional: the due date the caller believes it is settling. With it, a second
  // click or a stale tab gets a 409 instead of settling the following occurrence too.
  const expected = calendarDate(body.occurrence_date, 'Occurrence date');

  const outcome = db.transaction(() => {
    const item = db.prepare('SELECT * FROM recurring_payments WHERE id=?').get(id);
    if (!item) throw new HttpError(404, 'Recurring payment not found');

    // Also what stops a payment that does not renew from being recorded again
    // once it has been closed.
    const status = item.status || 'Active';
    if (status !== 'Active') {
      throw new HttpError(400, `Only active recurring payments can be processed. This one is ${status}.`);
    }
    const occurrence = storedDate(item.next_payment_date);
    if (!occurrence) {
      throw new HttpError(400, 'Set a valid next payment date on this recurring payment before processing it');
    }
    if (expected && expected !== occurrence) {
      throw new HttpError(409,
        'This payment was already recorded or its date has changed. The list has been refreshed; check it again.',
        'OCCURRENCE_CHANGED');
    }

    const recorded = record ? recordOccurrence(item, occurrence, paidDate) : null;

    let next = null;
    if (renews(item)) {
      next = nextCycleDate(occurrence, cycleOf(item));
      db.prepare(`
        UPDATE recurring_payments
        SET last_processed_date=?, next_payment_date=?, last_reminder_sent=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(today(), next, id);
    } else {
      db.prepare(`
        UPDATE recurring_payments SET last_processed_date=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(today(), FINISHED_STATUS, id);
    }

    const label = item.name || 'Recurring payment';
    const what = recorded
      ? `${label}: ${formatMoney(recorded.amount, recorded.currency)} recorded as ${recorded.type === 'income' ? 'income' : 'an expense'}.`
      : `${label}: skipped without recording a payment.`;
    const then = next
      ? `Next payment is due on ${next}.`
      : `It does not renew, so it is now marked as ${FINISHED_STATUS}.`;

    return {
      message: `${what} ${then}`,
      next_payment_date: next,
      status: next ? status : FINISHED_STATUS,
      recorded: recorded ? { type: recorded.type, id: recorded.id } : null,
    };
  })();

  res.json(outcome);
}));

module.exports = router;
