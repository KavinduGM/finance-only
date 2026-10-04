const db = require('../database');
const { thisYear } = require('./dates');

const KINDS = {
  invoice: { table: 'invoices', column: 'invoice_number', prefixField: 'invoice_prefix', fallback: 'INV' },
  proposal: { table: 'proposals', column: 'proposal_number', prefixField: 'proposal_prefix', fallback: 'PRO' },
};

// Next document number, e.g. INV-0042-2026. Backed by a counter that only moves
// forward, so deleting the newest invoice never hands its number to the next one.
// Call inside the same transaction that inserts the document.
function nextNumber(kind) {
  const { table, column, prefixField, fallback } = KINDS[kind];
  const settings = db.prepare(`SELECT ${prefixField} AS prefix FROM settings WHERE id=1`).get();
  // A prefix ending in a dash would give numbers like "INV--0001-2026".
  const prefix = (settings?.prefix || fallback).trim().replace(/-+$/, '') || fallback;

  db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run(kind);
  // Start above anything that already exists (databases carried over from the old system).
  const maxId = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
  db.prepare('UPDATE counters SET value = MAX(value, ?) WHERE name=?').run(maxId, kind);

  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`);
  for (;;) {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name=?').run(kind);
    const n = db.prepare('SELECT value FROM counters WHERE name=?').get(kind).value;
    const number = `${prefix}-${String(n).padStart(4, '0')}-${thisYear()}`;
    if (!exists.get(number)) return number;
  }
}

module.exports = { nextNumber };
