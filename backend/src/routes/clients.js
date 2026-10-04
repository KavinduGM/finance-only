const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2 } = require('../lib/money');
const { baseConverter } = require('../services/currencyService');

const LIKE = `LIKE ? ESCAPE '\\'`;

// Limits match the client fields copied onto invoices and proposals, so a
// saved client always fits on a document.
function readClient(body, defaultCountry) {
  return {
    name: v.str(body.name, 'Name', { required: true, max: 200 }),
    email: v.email(body.email, 'Email'),
    phone: v.str(body.phone, 'Phone', { max: 50 }),
    company: v.str(body.company, 'Company', { max: 200 }),
    address: v.str(body.address, 'Address', { max: 500 }),
    // Left out entirely: the default applies. Sent blank: deliberately cleared.
    country: body.country === undefined ? defaultCountry : v.str(body.country, 'Country', { max: 100 }),
    notes: v.str(body.notes, 'Notes', { max: 2000 }),
  };
}

router.get('/', wrap((req, res) => {
  const search = v.str(req.query.search, 'Search', { max: 100 });

  let sql = 'SELECT * FROM clients';
  const params = [];
  if (search) {
    const term = v.like(search);
    sql += ` WHERE name ${LIKE} OR company ${LIKE} OR email ${LIKE} OR phone ${LIKE}`;
    params.push(term, term, term, term);
  }
  const clients = db.prepare(`${sql} ORDER BY name COLLATE NOCASE, id`).all(...params);

  // Invoices can be in any currency, so the totals are added up here in the
  // base currency instead of with SUM() in SQL.
  const fx = baseConverter();
  const totals = new Map();
  const totalsFor = (clientId) => {
    if (!totals.has(clientId)) totals.set(clientId, { invoice_count: 0, total_billed: 0, outstanding: 0 });
    return totals.get(clientId);
  };
  const invoices = db.prepare('SELECT client_id, total, currency, status FROM invoices WHERE client_id IS NOT NULL').all();
  for (const inv of invoices) {
    const t = totalsFor(inv.client_id);
    const status = inv.status || 'Draft';
    t.invoice_count += 1;
    if (status === 'Draft' || status === 'Cancelled') continue;
    const amount = fx.toBase(inv.total, inv.currency);
    t.total_billed += amount;
    if (status === 'Sent' || status === 'Overdue') t.outstanding += amount;
  }

  const proposalCounts = new Map(
    db.prepare('SELECT client_id, COUNT(*) AS n FROM proposals WHERE client_id IS NOT NULL GROUP BY client_id')
      .all().map((r) => [r.client_id, r.n]),
  );

  res.json(clients.map((c) => {
    const t = totals.get(c.id);
    return {
      ...c,
      invoice_count: t ? t.invoice_count : 0,
      proposal_count: proposalCounts.get(c.id) || 0,
      total_billed: round2(t ? t.total_billed : 0),
      outstanding: round2(t ? t.outstanding : 0),
    };
  }));
}));

router.get('/:id', wrap((req, res) => {
  const id = v.id(req);
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(id);
  if (!client) throw new HttpError(404, 'Client not found');

  const invoices = db.prepare(`
    SELECT id, invoice_number, issue_date, due_date, total, currency, status
    FROM invoices WHERE client_id=? ORDER BY issue_date DESC, id DESC LIMIT 20
  `).all(id);
  const proposals = db.prepare(`
    SELECT id, proposal_number, title, issue_date, total, currency, status
    FROM proposals WHERE client_id=? ORDER BY issue_date DESC, id DESC LIMIT 20
  `).all(id);

  res.json({ ...client, invoices, proposals });
}));

router.post('/', wrap((req, res) => {
  const c = readClient(req.body || {}, 'Sri Lanka');
  const result = db.prepare(`
    INSERT INTO clients (name, email, phone, company, address, country, notes) VALUES (?,?,?,?,?,?,?)
  `).run(c.name, c.email, c.phone, c.company, c.address, c.country, c.notes);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

// Documents keep the client details they were issued with; editing a client
// only affects invoices and proposals created afterwards.
router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const existing = db.prepare('SELECT country FROM clients WHERE id=?').get(id);
  if (!existing) throw new HttpError(404, 'Client not found');

  const c = readClient(req.body || {}, existing.country);
  db.prepare('UPDATE clients SET name=?, email=?, phone=?, company=?, address=?, country=?, notes=? WHERE id=?')
    .run(c.name, c.email, c.phone, c.company, c.address, c.country, c.notes, id);
  res.json({ message: 'Client updated' });
}));

// Invoices, proposals and income entries carry their own copy of the client's
// name, so they stay intact; only the link to the client record is removed.
router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  if (!db.prepare('SELECT 1 FROM clients WHERE id=?').get(id)) throw new HttpError(404, 'Client not found');

  db.transaction(() => {
    db.prepare('UPDATE invoices SET client_id=NULL WHERE client_id=?').run(id);
    db.prepare('UPDATE proposals SET client_id=NULL WHERE client_id=?').run(id);
    db.prepare('UPDATE revenue SET client_id=NULL WHERE client_id=?').run(id);
    db.prepare('DELETE FROM clients WHERE id=?').run(id);
  })();
  res.json({ message: 'Client deleted' });
}));

module.exports = router;
