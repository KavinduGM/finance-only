const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const db = require('../database');
const auth = require('../services/authService');
const email = require('../services/emailService');
const { getCachedRatesData } = require('../services/currencyService');
const { requireAdmin } = require('../middleware/auth');
const { wrap, HttpError, v } = require('../lib/http');
const { symbolFor } = require('../lib/money');
const { getSettings, publicSettings } = require('../lib/settings');

// Everyone who is signed in may read the settings (documents and forms need the
// company details and defaults). Changing anything is for administrators only.

// ── Input ────────────────────────────────────────────────────────────────────

function textValue(value, name, opts) {
  if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, `${name} must be text`);
  }
  return v.str(value, name, opts);
}

// Single-line text. A line break inside a name or a bank detail would end up in
// email headers and break the layout of the PDF documents.
function line(value, name, opts) {
  const s = textValue(value, name, opts);
  if (s !== null && /[\u0000-\u001F\u007F]/.test(s)) throw new HttpError(400, `${name} must be a single line of text`);
  return s;
}

function intBetween(value, name, min, max, def) {
  const n = v.int(value, name, { def });
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

function numBetween(value, name, min, max, def) {
  const n = v.num(value, name, { def });
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

function mailServer(value) {
  const host = line(value, 'Mail server', { max: 255 });
  if (host !== null && !/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new HttpError(400, 'Mail server must be a host name such as smtp.example.com, without "https://" or a port');
  }
  return host;
}

// Becomes the first part of every document number, e.g. INV-0042-2026.
function numberPrefix(value, name) {
  const s = line(value, name, { required: true, max: 10 });
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(s)) {
    throw new HttpError(400, `${name} must be 1 to 10 letters, numbers or dashes, starting and ending with a letter or number`);
  }
  return s;
}

// The fields PUT / accepts. Anything else in the body is ignored, so logo_path,
// the old system's admin login columns and the like cannot be written from here.
// A number left blank goes back to its default.
const READERS = {
  company_name: (x) => line(x, 'Company name', { required: true, max: 150 }),
  company_email: (x) => v.email(x, 'Company email'),
  company_phone: (x) => line(x, 'Company phone', { max: 50 }),
  company_address: (x) => textValue(x, 'Company address', { max: 500 }),
  company_website: (x) => line(x, 'Company website', { max: 200 }),
  company_tax_id: (x) => line(x, 'Tax ID', { max: 100 }),

  smtp_host: mailServer,
  smtp_user: (x) => line(x, 'Mail username', { max: 255 }),
  smtp_from_name: (x) => line(x, 'Sender name', { max: 100 }),

  invoice_prefix: (x) => numberPrefix(x, 'Invoice prefix'),
  proposal_prefix: (x) => numberPrefix(x, 'Proposal prefix'),
  invoice_terms: (x) => textValue(x, 'Invoice terms', { max: 2000 }),
  invoice_notes: (x) => textValue(x, 'Invoice notes', { max: 2000 }),
  invoice_due_days: (x) => intBetween(x, 'Invoice due days', 0, 365, 30),
  default_tax_rate: (x) => numBetween(x, 'Default tax rate', 0, 100, 0),
  proposal_terms: (x) => textValue(x, 'Proposal terms', { max: 2000 }),
  proposal_validity_days: (x) => intBetween(x, 'Proposal validity days', 1, 365, 30),

  bank_name: (x) => line(x, 'Bank name', { max: 150 }),
  bank_account_name: (x) => line(x, 'Bank account name', { max: 150 }),
  bank_account_no: (x) => line(x, 'Bank account number', { max: 100 }),
  bank_branch: (x) => line(x, 'Bank branch', { max: 150 }),
  bank_swift: (x) => line(x, 'SWIFT code', { max: 50 }),
  payment_instructions: (x) => textValue(x, 'Payment instructions', { max: 2000 }),

  auto_send_reminders: v.flag,
  reminder_days_before: (x) => intBetween(x, 'Reminder days', 0, 60, 3),
  overdue_check_enabled: v.flag,
  low_cash_alert_enabled: v.flag,
};

// Column → new value for every accepted field that is present in the body.
function readChanges(body, current) {
  const has = (field) => Object.hasOwn(body, field) && body[field] !== undefined;
  const changes = {};

  for (const [field, read] of Object.entries(READERS)) {
    if (has(field)) changes[field] = read(body[field]);
  }

  if (has('currency')) {
    changes.currency = v.currency(body.currency, current.currency || 'LKR');
    changes.currency_symbol = symbolFor(changes.currency);
  }

  if (has('smtp_port')) {
    changes.smtp_port = intBetween(body.smtp_port, 'Mail port', 1, 65535, 465);
    // 465 is TLS from the first byte; every other port upgrades with STARTTLS.
    changes.smtp_secure = changes.smtp_port === 465 ? 1 : 0;
  }

  // The password is never sent to the browser, so the form normally submits it
  // empty: text replaces it, null clears it, an empty string leaves it as it is.
  if (body.smtp_pass === null) {
    changes.smtp_pass = null;
  } else if (has('smtp_pass')) {
    if (typeof body.smtp_pass !== 'string') throw new HttpError(400, 'Mail password must be text');
    const password = body.smtp_pass.trim();
    if (password.length > 500) throw new HttpError(400, 'Mail password must be 500 characters or fewer');
    if (password) changes.smtp_pass = password;
  }

  return changes;
}

// ── Logo files ───────────────────────────────────────────────────────────────

const LOGO_DIR = path.join(config.uploadsDir, 'logos');
const LOGO_URL = '/uploads/logos/';
const MAX_LOGO_MB = 2;
// pdfkit can only place PNG and JPEG images on a document.
const LOGO_TYPES = ['image/png', 'image/jpeg'];
const LOGO_TYPE_MESSAGE = 'The logo must be a PNG or JPEG image';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// Kept in memory (2 MB at most) so the content can be checked before anything
// is written to the uploads folder.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (LOGO_TYPES.includes(String(file.mimetype || '').trim().toLowerCase())) return cb(null, true);
    cb(new HttpError(400, LOGO_TYPE_MESSAGE));
  },
}).single('logo');

