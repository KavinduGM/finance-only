const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');
const { round2 } = require('../lib/money');
const { BILLING_CYCLES } = require('../lib/dates');
const { baseCurrency } = require('../lib/settings');

// ── Receipt files ────────────────────────────────────────────────────────────

const RECEIPT_DIR = path.join(config.uploadsDir, 'receipts');
const RECEIPT_URL = '/uploads/receipts/';
const MAX_RECEIPT_MB = 5;

// Allowed types and the extension each one is stored with. The stored name is
// built from this table, never from the name the browser sent.
const RECEIPT_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const receiptExtension = (file) => RECEIPT_TYPES.get(String(file.mimetype || '').trim().toLowerCase());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => fs.mkdir(RECEIPT_DIR, { recursive: true }, (err) => cb(err, RECEIPT_DIR)),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + receiptExtension(file)),
  }),
  limits: { fileSize: MAX_RECEIPT_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (receiptExtension(file)) return cb(null, true);
    cb(new HttpError(400, 'Receipt must be a PDF, JPEG, PNG or WebP file'));
  },
}).single('receipt');

// multer's own messages ("File too large", "Unexpected field") do not tell the
// user what to fix, so the common ones are reworded here.
function receiptUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, `Receipt is too large. The limit is ${MAX_RECEIPT_MB} MB.`));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return next(new HttpError(400, 'Attach a single receipt file in the "receipt" field'));
    }
    next(err);
  });
}

// Only the file name of receipt_path is used, so a stored path can never point
// outside the receipts folder.
function receiptFile(receiptPath) {
  if (typeof receiptPath !== 'string') return null;
  const name = path.basename(receiptPath.trim());
  if (!name || name === '.' || name === '..') return null;
  return path.join(RECEIPT_DIR, name);
}

// The database change has already happened when this runs, so a file that
// cannot be removed is logged instead of failing the request.
function removeFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not remove receipt file ${path.basename(file)}: ${err.message}`);
  }
}

// Call after the row stopped pointing at the receipt. The file stays if another
// row still uses it (possible only in data carried over from the old system).
function releaseReceipt(receiptPath) {
  const file = receiptFile(receiptPath);
  if (!file) return;
  if (db.prepare('SELECT 1 FROM expenses WHERE receipt_path=?').get(receiptPath)) return;
  removeFile(file);
}

// multer stores the upload before the handler runs. If the request is then
// rejected (bad input, missing row, payroll row), the new file is removed so
// failed requests leave nothing behind.
function discardUploadOnError(req, work) {
  try {
    return work();
  } catch (err) {
    if (req.file) removeFile(req.file.path);
    throw err;
  }
}

// ── Input ────────────────────────────────────────────────────────────────────

// v.date lets impossible days such as 2026-02-31 through (JavaScript rolls them
// into March) and any year; a mistyped year would drop the expense out of every report.
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

const CYCLE_CHOICES = ['One-time', ...BILLING_CYCLES];

// Multipart fields arrive as strings, so every value is converted and checked
// here. `existing` is the current row when editing.
function readExpense(body, existing = null) {
  const title = v.str(body.title, 'Title', { required: true, max: 200 });
  const category = v.str(body.category, 'Category', { required: true, max: 100 });
  const amount = round2(v.num(body.amount, 'Amount', { required: true }));
  if (amount <= 0) throw new HttpError(400, 'Amount must be greater than 0');
  const paymentDate = calendarDate(body.payment_date, 'Payment date', { required: true });

  // Blank or "One-time" means not recurring; a recurring expense always has a cycle.
  const cycleIn = v.oneOf(body.billing_cycle, 'Billing cycle', CYCLE_CHOICES);
  const cycle = cycleIn && cycleIn !== 'One-time' ? cycleIn : null;
  const isRecurring = v.isBlank(body.is_recurring) ? (cycle ? 1 : 0) : v.flag(body.is_recurring);

  return {
    title,
    category,
    vendor: v.str(body.vendor, 'Vendor', { max: 200 }),
    amount,
    payment_date: paymentDate,
    payment_method: v.str(body.payment_method, 'Payment method', { max: 50 }),
    is_recurring: isRecurring,
    billing_cycle: isRecurring ? (cycle || 'Monthly') : null,
    notes: v.str(body.notes, 'Notes', { max: 2000 }),
    currency: v.currency(body.currency, existing?.currency || baseCurrency()),
  };
}

const isPayrollManaged = (row) => typeof row.source === 'string' && row.source.startsWith('payroll:');

// The row for an edit or delete: it must exist and must not belong to payroll,
// whose totals are rebuilt from the salary records.
function loadEditable(id) {
  const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
  if (!row) throw new HttpError(404, 'Expense not found');
  if (isPayrollManaged(row)) throw new HttpError(400, 'Payroll expenses are managed from the Payroll page');
  return row;
}

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/', wrap((req, res) => {
  const category = v.str(req.query.category, 'Category', { max: 100 });
  const search = v.str(req.query.search, 'Search', { max: 100 });
  const from = v.date(req.query.from, 'From date');
  const to = v.date(req.query.to, 'To date');

  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (search) {
    where.push(`(title LIKE ? ESCAPE '\\' OR vendor LIKE ? ESCAPE '\\')`);
    params.push(v.like(search), v.like(search));
  }
  if (from) { where.push('payment_date >= ?'); params.push(from); }
  if (to) { where.push('payment_date <= ?'); params.push(to); }

  res.json(db.prepare(`
    SELECT * FROM expenses
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY payment_date DESC, id DESC
  `).all(...params));
}));

router.get('/categories', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT category FROM expenses
    WHERE category IS NOT NULL AND TRIM(category) <> ''
    ORDER BY category COLLATE NOCASE
  `).all();
  res.json(rows.map((r) => r.category));
}));

