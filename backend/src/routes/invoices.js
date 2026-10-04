const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2, formatMoney, symbolFor } = require('../lib/money');
const { today, shiftDate } = require('../lib/dates');
const { getSettings, baseCurrency } = require('../lib/settings');
const { notify } = require('../lib/notify');
const {
  readClientFields, readTotals, replaceItems, loadInvoice, createInvoice, refreshOverdue,
} = require('../services/invoiceService');
const { generateInvoicePDF } = require('../services/pdfService');
const { isEmailConfigured, sendInvoiceEmail } = require('../services/emailService');

const STATUSES = ['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'];
const LIKE = `LIKE ? ESCAPE '\\'`;

// The income row that mirrors a paid invoice. Rows carried over from the old
// system were matched by invoice number and may not have an invoice_id.
const AUTO_INCOME = 'auto_recorded = 1 AND (invoice_id = ? OR (invoice_id IS NULL AND invoice_number = ?))';

const isPastDue = (dueDate) => !!dueDate && String(dueDate).slice(0, 10) < today();

// A client link is only copied while the client record still exists.
const existingClientId = (clientId) =>
  (clientId && db.prepare('SELECT 1 FROM clients WHERE id=?').get(clientId) ? clientId : null);

// Everything a create or an edit accepts, validated. The caller decides the status.
function readInvoiceBody(body, fallbackCurrency) {
  const client = readClientFields(body);
  const issueDate = v.date(body.issue_date, 'Issue date', { required: true });
  const dueDate = v.date(body.due_date, 'Due date', { required: true });
  if (dueDate < issueDate) throw new HttpError(400, 'Due date cannot be before the issue date');
  return {
    ...client,
    issue_date: issueDate,
    due_date: dueDate,
    currency: v.currency(body.currency, fallbackCurrency),
    totals: readTotals(body),
    notes: v.str(body.notes, 'Notes', { max: 5000 }),
    terms: v.str(body.terms, 'Terms', { max: 5000 }),
  };
}

// The status an edit leaves the invoice in. Paid is only reached through
// mark-paid, which records the income, and Overdue only through the due date.
function statusAfterEdit(current, requested, dueDate) {
  if (requested === 'Paid') {
    throw new HttpError(400, 'Use "Mark as paid" to record a payment for this invoice');
  }
  if (requested === 'Overdue' && current !== 'Overdue') {
    throw new HttpError(400, 'Overdue is set automatically once the due date has passed');
  }
  const next = requested || current || 'Draft';
  if (current === 'Overdue' && (next === 'Overdue' || next === 'Sent')) {
    return isPastDue(dueDate) ? 'Overdue' : 'Sent';
  }
  return next;
}

