const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2 } = require('../lib/money');
const { BILLING_CYCLES } = require('../lib/dates');
const { baseCurrency } = require('../lib/settings');
const { baseConverter } = require('../services/currencyService');

// Income entries. Rows with auto_recorded = 1 mirror a paid invoice and are
// created and removed by the invoice routes; everything else is entered by hand.

const STATUSES = ['Pending', 'Paid'];
// The old system also allowed 'Overdue' on an entry; such rows can still be found and kept.
const FILTER_STATUSES = [...STATUSES, 'Overdue'];
const CYCLES = ['One-time', ...BILLING_CYCLES];
const LIKE = `LIKE ? ESCAPE '\\'`;

function dateRange(query, where, params) {
  const from = v.date(query.from, 'From date');
  const to = v.date(query.to, 'To date');
  if (from) { where.push('invoice_date >= ?'); params.push(from); }
  if (to) { where.push('invoice_date <= ?'); params.push(to); }
}

// The "recurring" flag and the billing cycle always agree: the flag decides
// when it is sent, otherwise the cycle does.
function readRecurrence(body) {
  const cycle = v.oneOf(body.billing_cycle, 'Billing cycle', CYCLES);
  const recurring = v.isBlank(body.is_recurring)
    ? cycle !== null && cycle !== 'One-time'
    : v.flag(body.is_recurring) === 1;
  if (!recurring) return { is_recurring: 0, billing_cycle: 'One-time' };
  return { is_recurring: 1, billing_cycle: cycle && cycle !== 'One-time' ? cycle : 'Monthly' };
}

// A manual entry, validated. `existing` is the stored row when editing.
function readEntry(body, existing = null) {
  const requestedClient = v.int(body.client_id, 'Client', { min: 1 });
  const client = requestedClient ? db.prepare('SELECT name FROM clients WHERE id=?').get(requestedClient) : null;
  // A client deleted since the form was opened: the entry keeps the typed name and loses the link.
  const clientId = client ? requestedClient : null;
  const clientName = v.str(body.client_name, 'Client name', { max: 200 }) || (client ? client.name : null);
  if (!clientName) throw new HttpError(400, 'Client name is required');

  const invoiceDate = v.date(body.invoice_date, 'Date', { required: true });
  const amount = round2(v.num(body.amount, 'Amount', { required: true }));
  if (amount <= 0) throw new HttpError(400, 'Amount must be greater than 0');

  // An edit that does not mention the status must never turn Pending into Paid.
  const current = existing ? existing.payment_status || 'Pending' : null;
  const allowed = current && !STATUSES.includes(current) ? [...STATUSES, current] : STATUSES;

  return {
    client_id: clientId,
    client_name: clientName,
    project_name: v.str(body.project_name, 'Project', { max: 200 }),
    service_type: v.str(body.service_type, 'Service type', { max: 100 }),
    invoice_number: v.str(body.invoice_number, 'Invoice number', { max: 50 }),
    invoice_date: invoiceDate,
    due_date: v.date(body.due_date, 'Due date'),
    amount,
    payment_status: v.oneOf(body.payment_status, 'Payment status', allowed, { def: current || 'Paid' }),
    payment_method: v.str(body.payment_method, 'Payment method', { max: 50 }),
    ...readRecurrence(body),
    currency: v.currency(body.currency, (existing && existing.currency) || baseCurrency()),
    notes: v.str(body.notes, 'Notes', { max: 2000 }),
  };
}

// The invoice an automatic income row belongs to. Rows carried over from the
// old system may only be linked by invoice number.
function invoiceOf(row) {
  if (row.invoice_id) return db.prepare('SELECT id, invoice_number, status FROM invoices WHERE id=?').get(row.invoice_id);
  if (row.invoice_number) {
    return db.prepare('SELECT id, invoice_number, status FROM invoices WHERE invoice_number=?').get(row.invoice_number);
  }
  return undefined;
}