router.post('/', receiptUpload, wrap((req, res) => {
  const id = discardUploadOnError(req, () => {
    const e = readExpense(req.body || {});
    const receiptPath = req.file ? RECEIPT_URL + req.file.filename : null;
    const result = db.prepare(`
      INSERT INTO expenses (title, category, vendor, amount, payment_date, payment_method,
        is_recurring, billing_cycle, receipt_path, notes, currency)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(e.title, e.category, e.vendor, e.amount, e.payment_date, e.payment_method,
      e.is_recurring, e.billing_cycle, receiptPath, e.notes, e.currency);
    return Number(result.lastInsertRowid);
  });
  res.status(201).json({ id });
}));

router.put('/:id', receiptUpload, wrap((req, res) => {
  const { previousReceipt, receiptPath } = discardUploadOnError(req, () => {
    const existing = loadEditable(v.id(req));
    const body = req.body || {};
    const e = readExpense(body, existing);

    // A new file replaces the stored one; remove_receipt only matters without a new file.
    let newPath = existing.receipt_path || null;
    if (req.file) newPath = RECEIPT_URL + req.file.filename;
    else if (v.flag(body.remove_receipt)) newPath = null;

    // `source` is left alone: it ties an automatic row to what created it.
    db.prepare(`
      UPDATE expenses SET title=?, category=?, vendor=?, amount=?, payment_date=?, payment_method=?,
        is_recurring=?, billing_cycle=?, receipt_path=?, notes=?, currency=?
      WHERE id=?
    `).run(e.title, e.category, e.vendor, e.amount, e.payment_date, e.payment_method,
      e.is_recurring, e.billing_cycle, newPath, e.notes, e.currency, existing.id);
    return { previousReceipt: existing.receipt_path, receiptPath: newPath };
  });

  if (previousReceipt && previousReceipt !== receiptPath) releaseReceipt(previousReceipt);
  res.json({ message: 'Expense updated', receipt_path: receiptPath });
}));

router.delete('/:id', wrap((req, res) => {
  const row = loadEditable(v.id(req));
  db.prepare('DELETE FROM expenses WHERE id=?').run(row.id);
  releaseReceipt(row.receipt_path);
  res.json({ message: 'Expense deleted' });
}));

module.exports = router;
