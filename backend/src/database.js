const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

for (const dir of [config.dataDir, config.uploadsDir, config.backupsDir,
  path.join(config.uploadsDir, 'receipts'), path.join(config.uploadsDir, 'logos')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// A restore uploaded from Settings → Backup is staged next to the live database
// and swapped in here, before anything opens it. Only the server itself applies
// it: a maintenance script that loads this module must not swap databases.
const STAGED_RESTORE = `${config.dbPath}.restore`;
const ENTRY = require.main ? path.basename(require.main.filename) : '';
const IS_SERVER = ENTRY === 'server.js' || ENTRY === 'container-start.js';
let restoredFrom = null; // path of the safety copy when a restore was just applied

// Copies the current database including whatever is still in its write-ahead
// log. A plain file copy would miss every change since the last checkpoint.
function safetyCopy(target) {
  try {
    const current = new Database(config.dbPath);
    try {
      current.pragma('wal_checkpoint(TRUNCATE)');
      current.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      current.close();
    }
  } catch (err) {
    // Unreadable through SQLite: keep the raw files so nothing is thrown away.
    console.warn(`Could not copy the database through SQLite (${err.message}); keeping the raw files instead`);
    fs.rmSync(target, { force: true });
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(config.dbPath + suffix)) fs.copyFileSync(config.dbPath + suffix, target + suffix);
    }
  }
}

