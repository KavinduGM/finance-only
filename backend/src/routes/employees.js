const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2 } = require('../lib/money');
const { baseCurrency } = require('../lib/settings');

// Payroll payees ("People" in the UI). The table keeps its original name so a
// database from the old system upgrades in place; its old HR columns are ignored.

const SALARY_TYPES = ['Monthly', 'Project', 'Hourly'];
const STATUSES = ['Active', 'Inactive'];
const COLUMNS = `id, name, position, department, email, phone, salary_type, base_salary,
  currency, start_date, status, bank_details, notes, created_at`;

// Validates the payee fields. On an update (`current` given) a field missing
// from the body keeps its stored value, so a partial update never wipes data.
function readPayee(body, current) {
  const field = (key, read, fallback) => {
    if (current && body[key] === undefined) return current[key] ?? fallback;
    return read(body[key]);
  };
  return {
    name: field('name', (x) => v.str(x, 'Name', { required: true, max: 200 }), null),
    position: field('position', (x) => v.str(x, 'Position', { max: 200 }), null),
    department: field('department', (x) => v.str(x, 'Department', { max: 200 }), null),
    email: field('email', (x) => v.email(x, 'Email'), null),
    phone: field('phone', (x) => v.str(x, 'Phone', { max: 50 }), null),
    salary_type: field('salary_type',
      (x) => v.oneOf(x, 'Salary type', SALARY_TYPES, { def: current?.salary_type || 'Monthly' }), 'Monthly'),
    base_salary: round2(field('base_salary', (x) => v.num(x, 'Base salary', { min: 0, def: 0 }), 0)),
    currency: field('currency', (x) => v.currency(x, current?.currency || baseCurrency()), baseCurrency()),
    start_date: field('start_date', (x) => v.date(x, 'Start date'), null),
    bank_details: field('bank_details', (x) => v.str(x, 'Bank details', { max: 1000 }), null),
    notes: field('notes', (x) => v.str(x, 'Notes', { max: 2000 }), null),
  };
}

router.get('/', wrap((req, res) => {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM employees ORDER BY name COLLATE NOCASE, id`).all();
  const base = baseCurrency();
  res.json(rows.map((r) => ({ ...r, currency: r.currency || base })));
}));

router.get('/departments', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(department) AS department FROM employees
    WHERE department IS NOT NULL AND TRIM(department) <> ''
    ORDER BY department COLLATE NOCASE
  `).all();
  res.json(rows.map((r) => r.department));
}));

router.post('/', wrap((req, res) => {
  const p = readPayee(req.body || {});
  const result = db.prepare(`
    INSERT INTO employees (name, position, department, email, phone, salary_type, base_salary,
      currency, start_date, status, bank_details, notes)
    VALUES (?,?,?,?,?,?,?,?,?,'Active',?,?)
  `).run(p.name, p.position, p.department, p.email, p.phone, p.salary_type, p.base_salary,
    p.currency, p.start_date, p.bank_details, p.notes);
  res.status(201).json({ id: Number(result.lastInsertRowid), message: 'Person added to payroll' });
}));

// Salary records are snapshots: changing a person here never rewrites
// payments that were already created for them.
router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const current = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  if (!current) throw new HttpError(404, 'Person not found');

  const body = req.body || {};
  const p = readPayee(body, current);
  const status = v.oneOf(body.status, 'Status', STATUSES, { def: current.status || 'Active' });

  db.prepare(`
    UPDATE employees SET name=?, position=?, department=?, email=?, phone=?, salary_type=?, base_salary=?,
      currency=?, start_date=?, status=?, bank_details=?, notes=?
    WHERE id=?
  `).run(p.name, p.position, p.department, p.email, p.phone, p.salary_type, p.base_salary,
    p.currency, p.start_date, status, p.bank_details, p.notes, id);
  res.json({ message: 'Person updated' });
}));

// Removing a person keeps their payment history: the salary records stay,
// with the name copied on them, and are only unlinked.
router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(id)) throw new HttpError(404, 'Person not found');

  db.transaction(() => {
    db.prepare('UPDATE salary_payments SET employee_id = NULL WHERE employee_id = ?').run(id);
    db.prepare('DELETE FROM employees WHERE id=?').run(id);
  })();
  res.json({ message: 'Person removed from payroll. Their payment history was kept.' });
}));

module.exports = router;
