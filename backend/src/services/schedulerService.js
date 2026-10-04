const cron = require('node-cron');
const { getISOWeek, getISOWeekYear, parseISO } = require('date-fns');
const db = require('../database');
const config = require('../config');
const { today, shiftDate } = require('../lib/dates');
const { formatMoney, round2 } = require('../lib/money');
const { getSettings, baseCurrency } = require('../lib/settings');
const { notify } = require('../lib/notify');
const { refreshOverdue, expireProposals: sharedExpireProposals } = require('./invoiceService');
const currencyService = require('./currencyService');
const email = require('./emailService');
const { runScheduledBackup } = require('./backupService');
const { purgeExpiredSessions } = require('./authService');

// Background jobs. All times are in the business timezone (config.timezone).
// Every job is safe to run twice: status changes only match rows that still
// need them, and repeatable notifications carry a dedupe key.

const DAY_MS = 86400000;
const MAX_REMINDERS = 6;             // per invoice, the "due soon" reminder included
const OVERDUE_REMINDER_GAP_DAYS = 3;
const MAX_REMINDER_DAYS = 60;        // upper limit of both reminder-day settings
const BURN_WINDOW_DAYS = 90;
const READ_NOTIFICATION_DAYS = 90;
const AUDIT_LOG_DAYS = 365;

// ── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2026-03-05 → "5 Mar 2026", straight from the stored string (no timezone involved).
function displayDate(value) {
  const stored = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stored);
  return m && MONTHS[m[2] - 1] ? `${Number(m[3])} ${MONTHS[m[2] - 1]} ${m[1]}` : stored;
}

const dateOnly = (value) => String(value || '').trim().slice(0, 10);
const hasText = (value) => typeof value === 'string' && value.trim() !== '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const shorten = (value, max = 300) => {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

// A day count from a settings or recurring row. 0 is a real value ("on the due
// date"), so this cannot be written as `value || fallback`.
const dayCount = (value, fallback, max) =>
  (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback);