// multer's own messages ("File too large", "Unexpected field") do not tell the
// user what to fix, so the common ones are reworded here.
function logoUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, `The logo is too large. The limit is ${MAX_LOGO_MB} MB.`));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return next(new HttpError(400, 'Attach a single image in the "logo" field'));
    }
    next(err);
  });
}

// The type the browser states is only a claim; the first bytes show what the
// file really is. The stored extension follows the content.
function imageExtension(data) {
  if (data.length > 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  if (data.length > 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return '.jpg';
  return null;
}

// Only the file name of logo_path is used, so a stored path can never point
// outside the logos folder.
function logoFile(logoPath) {
  if (typeof logoPath !== 'string') return null;
  const name = path.basename(logoPath.trim());
  if (!name || name === '.' || name === '..') return null;
  return path.join(LOGO_DIR, name);
}

// The settings row has already changed when this runs, so a file that cannot be
// removed is logged instead of failing the request.
function removeFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not remove logo file ${path.basename(file)}: ${err.message}`);
  }
}

const currentLogoPath = () => db.prepare('SELECT logo_path FROM settings WHERE id=1').get()?.logo_path || null;

const saveLogoPath = db.transaction((req, logoPath, action, detail) => {
  db.prepare('UPDATE settings SET logo_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(logoPath);
  auth.audit(req, action, detail);
});

// ── System information ───────────────────────────────────────────────────────

// Version from backend/package.json, read once.
let appVersion;
function version() {
  if (appVersion === undefined) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
      appVersion = String(pkg.version || 'unknown');
    } catch {
      appVersion = 'unknown';
    }
  }
  return appVersion;
}

// The main file plus the write-ahead log, which holds the newest changes until
// SQLite folds them into the main file. On a new system the main file alone
// would read as a few kilobytes.
function databaseSize() {
  let size = fs.statSync(config.dbPath).size;
  try {
    size += fs.statSync(`${config.dbPath}-wal`).size;
  } catch { /* no log file at the moment */ }
  return size;
}

const rowCount = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

// ── Routes ───────────────────────────────────────────────────────────────────

router.get('/', wrap((req, res) => {
  res.json(publicSettings());
}));

router.put('/', requireAdmin, wrap((req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send the settings to change as a JSON object');
  }
  const current = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
  const changes = readChanges(body, current);

  // A form that posts every field back only writes (and logs) what really changed.
  const fields = Object.keys(changes).filter((field) => changes[field] !== current[field]);
  if (fields.length) {
    db.transaction(() => {
      db.prepare(`UPDATE settings SET ${fields.map((f) => `${f}=?`).join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=1`)
        .run(...fields.map((f) => changes[f]));
      // Field names only: the log must never hold the mail password or bank details.
      auth.audit(req, 'settings_updated', fields.join(', '));
    })();
  }
  res.json(publicSettings());
}));

router.post('/logo', requireAdmin, logoUpload, wrap((req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a PNG or JPEG image to upload');
  const extension = imageExtension(req.file.buffer);
  if (!extension) throw new HttpError(400, LOGO_TYPE_MESSAGE);

  const name = `logo-${Date.now()}${extension}`;
  const file = path.join(LOGO_DIR, name);
  const previous = logoFile(currentLogoPath());

  fs.mkdirSync(LOGO_DIR, { recursive: true });
  try {
    fs.writeFileSync(file, req.file.buffer);
    saveLogoPath(req, LOGO_URL + name, 'logo_updated', name);
  } catch (err) {
    // Nothing points at the new file, so it must not be left behind.
    removeFile(file);
    throw err;
  }
  if (previous !== file) removeFile(previous);

  res.json({ logo_path: LOGO_URL + name, message: 'Logo updated' });
}));

router.delete('/logo', requireAdmin, wrap((req, res) => {
  const stored = currentLogoPath();
  if (stored) {
    saveLogoPath(req, null, 'logo_removed', null);
    removeFile(logoFile(stored));
  }
  res.json({ logo_path: null, message: stored ? 'Logo removed' : 'There is no logo to remove' });
}));

// Sends with the saved mail settings, so changes have to be saved first.
router.post('/test-email', requireAdmin, wrap(async (req, res) => {
  const requested = v.email(req.body?.to, 'Recipient');
  const settings = getSettings();
  if (!email.isEmailConfigured(settings)) {
    const status = email.emailStatus(settings);
    throw new HttpError(400, status.resend_missing_sender
      ? 'A Resend API key is set, but there is no sender address. Set EMAIL_FROM on the server to an address on your verified Resend domain.'
      : 'Email is not set up yet. Set RESEND_API_KEY and EMAIL_FROM on the server, or enter a mail server below and save.');
  }

  // The addresses on file were not necessarily checked when they were stored.
  const onFile = [req.user?.email, settings.company_email]
    .map((address) => String(address || '').trim())
    .find((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  const to = requested || onFile;
  if (!to) {
    throw new HttpError(400, 'There is no address to send the test to. Enter one, or add an email address to your profile or to the company details.');
  }

  try {
    await email.sendTestEmail(settings, to);
  } catch (err) {
    throw new HttpError(400, `Email test failed: ${err.message}`);
  }
  res.json({ message: `Test email sent to ${to}`, to });
}));

router.get('/system', requireAdmin, wrap((req, res) => {
  res.json({
    version: version(),
    node: process.version,
    timezone: config.timezone,
    database_size: databaseSize(),
    email_configured: email.isEmailConfigured(getSettings()),
    // Which provider is active and the sender address. The API key itself is never sent.
    email: email.emailStatus(getSettings()),
    rates_updated_at: getCachedRatesData()?.updated_at || null,
    counts: {
      clients: rowCount('clients'),
      invoices: rowCount('invoices'),
      proposals: rowCount('proposals'),
      income: rowCount('revenue'),
      expenses: rowCount('expenses'),
      payees: rowCount('employees'),
    },
  });
}));

module.exports = router;
