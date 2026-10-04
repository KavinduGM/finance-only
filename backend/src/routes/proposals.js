const express = require('express');
const router = express.Router();
const db = require('../database');
const invoiceService = require('../services/invoiceService');
const config = require('../config');
const { wrap, HttpError, v } = require('../lib/http');
const { symbolFor, round2, formatMoney } = require('../lib/money');
const { today, thisYear, shiftDate } = require('../lib/dates');
const { getSettings } = require('../lib/settings');
const { notify } = require('../lib/notify');
const { nextNumber } = require('../lib/numbering');
const {
  readClientFields, readTotals, insertItems, replaceItems, createInvoice,
} = require('../services/invoiceService');
const { baseConverter } = require('../services/currencyService');
const { generateProposalPDF } = require('../services/pdfService');
const { isEmailConfigured, sendProposalEmail } = require('../services/emailService');

const STATUSES = ['Draft', 'Sent', 'Accepted', 'Declined', 'Expired'];
// Expired is never chosen by hand: it follows from the valid-until date.
const MANUAL_STATUSES = ['Draft', 'Sent', 'Accepted', 'Declined'];
const LONG_TEXT = 5000;

// Proposals with an email on its way, so a double click cannot send it twice.
const sending = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadProposal(id) {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  if (!proposal) return null;
  proposal.items = db.prepare('SELECT * FROM proposal_items WHERE proposal_id=? ORDER BY id').all(id);
  return proposal;
}

function requireProposal(id) {
  const proposal = loadProposal(id);
  if (!proposal) throw new HttpError(404, 'Proposal not found');
  return proposal;
}

// Sent proposals past their valid-until date become Expired. Only `Sent` rows
// match, so Draft, Accepted and Declined proposals are never touched.
// Shared with the hourly job, so the notification is raised whichever runs first.
const expireProposals = () => invoiceService.expireProposals();

// A day count from Settings. 0 is a real value for invoices (due on receipt),
// so this cannot be written as `value || fallback`.
const dayCount = (value, fallback, min = 0) =>
  (Number.isInteger(value) && value >= min ? value : fallback);
const validityDays = (settings) => dayCount(settings.proposal_validity_days, 30, 1);
const invoiceDueDays = (settings) => dayCount(settings.invoice_due_days, 30);

// v.date lets impossible days such as 2026-02-31 through; shiftDate does not.
function readDate(value, name) {
  const date = v.date(value, name);
  if (date === null) return null;
  try {
    return shiftDate(date);
  } catch {
    throw new HttpError(400, `${name} must be a valid date (YYYY-MM-DD)`);
  }
}

// Line items + tax + discount → cleaned lines and totals, through the shared
// readTotals, so a converted invoice always matches its proposal to the cent.
// `stored` marks lines re-read from the database (convert, duplicate), where an
// old price with more than two decimals is rounded instead of being refused.
function readDocument(source, { stored = false } = {}) {
  return readTotals({ items: source.items, tax_rate: source.tax_rate, discount: source.discount }, { stored });
}

// Request body → validated proposal fields. On an edit (`existing` given) the
// dates, currency, tax, discount and text fields the request leaves out keep
// their saved values, so a partial request can never silently change what the
// proposal is worth. The client block is always replaced as a whole.
function readProposalBody(body, settings, existing = null) {
  const omitted = (key) => existing !== null && body[key] === undefined;
  const text = (key, name) => (omitted(key) ? existing[key] : v.str(body[key], name, { max: LONG_TEXT }));

  const client = readClientFields(body);
  const title = v.str(body.title, 'Title', { required: true, max: 200 });

  const issueDate = readDate(body.issue_date, 'Issue date') || existing?.issue_date || today();
  const validUntil = readDate(body.valid_until, 'Valid until')
    || existing?.valid_until
    || shiftDate(issueDate, { days: validityDays(settings) });
  if (validUntil < issueDate) {
    throw new HttpError(400, 'Valid until cannot be earlier than the issue date');
  }

  const currency = v.currency(body.currency, existing?.currency || settings.currency);
  const totals = readDocument({
    items: body.items,
    tax_rate: omitted('tax_rate') ? existing.tax_rate : body.tax_rate,
    discount: omitted('discount') ? existing.discount : body.discount,
  });

  return {
    ...client,
    title,
    summary: text('summary', 'Summary'),
    issue_date: issueDate,
    valid_until: validUntil,
    currency,
    totals,
    notes: text('notes', 'Notes'),
    // A new proposal starts with the standard terms; an edit may clear them.
    terms: existing
      ? text('terms', 'Terms')
      : (v.str(body.terms, 'Terms', { max: LONG_TEXT }) || settings.proposal_terms || null),
  };
}