router.get('/', wrap((req, res) => {
  const status = v.oneOf(req.query.status, 'Status', FILTER_STATUSES);
  const search = v.str(req.query.search, 'Search', { max: 100 });

  const where = [];
  const params = [];
  if (status) { where.push('payment_status = ?'); params.push(status); }
  if (search) {
    const term = v.like(search);
    where.push(`(client_name ${LIKE} OR project_name ${LIKE} OR service_type ${LIKE} OR invoice_number ${LIKE})`);
    params.push(term, term, term, term);
  }
  dateRange(req.query, where, params);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM revenue ${clause} ORDER BY invoice_date DESC, id DESC`).all(...params));
}));

// Declared before the /:id routes so "stats" is never read as an id.
router.get('/stats', wrap((req, res) => {
  const where = [];
  const params = [];
  dateRange(req.query, where, params);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT client_name, service_type, payment_status, amount, currency FROM revenue ${clause}
  `).all(...params);

  // Entries can be in any currency: convert each one, then add up.
  const fx = baseConverter();
  const byClient = new Map();
  const byService = new Map();
  const byStatus = new Map(STATUSES.map((s) => [s, { payment_status: s, count: 0, total: 0 }]));

  for (const r of rows) {
    const amount = fx.toBase(r.amount, r.currency);
    const status = r.payment_status || 'Pending';

    if (!byStatus.has(status)) byStatus.set(status, { payment_status: status, count: 0, total: 0 });
    const s = byStatus.get(status);
    s.count += 1;
    s.total += amount;

    // Only money actually received counts towards a client or a service.
    if (status !== 'Paid') continue;

    const clientName = r.client_name || 'Unknown';
    if (!byClient.has(clientName)) byClient.set(clientName, { client_name: clientName, total: 0, count: 0 });
    const c = byClient.get(clientName);
    c.total += amount;
    c.count += 1;

    const service = String(r.service_type || '').trim() || 'Other';
    if (!byService.has(service)) byService.set(service, { service_type: service, total: 0 });
    byService.get(service).total += amount;
  }

  const rounded = (list) => list.map((x) => ({ ...x, total: round2(x.total) }));
  const byTotal = (a, b) => b.total - a.total;

  res.json({
    base_currency: fx.base,
    byClient: rounded([...byClient.values()])
      .sort((a, b) => byTotal(a, b) || a.client_name.localeCompare(b.client_name))
      .slice(0, 10),
    byService: rounded([...byService.values()])
      .sort((a, b) => byTotal(a, b) || a.service_type.localeCompare(b.service_type)),
    byStatus: rounded([...byStatus.values()]),
  });
}));

router.post('/', wrap((req, res) => {
  const entry = readEntry(req.body || {});
  const result = db.prepare(`
    INSERT INTO revenue (client_id, client_name, project_name, service_type, invoice_number, invoice_date, due_date,
      amount, payment_status, payment_method, is_recurring, billing_cycle, currency, notes, auto_recorded)
    VALUES (@client_id, @client_name, @project_name, @service_type, @invoice_number, @invoice_date, @due_date,
      @amount, @payment_status, @payment_method, @is_recurring, @billing_cycle, @currency, @notes, 0)
  `).run(entry);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const row = db.prepare('SELECT * FROM revenue WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Income entry not found');
  const body = req.body || {};

  // Client, date, amount, currency and status of an automatic row belong to
  // its invoice; only the descriptive fields can be changed here.
  if (row.auto_recorded) {
    db.prepare(`
      UPDATE revenue SET project_name=?, service_type=?, payment_method=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      v.str(body.project_name, 'Project', { max: 200 }),
      v.str(body.service_type, 'Service type', { max: 100 }),
      v.str(body.payment_method, 'Payment method', { max: 50 }),
      v.str(body.notes, 'Notes', { max: 2000 }),
      id,
    );
    const source = row.invoice_number ? `invoice ${row.invoice_number}` : 'its invoice';
    return res.json({
      message: `Project, service type, payment method and notes saved. The other details come from ${source}.`,
      limited: true,
    });
  }

  const entry = readEntry(body, row);
  db.prepare(`
    UPDATE revenue SET client_id=@client_id, client_name=@client_name, project_name=@project_name,
      service_type=@service_type, invoice_number=@invoice_number, invoice_date=@invoice_date, due_date=@due_date,
      amount=@amount, payment_status=@payment_status, payment_method=@payment_method,
      is_recurring=@is_recurring, billing_cycle=@billing_cycle, currency=@currency, notes=@notes,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({ ...entry, id });
  res.json({ message: 'Income entry updated', limited: false });
}));

router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  const row = db.prepare('SELECT id, auto_recorded, invoice_id, invoice_number FROM revenue WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Income entry not found');

  // Deleting the income of a paid invoice here would leave the invoice Paid
  // with nothing recorded for it. A row whose invoice is gone can be removed.
  if (row.auto_recorded) {
    const invoice = invoiceOf(row);
    if (invoice && invoice.status === 'Paid') {
      throw new HttpError(400,
        `This income was recorded from invoice ${invoice.invoice_number}. Mark that invoice as unpaid instead.`);
    }
  }

  db.prepare('DELETE FROM revenue WHERE id=?').run(id);
  res.json({ message: 'Income entry deleted' });
}));

module.exports = router;
