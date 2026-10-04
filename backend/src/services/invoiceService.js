const db = require('../database');
const { HttpError, v } = require('../lib/http');
const { computeDocumentTotals, symbolFor, formatMoney } = require('../lib/money');
const { notify } = require('../lib/notify');
const { nextNumber } = require('../lib/numbering');
const { today } = require('../lib/dates');
const { baseCurrency } = require('../lib/settings');

// Shared by the invoice and proposal routes (a proposal converts into an invoice).

// Client details are copied onto each document so it stays accurate even if
// the client record is later edited or deleted.
function readClientFields(body) {
  // A client deleted since the form was opened: the document keeps the copied
  // name and address and simply loses the link.
  const requested = v.int(body.client_id, 'Client', { min: 1 });
  const clientId = requested && db.prepare('SELECT 1 FROM clients WHERE id=?').get(requested) ? requested : null;
  return {
    client_id: clientId,
    client_name: v.str(body.client_name, 'Client name', { required: true, max: 200 }),
    client_email: v.email(body.client_email, 'Client email'),
    client_company: v.str(body.client_company, 'Client company', { max: 200 }),
    client_address: v.str(body.client_address, 'Client address', { max: 500 }),
  };
}

// Line items + tax + discount → cleaned lines and totals (400 on bad input).
// Pass { stored: true } when the lines come from the database rather than a form.
function readTotals(body, options = {}) {
  // Checked here so "abc" or "1,000" is rejected or parsed, never silently treated as 0.
  const taxRate = v.num(body.tax_rate, 'Tax rate', { def: 0, min: 0, max: 100 });
  const discount = v.num(body.discount, 'Discount', { def: 0, min: 0 });
  try {
    return computeDocumentTotals(body.items, taxRate, discount, options);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

function insertItems(table, fkColumn, docId, lines) {
  const stmt = db.prepare(`INSERT INTO ${table} (${fkColumn}, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)`);
  for (const l of lines) stmt.run(docId, l.description, l.quantity, l.unit_price, l.amount);
}

function replaceItems(table, fkColumn, docId, lines) {
  db.prepare(`DELETE FROM ${table} WHERE ${fkColumn}=?`).run(docId);
  insertItems(table, fkColumn, docId, lines);
}

function loadInvoice(id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  if (!inv) return null;
  inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id').all(id);
  return inv;
}

// `data` is already validated: client fields, dates, currency, totals (from readTotals).
// Safe to call inside another transaction.
const createInvoice = db.transaction((data) => {
  const currency = data.currency || baseCurrency();
  const number = nextNumber('invoice');
  const t = data.totals;
  const result = db.prepare(`
    INSERT INTO invoices (invoice_number, client_id, client_name, client_email, client_address, client_company,
      issue_date, due_date, subtotal, tax_rate, tax_amount, discount, total,
      status, notes, terms, currency, currency_symbol, proposal_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(number, data.client_id || null, data.client_name, data.client_email || null,
    data.client_address || null, data.client_company || null,
    data.issue_date, data.due_date, t.subtotal, t.tax_rate, t.tax_amount, t.discount, t.total,
    data.status || 'Draft', data.notes || null, data.terms || null, currency, symbolFor(currency),
    data.proposal_id || null);
  insertItems('invoice_items', 'invoice_id', result.lastInsertRowid, t.lines);
  return { id: Number(result.lastInsertRowid), invoice_number: number };
});

// Sent invoices past their due date become Overdue, with one notification each.
// Cheap enough to run before every listing, so the status is right even between
// the hourly job runs; the notification is raised here so it does not matter
// whether a page load or the scheduler notices first.
const refreshOverdue = db.transaction(() => {
  const enabled = db.prepare('SELECT overdue_check_enabled AS on_ FROM settings WHERE id=1').get()?.on_;
  if (enabled === 0) return [];
  const day = today();
  const rows = db.prepare(`
    SELECT id, invoice_number, client_name, due_date, total, currency FROM invoices
    WHERE status='Sent' AND due_date < ?
  `).all(day);
  if (!rows.length) return rows;

  db.prepare(`UPDATE invoices SET status='Overdue', updated_at=CURRENT_TIMESTAMP WHERE status='Sent' AND due_date < ?`).run(day);
  const base = baseCurrency();
  for (const inv of rows) {
    notify('warning', 'Invoice overdue',
      `Invoice ${inv.invoice_number} for ${inv.client_name} (${formatMoney(inv.total, inv.currency || base)}) `
        + `was due on ${inv.due_date} and has not been paid.`,
      { dedupeKey: `invoice-overdue:${inv.id}:${inv.due_date}`, relatedType: 'invoice', relatedId: inv.id });
  }
  return rows;
});

// Sent proposals past their validity date become Expired, with one notification
// each. Draft, Accepted and Declined proposals are never touched.
const expireProposals = db.transaction(() => {
  const day = today();
  const rows = db.prepare(`
    SELECT id, proposal_number, client_name, valid_until, total, currency FROM proposals
    WHERE status='Sent' AND valid_until < ?
  `).all(day);
  if (!rows.length) return rows;

  db.prepare(`UPDATE proposals SET status='Expired', updated_at=CURRENT_TIMESTAMP WHERE status='Sent' AND valid_until < ?`).run(day);
  const base = baseCurrency();
  for (const p of rows) {
    notify('warning', 'Proposal expired',
      `Proposal ${p.proposal_number} for ${p.client_name} (${formatMoney(p.total, p.currency || base)}) `
        + `was valid until ${p.valid_until} and expired without a decision.`,
      { dedupeKey: `proposal-expired:${p.id}:${p.valid_until}`, relatedType: 'proposal', relatedId: p.id });
  }
  return rows;
});

module.exports = { readClientFields, readTotals, insertItems, replaceItems, loadInvoice, createInvoice, refreshOverdue, expireProposals };