// `data` is already validated. Always a Draft with the next proposal number.
const insertProposal = db.transaction((data) => {
  const number = nextNumber('proposal');
  const t = data.totals;
  const result = db.prepare(`
    INSERT INTO proposals (proposal_number, client_id, client_name, client_email, client_address, client_company,
      title, summary, issue_date, valid_until, currency, currency_symbol,
      subtotal, tax_rate, tax_amount, discount, total, status, notes, terms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Draft',?,?)
  `).run(number, data.client_id || null, data.client_name, data.client_email || null,
    data.client_address || null, data.client_company || null,
    data.title, data.summary || null, data.issue_date, data.valid_until,
    data.currency, symbolFor(data.currency),
    t.subtotal, t.tax_rate, t.tax_amount, t.discount, t.total,
    data.notes || null, data.terms || null);
  const id = Number(result.lastInsertRowid);
  insertItems('proposal_items', 'proposal_id', id, t.lines);
  return { id, proposal_number: number };
});

// A copied document keeps the client's name even after the client record is
// deleted, but must not keep pointing at a record that is gone.
const liveClientId = (clientId) =>
  (clientId && db.prepare('SELECT 1 FROM clients WHERE id=?').get(clientId) ? clientId : null);

// decided_at / updated_at are UTC timestamps. The year a proposal was won is
// read in the business timezone, so one accepted in the first hours of
// 1 January counts for the new year.
let yearInZone;
function businessYear(timestamp) {
  const s = String(timestamp || '').trim();
  if (s.length <= 10) return s.slice(0, 4);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const instant = new Date(hasZone ? s : `${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(instant.getTime())) return s.slice(0, 4);
  yearInZone ||= new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric' });
  return yearInZone.format(instant);
}

const safeFileName = (number) => String(number).replace(/[^A-Za-z0-9._-]/g, '_');

// ── Listing and totals ───────────────────────────────────────────────────────

router.get('/', wrap((req, res) => {
  expireProposals();
  const status = v.oneOf(req.query.status, 'Status', STATUSES);
  const search = v.str(req.query.search, 'Search', { max: 100 });

  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push(`(client_name LIKE ? ESCAPE '\\' OR proposal_number LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
    const term = v.like(search);
    params.push(term, term, term);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const proposals = db.prepare(`SELECT * FROM proposals ${filter} ORDER BY id DESC`).all(...params);
  const items = db.prepare(`
    SELECT * FROM proposal_items
    WHERE proposal_id IN (SELECT id FROM proposals ${filter})
    ORDER BY id
  `).all(...params);

  const itemsOf = new Map();
  for (const proposal of proposals) {
    proposal.items = [];
    itemsOf.set(proposal.id, proposal.items);
  }
  for (const item of items) itemsOf.get(item.proposal_id)?.push(item);

  res.json(proposals);
}));

// Declared before '/:id' so "stats" is not read as an id.
router.get('/stats', wrap((req, res) => {
  expireProposals();
  const fx = baseConverter();
  const year = thisYear();

  const counts = {};
  for (const status of STATUSES) counts[status] = 0;
  let openValue = 0;
  let acceptedValue = 0;

  // Totals are added up here, one row at a time, because each proposal is in
  // its own currency.
  const rows = db.prepare('SELECT status, total, currency, decided_at, updated_at FROM proposals').all();
  for (const row of rows) {
    if (!STATUSES.includes(row.status)) continue;
    counts[row.status] += 1;
    if (row.status === 'Draft' || row.status === 'Sent') {
      openValue += fx.toBase(row.total, row.currency);
    } else if (row.status === 'Accepted' && businessYear(row.decided_at || row.updated_at) === year) {
      acceptedValue += fx.toBase(row.total, row.currency);
    }
  }

  const decided = counts.Accepted + counts.Declined + counts.Expired;
  res.json({
    base_currency: fx.base,
    counts,
    open_value: round2(openValue),
    accepted_value: round2(acceptedValue),
    win_rate: decided ? Math.round((counts.Accepted / decided) * 1000) / 10 : null,
  });
}));

router.get('/:id', wrap((req, res) => {
  const id = v.id(req);
  expireProposals();
  res.json(requireProposal(id));
}));

// ── Create, edit, delete ─────────────────────────────────────────────────────

router.post('/', wrap((req, res) => {
  const data = readProposalBody(req.body || {}, getSettings());
  res.status(201).json(insertProposal(data));
}));

