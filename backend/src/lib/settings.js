const db = require('../database');
const config = require('../config');
const { symbolFor } = require('./money');

const SECRET_FIELDS = ['smtp_pass', 'openai_key', 'admin_username', 'admin_password_hash'];

// Full settings row for server-side use. SMTP falls back to environment
// variables only while the Settings page fields are blank.
function getSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
  return {
    ...row,
    smtp_host: row.smtp_host || config.smtp.host || null,
    smtp_port: row.smtp_host ? row.smtp_port : (config.smtp.host ? config.smtp.port : row.smtp_port),
    smtp_user: row.smtp_user || config.smtp.user || null,
    smtp_pass: row.smtp_pass || config.smtp.pass || null,
    currency: row.currency || 'LKR',
    currency_symbol: symbolFor(row.currency || 'LKR'),
  };
}

// What the browser is allowed to see: no passwords, hashes or keys.
function publicSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
  const out = { ...row };
  for (const f of SECRET_FIELDS) delete out[f];
  out.smtp_pass_set = !!row.smtp_pass;
  out.currency = row.currency || 'LKR';
  out.currency_symbol = symbolFor(out.currency);
  return out;
}

const baseCurrency = () => db.prepare('SELECT currency FROM settings WHERE id=1').get()?.currency || 'LKR';

module.exports = { getSettings, publicSettings, baseCurrency };