// Creates the income row for a paid invoice, or brings the existing one in
// line with it, so an invoice never has more than one. Runs inside the
// mark-paid transaction. Project and service type are the user's own additions
// and survive, as do a payment method or notes entered earlier.
function recordAutoIncome(inv, { paidDate, paymentMethod, amount, currency }) {
  const fields = {
    client_id: existingClientId(inv.client_id),
    client_name: inv.client_name,
    invoice_number: inv.invoice_number,
    invoice_id: inv.id,
    invoice_date: paidDate,
    due_date: inv.due_date,
    amount,
    currency,
    payment_method: paymentMethod,
    notes: `Auto-recorded from invoice ${inv.invoice_number}`,
  };
  const [existing, ...duplicates] = db.prepare(`
    SELECT id FROM revenue WHERE ${AUTO_INCOME} ORDER BY (invoice_id IS NULL), id
  `).all(inv.id, inv.invoice_number);

  if (!existing) {
    const result = db.prepare(`
      INSERT INTO revenue (client_id, client_name, invoice_number, invoice_id, invoice_date, due_date,
        amount, currency, payment_status, payment_method, auto_recorded, notes)
      VALUES (@client_id, @client_name, @invoice_number, @invoice_id, @invoice_date, @due_date,
        @amount, @currency, 'Paid', @payment_method, 1, @notes)
    `).run(fields);
    return Number(result.lastInsertRowid);
  }

  db.prepare(`
    UPDATE revenue SET client_id=@client_id, client_name=@client_name, invoice_number=@invoice_number,
      invoice_id=@invoice_id, invoice_date=@invoice_date, due_date=@due_date, amount=@amount, currency=@currency,
      payment_status='Paid', payment_method=COALESCE(@payment_method, payment_method), auto_recorded=1,
      notes=COALESCE(NULLIF(TRIM(notes), ''), @notes), updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({ ...fields, id: existing.id });
  const remove = db.prepare('DELETE FROM revenue WHERE id=?');
  for (const d of duplicates) remove.run(d.id);
  return existing.id;
}

// Returns how many income rows were removed.
const removeAutoIncome = (inv) =>
  db.prepare(`DELETE FROM revenue WHERE ${AUTO_INCOME}`).run(inv.id, inv.invoice_number).changes;

router.get('/', wrap((req, res) => {
  const status = v.oneOf(req.query.status, 'Status', STATUSES);
  const search = v.str(req.query.search, 'Search', { max: 100 });

  refreshOverdue();

  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (search) {
    const term = v.like(search);
    where.push(`(client_name ${LIKE} OR client_company ${LIKE} OR invoice_number ${LIKE})`);
    params.push(term, term, term);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const invoices = db.prepare(`SELECT * FROM invoices ${clause} ORDER BY id DESC`).all(...params);
  const items = db.prepare(`
    SELECT * FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices ${clause}) ORDER BY id
  `).all(...params);

  const itemsByInvoice = new Map();
  for (const item of items) {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push(item);
  }
  for (const inv of invoices) inv.items = itemsByInvoice.get(inv.id) || [];
  res.json(invoices);
}));

router.get('/:id', wrap((req, res) => {
  const inv = loadInvoice(v.id(req));
  if (!inv) throw new HttpError(404, 'Invoice not found');
  res.json(inv);
}));

router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const data = readInvoiceBody(body, baseCurrency());
  data.status = v.oneOf(body.status, 'Status', ['Draft', 'Sent'], { def: 'Draft' });
  res.status(201).json(createInvoice(data));
}));

router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const inv = db.prepare('SELECT id, status, currency FROM invoices WHERE id=?').get(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  // The income row copies a paid invoice's total, so the two cannot drift apart.
  if (inv.status === 'Paid') throw new HttpError(400, 'Mark this invoice as unpaid before editing it');

  const body = req.body || {};
  const data = readInvoiceBody(body, inv.currency || baseCurrency());
  const status = statusAfterEdit(inv.status, v.oneOf(body.status, 'Status', STATUSES), data.due_date);
  const t = data.totals;

  db.transaction(() => {
    db.prepare(`
      UPDATE invoices SET client_id=@client_id, client_name=@client_name, client_email=@client_email,
        client_address=@client_address, client_company=@client_company,
        issue_date=@issue_date, due_date=@due_date,
        subtotal=@subtotal, tax_rate=@tax_rate, tax_amount=@tax_amount, discount=@discount, total=@total,
        status=@status, notes=@notes, terms=@terms, currency=@currency, currency_symbol=@currency_symbol,
        -- A new due date starts the reminders again (the right-hand sides see the old row).
        reminder_count = CASE WHEN due_date IS NOT @due_date THEN 0 ELSE reminder_count END,
        last_reminder_at = CASE WHEN due_date IS NOT @due_date THEN NULL ELSE last_reminder_at END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=@id
    `).run({
      id,
      client_id: data.client_id,
      client_name: data.client_name,
      client_email: data.client_email,
      client_address: data.client_address,
      client_company: data.client_company,
      issue_date: data.issue_date,
      due_date: data.due_date,
      subtotal: t.subtotal,
      tax_rate: t.tax_rate,
      tax_amount: t.tax_amount,
      discount: t.discount,
      total: t.total,
      status,
      notes: data.notes,
      terms: data.terms,
      currency: data.currency,
      currency_symbol: symbolFor(data.currency),
    });
    replaceItems('invoice_items', 'invoice_id', id, t.lines);
  })();
  res.json({ message: 'Invoice updated', status });
}));

// Status-only change (cancel, reopen). The document is left exactly as it is,
// so an older invoice can be cancelled without its totals being recalculated.
router.post('/:id/status', wrap((req, res) => {
  const id = v.id(req);
  const inv = db.prepare('SELECT id, status, due_date FROM invoices WHERE id=?').get(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'Paid') throw new HttpError(400, 'Mark this invoice as unpaid before changing its status');

  const requested = v.oneOf(req.body?.status, 'Status', ['Draft', 'Sent', 'Cancelled'], { required: true });
  // Reopening as Sent an invoice that is already past due goes straight to Overdue.
  const status = requested === 'Sent' && isPastDue(inv.due_date) ? 'Overdue' : requested;
  db.prepare('UPDATE invoices SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, id);
  res.json({ message: status === 'Cancelled' ? 'Invoice cancelled' : `Invoice marked as ${status.toLowerCase()}`, status });
}));

router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  const inv = db.prepare('SELECT id, invoice_number FROM invoices WHERE id=?').get(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');

  const incomeRemoved = db.transaction(() => {
    const removed = removeAutoIncome(inv);
    // updated_at is left alone: it dates the decision on proposals that have no decided_at.
    db.prepare('UPDATE proposals SET invoice_id=NULL WHERE invoice_id=?').run(id);
    db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(id);
    db.prepare('DELETE FROM invoices WHERE id=?').run(id);
    return removed;
  })();

  res.json({
    message: incomeRemoved
      ? `Invoice ${inv.invoice_number} deleted and its income entry removed`
      : `Invoice ${inv.invoice_number} deleted`,
  });
}));

// Invoices being emailed right now, so a double click cannot send the same one twice.
const sending = new Set();

router.post('/:id/send', wrap(async (req, res) => {
  const id = v.id(req);
  const inv = loadInvoice(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'Cancelled') {
    throw new HttpError(400, 'This invoice is cancelled. Change its status before sending it.');
  }
  if (sending.has(id)) throw new HttpError(409, 'This invoice is already being sent');

  // Only a Draft moves; a Paid or Overdue invoice can be re-sent without losing its status.
  const wasDraft = inv.status === 'Draft';
  if (wasDraft) {
    db.prepare(`UPDATE invoices SET status='Sent', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='Draft'`).run(id);
    inv.status = 'Sent';
  }

  const number = inv.invoice_number;
  const notEmailed = (reason) => res.json({
    emailSent: false,
    status: inv.status,
    message: `${wasDraft ? `Invoice ${number} marked as sent, but not emailed` : `Invoice ${number} was not emailed`}: ${reason}`,
  });

  if (!inv.client_email) return notEmailed('the client has no email address.');
  const settings = getSettings();
  if (!isEmailConfigured(settings)) return notEmailed('email is not set up yet (see Settings, Email).');

  sending.add(id);
  try {
    const pdf = await generateInvoicePDF(inv, settings);
    await sendInvoiceEmail(inv, pdf, settings);
  } catch (err) {
    const reason = (err && err.message) || String(err);
    console.error(`Invoice ${number} could not be emailed: ${reason}`);
    return notEmailed(`the email failed (${reason}).`);
  } finally {
    sending.delete(id);
  }

  db.prepare('UPDATE invoices SET email_sent=1, email_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
  res.json({ emailSent: true, status: inv.status, message: `Invoice ${number} emailed to ${inv.client_email}` });
}));

router.post('/:id/mark-paid', wrap((req, res) => {
  const id = v.id(req);
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status === 'Paid') throw new HttpError(400, 'This invoice is already marked as paid');
  if (inv.status === 'Cancelled') throw new HttpError(400, 'A cancelled invoice cannot be marked as paid');

  const body = req.body || {};
  const paidDate = v.date(body.paid_date, 'Paid date') || today();
  const paymentMethod = v.str(body.payment_method, 'Payment method', { max: 50 });
  const currency = inv.currency || baseCurrency();
  const amount = round2(inv.total);

  const revenueId = db.transaction(() => {
    db.prepare(`
      UPDATE invoices SET status='Paid', status_before_paid=?, paid_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(inv.status, paidDate, id);
    const rowId = recordAutoIncome(inv, { paidDate, paymentMethod, amount, currency });
    notify('success', 'Invoice paid',
      `Invoice ${inv.invoice_number} for ${inv.client_name} was paid. ${formatMoney(amount, currency)} recorded as income.`,
      { relatedType: 'invoice', relatedId: id });
    return rowId;
  })();

  // An entry typed in by hand for the same invoice would count the payment twice.
  const manual = db.prepare(`
    SELECT COUNT(*) AS n FROM revenue WHERE invoice_number = ? AND COALESCE(auto_recorded, 0) = 0
  `).get(inv.invoice_number).n;
  const warning = manual
    ? 'Income already has a manual entry with this invoice number. Check that the payment is not counted twice.'
    : null;

  res.json({
    message: `Invoice ${inv.invoice_number} marked as paid and recorded as income.${warning ? ` ${warning}` : ''}`,
    paid_date: paidDate,
    revenue_id: revenueId,
    warning,
  });
}));