function applyStagedRestore() {
  if (!IS_SERVER || !fs.existsSync(STAGED_RESTORE)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(config.backupsDir, `pre-restore-${stamp}.db`);
  if (fs.existsSync(config.dbPath)) safetyCopy(copy);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  fs.renameSync(STAGED_RESTORE, config.dbPath);
  restoredFrom = fs.existsSync(copy) ? copy : '';
  console.log('Database restored from backup; the previous database was saved in backups/');
}
applyStagedRestore();

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const tableExists = (name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ── Schema ───────────────────────────────────────────────────────────────────
// Table and column names match the original system, so a financial.db copied
// from the old deployment upgrades in place.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    company_name TEXT DEFAULT 'GroovyMark',
    company_email TEXT,
    company_phone TEXT,
    company_address TEXT,
    company_website TEXT,
    currency TEXT DEFAULT 'LKR',
    currency_symbol TEXT DEFAULT 'Rs.',
    logo_path TEXT,
    smtp_host TEXT,
    smtp_port INTEGER DEFAULT 465,
    smtp_secure INTEGER DEFAULT 1,
    smtp_user TEXT,
    smtp_pass TEXT,
    invoice_prefix TEXT DEFAULT 'INV',
    invoice_terms TEXT DEFAULT 'Payment is due within 30 days of invoice date.',
    invoice_notes TEXT,
    auto_send_reminders INTEGER DEFAULT 1,
    reminder_days_before INTEGER DEFAULT 3,
    overdue_check_enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    password_changed_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    address TEXT,
    country TEXT DEFAULT 'Sri Lanka',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_number TEXT UNIQUE NOT NULL,
    client_id INTEGER,
    client_name TEXT NOT NULL,
    client_email TEXT,
    client_address TEXT,
    client_company TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    issue_date DATE NOT NULL,
    valid_until DATE NOT NULL,
    currency TEXT DEFAULT 'LKR',
    currency_symbol TEXT DEFAULT 'Rs.',
    subtotal REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft',
    notes TEXT,
    terms TEXT,
    email_sent INTEGER DEFAULT 0,
    sent_at DATETIME,
    decided_at DATETIME,
    invoice_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS proposal_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    unit_price REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    client_id INTEGER,
    client_name TEXT NOT NULL,
    client_email TEXT,
    client_address TEXT,
    client_company TEXT,
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    subtotal REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'Draft',
    notes TEXT,
    terms TEXT,
    paid_date DATE,
    pdf_path TEXT,
    email_sent INTEGER DEFAULT 0,
    email_sent_at DATETIME,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    unit_price REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS revenue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    client_name TEXT NOT NULL,
    project_name TEXT,
    service_type TEXT,
    invoice_number TEXT,
    invoice_date DATE,
    due_date DATE,
    amount REAL NOT NULL DEFAULT 0,
    payment_status TEXT DEFAULT 'Pending',
    payment_method TEXT,
    is_recurring INTEGER DEFAULT 0,
    billing_cycle TEXT DEFAULT 'One-time',
    currency TEXT DEFAULT 'LKR',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    vendor TEXT,
    amount REAL NOT NULL DEFAULT 0,
    payment_date DATE,
    payment_method TEXT,
    is_recurring INTEGER DEFAULT 0,
    billing_cycle TEXT,
    receipt_path TEXT,
    notes TEXT,
    currency TEXT DEFAULT 'LKR',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Payroll payees. Kept under the original table name for data compatibility.
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position TEXT,
    department TEXT,
    email TEXT,
    phone TEXT,
    salary_type TEXT DEFAULT 'Monthly',
    base_salary REAL DEFAULT 0,
    start_date DATE,
    status TEXT DEFAULT 'Active',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS salary_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER,
    employee_name TEXT NOT NULL,
    position TEXT,
    department TEXT,
    salary_type TEXT DEFAULT 'Monthly',
    base_salary REAL DEFAULT 0,
    bonuses REAL DEFAULT 0,
    deductions REAL DEFAULT 0,
    net_salary REAL DEFAULT 0,
    payment_month TEXT,
    payment_date DATE,
    payment_method TEXT DEFAULT 'Bank Transfer',
    status TEXT DEFAULT 'Pending',
    slip_sent INTEGER DEFAULT 0,
    slip_sent_at DATETIME,
    notes TEXT,
    pdf_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS recurring_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT,
    billing_cycle TEXT DEFAULT 'Monthly',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'LKR',
    next_payment_date DATE,
    auto_renewal INTEGER DEFAULT 1,
    status TEXT DEFAULT 'Active',
    client_vendor TEXT,
    email TEXT,
    reminder_days INTEGER DEFAULT 3,
    last_reminder_sent DATE,
    last_processed_date DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'info',
    title TEXT NOT NULL,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    related_id INTEGER,
    related_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Every dedupe key ever raised. Kept apart from the notifications themselves
  -- so that deleting an alert does not let a scheduled job raise it again.
  CREATE TABLE IF NOT EXISTS notification_keys (
    key TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY DEFAULT 1,
    base TEXT DEFAULT 'USD',
    rates_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// Columns added after a table first shipped. Applied to old and new databases
// alike, so a column is never assumed to exist just because the table does.
const ADDED_COLUMNS = {
  settings: {
    company_tax_id: 'TEXT',
    smtp_from_name: 'TEXT',
    proposal_prefix: `TEXT DEFAULT 'PRO'`,
    proposal_terms: `TEXT DEFAULT 'This proposal is valid until the date shown above. Work begins once the proposal is accepted.'`,
    proposal_validity_days: 'INTEGER DEFAULT 30',
    invoice_due_days: 'INTEGER DEFAULT 30',
    default_tax_rate: 'REAL DEFAULT 0',
    bank_name: 'TEXT',
    bank_account_name: 'TEXT',
    bank_account_no: 'TEXT',
    bank_branch: 'TEXT',
    bank_swift: 'TEXT',
    payment_instructions: 'TEXT',
    low_cash_alert_enabled: 'INTEGER DEFAULT 1',
  },
  invoices: {
    currency: `TEXT DEFAULT 'LKR'`,
    currency_symbol: `TEXT DEFAULT 'Rs.'`,
    proposal_id: 'INTEGER',
    // Status the invoice had when its payment was recorded, so "mark as unpaid" can put it back.
    status_before_paid: 'TEXT',
  },
  // invoice_id links the automatic income row to its invoice (was matched by number).
  // source marks income recorded from a recurring item: "recurring:12:2026-03-01".
  revenue: { auto_recorded: 'INTEGER DEFAULT 0', invoice_id: 'INTEGER', source: 'TEXT' },
  // source marks automatic rows: "payroll:2026-03:LKR" or "recurring:12:2026-03-01".
  expenses: { source: 'TEXT' },
  employees: { currency: `TEXT DEFAULT 'LKR'`, bank_details: 'TEXT' },
  salary_payments: { currency: `TEXT DEFAULT 'LKR'` },
  notifications: { dedupe_key: 'TEXT' },
};

// Tables that belonged to the removed HR, task, client-portal and AI modules.
const LEGACY_TABLES = [
  'task_resources', 'tasks', 'projects', 'project_types', 'calendar_events',
  'employee_credentials', 'employee_leaves', 'employee_leave_requests', 'employee_kpi',
  'employee_notices', 'birthday_wishes', 'client_credentials', 'payment_slips',
  'online_payments', 'payment_gateway_settings', 'ai_cache', 'budget', 'departments',
];

function migrateLegacy() {
  const present = LEGACY_TABLES.filter(tableExists);
  if (present.length === 0) return;

  // This drops data from the old system, so keep a full copy first.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(config.backupsDir, `pre-upgrade-${stamp}.db`);
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  console.log(`Old-system tables found. Full copy saved to ${copy}`);

  // The dropped tables reference each other; checks are restored right after.
  db.pragma('foreign_keys = OFF');
  try {
    dropLegacyTables(present);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log(`Removed ${present.length} tables from the old HR, task, portal and AI modules`);
}

function dropLegacyTables(present) {
  db.transaction(() => {
    // Bank details used to live with the payment-gateway settings.
    if (tableExists('payment_gateway_settings')) {
      const gw = db.prepare('SELECT * FROM payment_gateway_settings WHERE id=1').get();
      const cur = db.prepare('SELECT bank_account_no FROM settings WHERE id=1').get();
      if (gw && !cur?.bank_account_no) {
        db.prepare(`UPDATE settings SET bank_name=?, bank_account_name=?, bank_account_no=?, bank_branch=?, bank_swift=? WHERE id=1`)
          .run(gw.bank_name || null, gw.bank_account_name || null, gw.bank_account_no || null, gw.bank_branch || null, gw.bank_swift || null);
      }
    }
    for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t}`);

    const settingsCols = columnsOf('settings');
    if (settingsCols.includes('openai_key')) db.exec('UPDATE settings SET openai_key=NULL WHERE id=1');

    // Link automatic income rows to their invoices.
    db.exec(`
      UPDATE revenue SET invoice_id = (SELECT i.id FROM invoices i WHERE i.invoice_number = revenue.invoice_number)
      WHERE invoice_id IS NULL AND auto_recorded = 1 AND invoice_number IS NOT NULL
    `);
  })();
}

function initializeDatabase() {
  db.exec(SCHEMA);

  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const existing = columnsOf(table);
    for (const [name, ddl] of Object.entries(cols)) {
      if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  }

  db.exec(`
    INSERT OR IGNORE INTO settings (id) VALUES (1);
    INSERT OR IGNORE INTO exchange_rates (id, base) VALUES (1, 'USD');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_source ON expenses(source) WHERE source IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_source ON revenue(source) WHERE source IS NOT NULL;
    INSERT OR IGNORE INTO notification_keys (key) SELECT dedupe_key FROM notifications WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_revenue_invoice ON revenue(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_date ON revenue(invoice_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(payment_date);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_salary_month ON salary_payments(payment_month);
  `);

  migrateLegacy();
  repairCarriedOverData();
}

// Idempotent clean-ups for databases that came from the old system.
function repairCarriedOverData() {
  db.exec(`
    -- The old system deleted clients without clearing the documents that pointed at them.
    UPDATE invoices SET client_id=NULL WHERE client_id IS NOT NULL AND client_id NOT IN (SELECT id FROM clients);
    UPDATE proposals SET client_id=NULL WHERE client_id IS NOT NULL AND client_id NOT IN (SELECT id FROM clients);
    UPDATE revenue SET client_id=NULL WHERE client_id IS NOT NULL AND client_id NOT IN (SELECT id FROM clients);

    -- A paid invoice whose income was a hand-entered row with the same number and
    -- amount: treat that row as the invoice's own income, so marking the invoice
    -- unpaid or deleting it removes the income too. Only when nothing else mirrors it.
    UPDATE revenue SET auto_recorded=1,
      invoice_id=(SELECT i.id FROM invoices i WHERE i.invoice_number = revenue.invoice_number)
    WHERE COALESCE(auto_recorded, 0) = 0 AND invoice_id IS NULL
      AND payment_status='Paid' AND invoice_number IS NOT NULL
      AND EXISTS (SELECT 1 FROM invoices i WHERE i.invoice_number = revenue.invoice_number
                  AND i.status='Paid' AND ABS(i.total - revenue.amount) < 0.005)
      AND NOT EXISTS (SELECT 1 FROM revenue r2 WHERE r2.id <> revenue.id
                      AND r2.invoice_number = revenue.invoice_number AND (r2.auto_recorded = 1 OR r2.id < revenue.id));
  `);
}

try {
  initializeDatabase();
} catch (err) {
  if (restoredFrom === null) throw err;
  // The restored file cannot be used. Put the previous database back so the
  // system still starts, and keep the rejected file for inspection.
  console.error(`The restored database could not be used (${err.message}). Going back to the previous database.`);
  db.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  fs.renameSync(config.dbPath, path.join(config.backupsDir, `rejected-restore-${stamp}.db`));
  if (restoredFrom) fs.copyFileSync(restoredFrom, config.dbPath);
  process.exit(1); // the restart policy starts the app again on the previous database
}

// Sessions inside a backup belong to the past: everyone signs in again after a restore.
if (restoredFrom !== null) db.exec('DELETE FROM sessions');

module.exports = db;
module.exports.tableExists = tableExists;
module.exports.columnsOf = columnsOf;
