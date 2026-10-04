const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../database');
const config = require('../config');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const NAME_RE = /^[A-Za-z0-9._-]+\.db$/;

// Consistent copy of the live database (safe while the app is in use).
async function createBackup(label = 'manual') {
  // The random suffix keeps two backups made in the same second apart.
  const file = path.join(config.backupsDir, `${label}-${stamp()}-${crypto.randomBytes(3).toString('hex')}.db`);
  await db.backup(file);
  return file;
}

// SQLite may leave these beside a database file it has opened.
function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
}

function listBackups() {
  return fs.readdirSync(config.backupsDir)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(config.backupsDir, f));
      return { name: f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Resolves a backup name to its path, refusing anything outside the backups folder.
function backupPath(name) {
  if (!NAME_RE.test(name) || name.includes('..')) return null;
  const file = path.join(config.backupsDir, name);
  return fs.existsSync(file) ? file : null;
}

function deleteBackup(name) {
  const file = backupPath(name);
  if (!file) return false;
  fs.rmSync(file);
  removeSidecars(file);
  return true;
}

// Keeps the newest `keep` automatic backups. Manual and safety copies are never pruned.
function pruneAutomatic(keep = config.backupKeep) {
  const auto = listBackups().filter((b) => b.name.startsWith('auto-'));
  for (const b of auto.slice(keep)) fs.rmSync(path.join(config.backupsDir, b.name), { force: true });
}

async function runScheduledBackup() {
  const file = await createBackup('auto');
  pruneAutomatic();
  return file;
}

// Tables and columns every database from this system (old or new) has. A file
// that passes can be opened and upgraded by database.js.
const REQUIRED_COLUMNS = {
  settings: ['company_name', 'currency'],
  clients: ['name'],
  invoices: ['invoice_number', 'client_name', 'total', 'status', 'due_date'],
  invoice_items: ['invoice_id', 'description', 'amount'],
  revenue: ['client_name', 'invoice_date', 'amount', 'payment_status'],
  expenses: ['title', 'category', 'amount', 'payment_date'],
};

// Checks that an uploaded file really is a database from this system.
// Returns an error message, or null when it is safe to restore.
function validateBackupFile(file) {
  let candidate;
  try {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.toString('latin1') !== 'SQLite format 3\u0000') return 'This file is not a database backup';

    candidate = new Database(file, { readonly: true, fileMustExist: true });
    const check = candidate.pragma('integrity_check', { simple: true });
    if (check !== 'ok') return 'The backup file is damaged';
    const tables = candidate.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!tables.includes(table)) return 'This database is not from this finance system';
      const present = candidate.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (columns.some((c) => !present.includes(c))) return 'This database is not from this finance system';
    }
    return null;
  } catch {
    return 'The backup file could not be read';
  } finally {
    try { candidate?.close(); } catch { /* already closed */ }
    removeSidecars(file);
  }
}

// Stages a validated file; database.js swaps it in on the next start.
function stageRestore(file) {
  fs.copyFileSync(file, `${config.dbPath}.restore`);
}

module.exports = {
  createBackup, listBackups, backupPath, deleteBackup, pruneAutomatic,
  runScheduledBackup, validateBackupFile, stageRestore,
};