router.post('/:id/mark-unpaid', wrap((req, res) => {
  const id = v.id(req);
  const inv = db.prepare('SELECT id, invoice_number, status, status_before_paid, due_date FROM invoices WHERE id=?').get(id);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status !== 'Paid') throw new HttpError(400, 'Only a paid invoice can be marked as unpaid');

  // An invoice that was paid while still a draft goes back to being a draft:
  // the client never received it, so it must not start getting reminders.
  const status = inv.status_before_paid === 'Draft' ? 'Draft' : (isPastDue(inv.due_date) ? 'Overdue' : 'Sent');
  const incomeRemoved = db.transaction(() => {
    const removed = removeAutoIncome(inv);
    db.prepare(`
      UPDATE invoices SET status=?, status_before_paid=NULL, paid_date=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(status, id);
    return removed;
  })();

  // Invoices set to Paid by hand in the old system never had an income entry.
  res.json({
    message: `Invoice ${inv.invoice_number} marked as unpaid${incomeRemoved ? ' and its income entry removed' : ''}. It is now ${status}.`,
    status,
  });
}));

router.post('/:id/duplicate', wrap((req, res) => {
  const inv = loadInvoice(v.id(req));
  if (!inv) throw new HttpError(404, 'Invoice not found');

  // Totals are rebuilt from the lines so the copy follows the current rounding
  // and tax rules even when the original came from the old system.
  let totals;
  try {
    totals = readTotals({ items: inv.items, tax_rate: inv.tax_rate, discount: inv.discount }, { stored: true });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    throw new HttpError(400, `This invoice cannot be duplicated as it is. ${err.message}`);
  }

  const dueDays = getSettings().invoice_due_days;
  const issueDate = today();
  const created = createInvoice({
    client_id: existingClientId(inv.client_id),
    client_name: inv.client_name,
    client_email: inv.client_email,
    client_address: inv.client_address,
    client_company: inv.client_company,
    issue_date: issueDate,
    due_date: shiftDate(issueDate, { days: Number.isInteger(dueDays) && dueDays >= 0 ? dueDays : 30 }),
    currency: inv.currency || baseCurrency(),
    totals,
    notes: inv.notes,
    terms: inv.terms,
    status: 'Draft',
  });
  res.status(201).json(created);
}));

router.get('/:id/pdf', wrap(async (req, res) => {
  const inv = loadInvoice(v.id(req));
  if (!inv) throw new HttpError(404, 'Invoice not found');

  const pdf = await generateInvoicePDF(inv, getSettings());
  const safeName = String(inv.invoice_number).replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${v.flag(req.query.inline) ? 'inline' : 'attachment'}; filename="Invoice-${safeName}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