router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const body = req.body || {};
  const settings = getSettings();

  const status = db.transaction(() => {
    const current = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
    if (!current) throw new HttpError(404, 'Proposal not found');
    if (current.status === 'Accepted') {
      throw new HttpError(400, 'Accepted proposals cannot be edited. Duplicate it to make a new version.');
    }

    const data = readProposalBody(body, settings, current);
    const t = data.totals;

    // The valid-until date drives Sent/Expired, exactly as the expiry step does.
    const day = today();
    let next = current.status;
    if (current.status === 'Expired' && data.valid_until >= day) {
      next = current.sent_at ? 'Sent' : 'Draft';
    } else if (current.status === 'Sent' && data.valid_until < day) {
      next = 'Expired';
    }

    db.prepare(`
      UPDATE proposals SET client_id=?, client_name=?, client_email=?, client_address=?, client_company=?,
        title=?, summary=?, issue_date=?, valid_until=?, currency=?, currency_symbol=?,
        subtotal=?, tax_rate=?, tax_amount=?, discount=?, total=?, status=?, notes=?, terms=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(data.client_id || null, data.client_name, data.client_email || null,
      data.client_address || null, data.client_company || null,
      data.title, data.summary || null, data.issue_date, data.valid_until,
      data.currency, symbolFor(data.currency),
      t.subtotal, t.tax_rate, t.tax_amount, t.discount, t.total, next,
      data.notes || null, data.terms || null, id);
    replaceItems('proposal_items', 'proposal_id', id, t.lines);
    return next;
  })();

  res.json({ id, status, message: 'Proposal updated' });
}));

router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM proposals WHERE id=?').get(id)) {
      throw new HttpError(404, 'Proposal not found');
    }
    // An invoice made from this proposal stays; it just loses the link.
    db.prepare('UPDATE invoices SET proposal_id=NULL WHERE proposal_id=?').run(id);
    db.prepare('DELETE FROM proposal_items WHERE proposal_id=?').run(id);
    db.prepare('DELETE FROM proposals WHERE id=?').run(id);
  })();
  res.json({ message: 'Proposal deleted' });
}));

// ── Actions ──────────────────────────────────────────────────────────────────

router.post('/:id/send', wrap(async (req, res) => {
  const id = v.id(req);
  const proposal = requireProposal(id);

  if (proposal.status === 'Accepted' || proposal.status === 'Declined') {
    throw new HttpError(400,
      `This proposal has been ${proposal.status.toLowerCase()} and cannot be sent. Duplicate it to send a new version.`);
  }
  // Sending a lapsed proposal would only have it expire again straight away.
  if (proposal.valid_until < today()) {
    throw new HttpError(400,
      `This proposal was valid until ${proposal.valid_until}. Set a later valid-until date before sending it.`);
  }
  if (sending.has(id)) throw new HttpError(409, 'This proposal is already being sent');

  // Marked as sent first: the status must not depend on the mail server.
  db.prepare(`
    UPDATE proposals SET
      sent_at = CASE WHEN status='Sent' AND sent_at IS NOT NULL THEN sent_at ELSE CURRENT_TIMESTAMP END,
      status='Sent', updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(id);

  const settings = getSettings();
  let emailSent = false;
  let message;

  if (!proposal.client_email) {
    message = 'Proposal marked as sent. It was not emailed because the client has no email address.';
  } else if (!isEmailConfigured(settings)) {
    message = 'Proposal marked as sent. It was not emailed because email is not set up in Settings.';
  } else {
    sending.add(id);
    try {
      const current = loadProposal(id);
      const pdf = await generateProposalPDF(current, settings);
      await sendProposalEmail(current, pdf, settings);
      db.prepare('UPDATE proposals SET email_sent=1, sent_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
      emailSent = true;
      message = `Proposal ${proposal.proposal_number} emailed to ${proposal.client_email}`;
    } catch (err) {
      // The proposal stays marked as sent; the reason goes back to the user.
      console.error(`Proposal ${proposal.proposal_number} could not be emailed:`, err.message);
      message = `Proposal marked as sent, but the email could not be sent: ${err.message}`;
    } finally {
      sending.delete(id);
    }
  }

  res.json({ emailSent, message, status: 'Sent' });
}));

router.post('/:id/status', wrap((req, res) => {
  const id = v.id(req);
  const status = v.oneOf(req.body?.status, 'Status', MANUAL_STATUSES, { required: true });

  const changed = db.transaction(() => {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
    if (!proposal) throw new HttpError(404, 'Proposal not found');
    // Repeating the current status must not move decided_at or notify again.
    if (proposal.status === status) return false;
    if (status !== 'Accepted' && proposal.invoice_id
      && db.prepare('SELECT 1 FROM invoices WHERE id=?').get(proposal.invoice_id)) {
      throw new HttpError(409, 'This proposal has an invoice. Delete the invoice before changing its status.');
    }
    if (status === 'Sent' && proposal.valid_until < today()) {
      throw new HttpError(400,
        `This proposal was valid until ${proposal.valid_until}. Set a later valid-until date before marking it as sent.`);
    }

    const decided = status === 'Accepted' || status === 'Declined';
    db.prepare(`
      UPDATE proposals SET status=?,
        decided_at = ${decided ? 'CURRENT_TIMESTAMP' : 'NULL'},
        sent_at = ${status === 'Sent' ? 'COALESCE(sent_at, CURRENT_TIMESTAMP)' : 'sent_at'},
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(status, id);

    const link = { relatedType: 'proposal', relatedId: id };
    const amount = formatMoney(proposal.total, proposal.currency || getSettings().currency);
    if (status === 'Accepted') {
      notify('success', 'Proposal accepted',
        `${proposal.proposal_number} for ${proposal.client_name} was accepted (${amount})`, link);
    } else if (status === 'Declined') {
      notify('info', 'Proposal declined',
        `${proposal.proposal_number} for ${proposal.client_name} was declined (${amount})`, link);
    }
    return true;
  })();

  res.json({
    status,
    message: changed ? `Proposal marked as ${status}` : `Proposal is already marked as ${status}`,
  });
}));

router.post('/:id/convert', wrap((req, res) => {
  const id = v.id(req);
  const settings = getSettings();

  // The "already converted" check and the insert share one transaction, with
  // nothing asynchronous in between, so a second click always finds the
  // invoice made by the first one.
  const outcome = db.transaction(() => {
    const proposal = requireProposal(id);

    // An invoice_id whose invoice has since been deleted does not block.
    const existing = proposal.invoice_id
      ? db.prepare('SELECT id, invoice_number FROM invoices WHERE id=?').get(proposal.invoice_id)
      : null;
    if (existing) return { existing };
    if (proposal.status === 'Declined') {
      throw new HttpError(409, 'This proposal was declined. Reopen it before converting it to an invoice.');
    }

    const totals = readDocument(proposal, { stored: true });
    if (Math.abs(totals.total - round2(proposal.total)) >= 0.005) {
      const currency = proposal.currency || settings.currency;
      throw new HttpError(409,
        `The total saved on this proposal (${formatMoney(proposal.total, currency)}) does not match its line items `
        + `(${formatMoney(totals.total, currency)}). Duplicate the proposal to recalculate it, then convert the copy.`);
    }

    const issueDate = today();
    const invoice = createInvoice({
      client_id: liveClientId(proposal.client_id),
      client_name: proposal.client_name,
      client_email: proposal.client_email,
      client_address: proposal.client_address,
      client_company: proposal.client_company,
      issue_date: issueDate,
      due_date: shiftDate(issueDate, { days: invoiceDueDays(settings) }),
      currency: proposal.currency || settings.currency,
      totals,
      notes: proposal.notes,
      terms: settings.invoice_terms,
      status: 'Draft',
      proposal_id: id,
    });

    // An earlier acceptance keeps its date; anything else is decided now.
    db.prepare(`
      UPDATE proposals SET
        decided_at = CASE WHEN status='Accepted' AND decided_at IS NOT NULL THEN decided_at ELSE CURRENT_TIMESTAMP END,
        status='Accepted', invoice_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(invoice.id, id);

    notify('success', 'Proposal converted to invoice',
      `${proposal.proposal_number} for ${proposal.client_name} is now draft invoice ${invoice.invoice_number} `
      + `(${formatMoney(totals.total, proposal.currency || settings.currency)})`,
      { relatedType: 'invoice', relatedId: invoice.id });

    return { invoice };
  }).immediate();

  if (outcome.existing) {
    return res.status(409).json({
      error: `This proposal was already converted to invoice ${outcome.existing.invoice_number}`,
      code: 'ALREADY_CONVERTED',
      invoice_id: outcome.existing.id,
      invoice_number: outcome.existing.invoice_number,
    });
  }
  res.status(201).json({ invoice_id: outcome.invoice.id, invoice_number: outcome.invoice.invoice_number });
}));

router.post('/:id/duplicate', wrap((req, res) => {
  const source = requireProposal(v.id(req));
  const settings = getSettings();
  const issueDate = today();

  const created = insertProposal({
    client_id: liveClientId(source.client_id),
    client_name: source.client_name,
    client_email: source.client_email,
    client_address: source.client_address,
    client_company: source.client_company,
    title: source.title,
    summary: source.summary,
    issue_date: issueDate,
    valid_until: shiftDate(issueDate, { days: validityDays(settings) }),
    currency: source.currency || settings.currency,
    totals: readDocument(source, { stored: true }),
    notes: source.notes,
    terms: source.terms,
  });
  res.status(201).json(created);
}));

router.get('/:id/pdf', wrap(async (req, res) => {
  const proposal = requireProposal(v.id(req));
  const pdf = await generateProposalPDF(proposal, getSettings());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${v.flag(req.query.inline) ? 'inline' : 'attachment'}; filename="Proposal-${safeFileName(proposal.proposal_number)}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
// For the scheduler and the dashboard, which need the same expiry rule.
module.exports.expireProposals = expireProposals;
module.exports.loadProposal = loadProposal;