// Calendar day, in the business timezone, of a stored timestamp. New rows hold
// ISO strings; rows written with CURRENT_TIMESTAMP hold "YYYY-MM-DD HH:MM:SS",
// which is UTC without a zone marker.
function businessDay(stamp) {
  if (!stamp) return null;
  const s = String(stamp).trim();
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const ms = Date.parse(sqlite ? `${s.replace(' ', 'T')}Z` : s);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

// "YYYY-MM-DD HH:MM:SS" in UTC: the format CURRENT_TIMESTAMP stores, so a
// cut-off computed here compares correctly against created_at columns.
const sqliteStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ISO-8601 week of a YYYY-MM-DD date, e.g. "2026-W40". The first days of
// January can belong to the last week of the year before.
function isoWeekKey(day) {
  const date = parseISO(day);
  return `${getISOWeekYear(date)}-W${String(getISOWeek(date)).padStart(2, '0')}`;
}

// ── 1. Exchange rates (every 4 hours) ────────────────────────────────────────

// A network problem is handled inside refreshRates: the saved rates stay in use.
async function refreshRates() {
  const { live } = await currencyService.refreshRates();
  return { live };
}

// ── 2. Overdue invoices (hourly) ─────────────────────────────────────────────

// The sweep (and its notifications) lives in invoiceService, shared with the page loads.
const sweepOverdue = () => refreshOverdue().length;

async function markOverdue() {
  return { marked: sweepOverdue() };
}

// ── 3. Expired proposals (hourly) ────────────────────────────────────────────

const sweepExpiredProposals = () => sharedExpireProposals().length;

async function expireProposals() {
  return { expired: sweepExpiredProposals() };
}

// ── 4. Invoice payment reminders (daily 09:00) ───────────────────────────────

// Which reminder an invoice should get today: 'upcoming', 'overdue' or null.
function reminderKind(inv, day, daysBefore) {
  // A zero invoice has nothing to collect.
  if (!inv || !hasText(inv.client_email) || !(Number(inv.total) > 0)) return null;
  const sent = Number(inv.reminder_count) || 0;
  const due = dateOnly(inv.due_date);

  if (inv.status === 'Sent') {
    // One "due soon" reminder. The window is a range, so a day when the server
    // was down does not skip the invoice for good.
    return sent === 0 && due >= day && due <= shiftDate(day, { days: daysBefore }) ? 'upcoming' : null;
  }
  if (inv.status === 'Overdue') {
    if (sent >= MAX_REMINDERS) return null;
    // Counted in calendar days: a reminder sent on the 1st is followed on the
    // 4th, even though the job starts a few seconds short of 72 hours later.
    const last = businessDay(inv.last_reminder_at);
    return !last || last <= shiftDate(day, { days: -OVERDUE_REMINDER_GAP_DAYS }) ? 'overdue' : null;
  }
  return null;
}

const recordReminder = db.transaction((inv, kind, base) => {
  db.prepare('UPDATE invoices SET reminder_count = COALESCE(reminder_count, 0) + 1, last_reminder_at = ? WHERE id = ?')
    .run(new Date().toISOString(), inv.id);

  const count = (Number(inv.reminder_count) || 0) + 1;
  const about = `invoice ${inv.invoice_number} (${formatMoney(inv.total, inv.currency || base)}, due ${displayDate(inv.due_date)})`;
  const message = kind === 'overdue'
    ? `An overdue reminder for ${about} was emailed to ${inv.client_name}.`
      + (count >= MAX_REMINDERS ? ' This was the last automatic reminder for this invoice.' : '')
    : `A payment reminder for ${about} was emailed to ${inv.client_name}.`;
  notify('info', kind === 'overdue' ? 'Overdue reminder sent' : 'Payment reminder sent', message,
    { relatedType: 'invoice', relatedId: inv.id });
});

async function sendInvoiceReminders() {
  const settings = getSettings();
  if (!settings.auto_send_reminders) return { skipped: 'automatic reminders are switched off' };
  if (!email.isEmailConfigured(settings)) return { skipped: 'email is not configured' };

  // Statuses first, so an invoice that went past due overnight gets the overdue wording.
  sweepOverdue();

  const day = today();
  const daysBefore = dayCount(settings.reminder_days_before, 3, MAX_REMINDER_DAYS);
  const candidates = db.prepare(`
    SELECT id FROM invoices
    WHERE client_email IS NOT NULL AND TRIM(client_email) <> ''
      AND COALESCE(reminder_count, 0) < ?
      AND ((status='Sent' AND due_date >= ? AND due_date <= ?) OR status='Overdue')
    ORDER BY due_date, id
  `).all(MAX_REMINDERS, day, shiftDate(day, { days: daysBefore }));

  const load = db.prepare('SELECT * FROM invoices WHERE id=?');
  const result = { upcoming: 0, overdue: 0, failed: 0 };
  let firstFailure = null;

  for (const { id } of candidates) {
    // Read again right before sending: the sends before this one take time, and
    // the invoice may have been paid or cancelled meanwhile.
    const inv = load.get(id);
    const kind = reminderKind(inv, day, daysBefore);
    if (!kind) continue;
    try {
      await email.sendPaymentReminderEmail(inv, settings);
      recordReminder(inv, kind, settings.currency);
      result[kind] += 1;
    } catch (err) {
      // One address that bounces must not hold up the other clients.
      result.failed += 1;
      firstFailure = firstFailure || `Invoice ${inv.invoice_number}: ${err.message}`;
      console.error(`Payment reminder for invoice ${inv.invoice_number} failed: ${err.message}`);
    }
  }

  if (result.failed) {
    notify('warning', 'Payment reminders not sent',
      `${plural(result.failed, 'payment reminder', 'payment reminders')} could not be emailed today. ${shorten(firstFailure)}`,
      { dedupeKey: `invoice-reminders-failed:${day}` });
  }
  return result;
}

// ── 5. Recurring payment reminders (daily 09:00) ─────────────────────────────

// True when the payment is inside its reminder window and this occurrence has
// not been reminded yet. Processing a payment moves next_payment_date on, which
// opens a new window.
function recurringReminderDue(rp, day) {
  if (!rp || (rp.status || 'Active') !== 'Active') return false;
  const due = dateOnly(rp.next_payment_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < day) return false;
  const windowStart = shiftDate(due, { days: -dayCount(rp.reminder_days, 3, MAX_REMINDER_DAYS) });
  if (day < windowStart) return false;
  const last = dateOnly(rp.last_reminder_sent);
  return !last || last < windowStart;
}

const recordRecurringReminder = db.transaction((rp, day, base) => {
  const income = rp.type === 'Income';
  const due = dateOnly(rp.next_payment_date);
  const party = hasText(rp.client_vendor) ? ` ${income ? 'from' : 'to'} ${rp.client_vendor.trim()}` : '';
  const when = due === day ? 'today' : `on ${displayDate(due)}`;
  notify('info', income ? 'Income expected' : 'Payment due soon',
    `${rp.name}: ${formatMoney(rp.amount, rp.currency || base)} is ${income ? 'expected' : 'due'}${party} ${when}.`,
    { dedupeKey: `recurring-due:${rp.id}:${rp.next_payment_date}`, relatedType: 'recurring', relatedId: rp.id });
  db.prepare('UPDATE recurring_payments SET last_reminder_sent=? WHERE id=?').run(day, rp.id);
});

async function sendRecurringReminders() {
  const settings = getSettings();
  const canEmail = email.isEmailConfigured(settings);
  const day = today();

  const candidates = db.prepare(`
    SELECT id FROM recurring_payments
    WHERE COALESCE(status, 'Active') = 'Active' AND next_payment_date >= ? AND next_payment_date <= ?
    ORDER BY next_payment_date, id
  `).all(day, shiftDate(day, { days: MAX_REMINDER_DAYS }));

  const load = db.prepare('SELECT * FROM recurring_payments WHERE id=?');
  const result = { reminded: 0, emailed: 0, failed: 0 };

  for (const { id } of candidates) {
    try {
      const rp = load.get(id);
      if (!recurringReminderDue(rp, day)) continue;

      // The in-app reminder and the "reminded" mark are saved before the email
      // is attempted, so a mail problem cannot make this occurrence repeat daily.
      recordRecurringReminder(rp, day, settings.currency);
      result.reminded += 1;

      if (!canEmail || !hasText(rp.email)) continue;
      try {
        await email.sendRecurringReminderEmail(rp, settings, rp.email.trim());
        result.emailed += 1;
      } catch (err) {
        result.failed += 1;
        console.error(`Reminder email for recurring payment "${rp.name}" failed: ${err.message}`);
        notify('warning', 'Reminder email not sent',
          `The reminder for ${rp.name} could not be emailed to ${rp.email.trim()}. ${shorten(err.message)}`,
          { dedupeKey: `recurring-email-failed:${rp.id}:${rp.next_payment_date}`, relatedType: 'recurring', relatedId: rp.id });
      }
    } catch (err) {
      console.error(`Reminder for recurring payment ${id} failed: ${err.message}`);
    }
  }
  return result;
}

// ── 6. Low cash alert (daily 00:10) ──────────────────────────────────────────

// Deleting a notification frees its dedupe key, so the week already alerted is
// remembered here as well. Otherwise a cleared alert would be back the next night.
let lowCashAlertWeek = null;

async function lowCashCheck() {
  const settings = getSettings();
  if (!settings.low_cash_alert_enabled) return { skipped: 'the low cash alert is switched off' };

  const day = today();
  const fx = currencyService.baseConverter();
  // Added up per currency in SQL, then converted to the base currency here.
  const total = (sql, ...params) => fx.sum(db.prepare(sql).all(...params));

  const income = total(`SELECT currency, SUM(amount) AS amount FROM revenue WHERE payment_status='Paid' GROUP BY currency`);
  // Payroll is already part of expenses (one row per paid month), so salary
  // payments are not subtracted a second time.
  const spent = total('SELECT currency, SUM(amount) AS amount FROM expenses GROUP BY currency');
  const recent = total(
    'SELECT currency, SUM(amount) AS amount FROM expenses WHERE payment_date >= ? AND payment_date <= ? GROUP BY currency',
    shiftDate(day, { days: -BURN_WINDOW_DAYS }), day,
  );

  const cash = round2(income - spent);
  const monthlyBurn = round2(recent / 3);
  const low = monthlyBurn > 0 && cash < monthlyBurn;

  if (low) {
    const week = isoWeekKey(day);
    if (lowCashAlertWeek !== week) {
      notify('critical', 'Low cash balance',
        `Cash balance is ${formatMoney(cash, fx.base)}, which is less than one month of expenses `
          + `(about ${formatMoney(monthlyBurn, fx.base)} a month over the last ${BURN_WINDOW_DAYS} days).`,
        { dedupeKey: `low-cash:${week}` });
      lowCashAlertWeek = week;
    }
  }
  return { cash, monthlyBurn, low, currency: fx.base };
}

// ── 7. Backup (daily 02:00) ──────────────────────────────────────────────────

async function backup() {
  try {
    return { file: await runScheduledBackup() };
  } catch (err) {
    // A missing backup is only noticed when it is needed, so say so in the app too.
    try {
      notify('critical', 'Automatic backup failed',
        `The automatic backup could not be created. ${shorten(err.message)}`,
        { dedupeKey: `backup-failed:${today()}` });
    } catch { /* the original error below is the one that matters */ }
    throw err;
  }
}

// ── 8. Housekeeping (daily 03:00) ────────────────────────────────────────────

const purgeOldRows = db.transaction(() => {
  const now = Date.now();
  return {
    sessions: purgeExpiredSessions().changes,
    notifications: db.prepare('DELETE FROM notifications WHERE is_read=1 AND created_at < ?')
      .run(sqliteStamp(now - READ_NOTIFICATION_DAYS * DAY_MS)).changes,
    auditLog: db.prepare('DELETE FROM audit_log WHERE created_at < ?')
      .run(sqliteStamp(now - AUDIT_LOG_DAYS * DAY_MS)).changes,
    // Old enough that the alert they guarded can no longer recur.
    notificationKeys: db.prepare('DELETE FROM notification_keys WHERE created_at < ?')
      .run(sqliteStamp(now - 400 * DAY_MS)).changes,
  };
});

async function housekeeping() {
  return purgeOldRows();
}

// ── Scheduling ───────────────────────────────────────────────────────────────

// A failure is logged and swallowed, so a job can never take the server down.
// A job that is still running (a slow mail server) is not started a second
// time, which would send every reminder twice.
function guarded(name, run) {
  let busy = false;
  const job = async () => {
    if (busy) return null;
    busy = true;
    try {
      return await run();
    } catch (err) {
      console.error(`Scheduled job ${name} failed:`, err);
      return null;
    } finally {
      busy = false;
    }
  };
  Object.defineProperty(job, 'name', { value: name });
  return job;
}

// Each one resolves to a short summary, or null when it failed or was already running.
const jobs = {
  refreshRates: guarded('refreshRates', refreshRates),
  markOverdue: guarded('markOverdue', markOverdue),
  expireProposals: guarded('expireProposals', expireProposals),
  sendInvoiceReminders: guarded('sendInvoiceReminders', sendInvoiceReminders),
  sendRecurringReminders: guarded('sendRecurringReminders', sendRecurringReminders),
  lowCashCheck: guarded('lowCashCheck', lowCashCheck),
  backup: guarded('backup', backup),
  housekeeping: guarded('housekeeping', housekeeping),
};

const SCHEDULE = [
  ['refreshRates', '0 */4 * * *'],
  ['markOverdue', '0 * * * *'],
  ['expireProposals', '0 * * * *'],
  ['sendInvoiceReminders', '0 9 * * *'],
  ['sendRecurringReminders', '0 9 * * *'],
  ['lowCashCheck', '10 0 * * *'],
  ['backup', '0 2 * * *'],
  ['housekeeping', '0 3 * * *'],
];

let started = false;

// Registers the jobs. Calling it again does nothing.
function start() {
  if (started) return;
  started = true;
  for (const [name, expression] of SCHEDULE) {
    // node-cron passes the tick time to the task and writes into the options
    // object, so each job gets its own closure and its own options.
    // recoverMissedExecutions: a tick missed while the process was busy still
    // runs afterwards. Every job is safe to run late or twice.
    cron.schedule(expression, () => jobs[name](), { timezone: config.timezone, name, recoverMissedExecutions: true });
  }
}

module.exports = { start, jobs };
