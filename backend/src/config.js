const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');

// Load backend/.env no matter which directory the server is started from.
// Variables already set by the platform (Docker / Dokploy) always win.
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });
require('dotenv').config({ path: path.join(BACKEND_ROOT, '..', '.env') });

const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const env = process.env.NODE_ENV || 'development';
const dataDir = path.resolve(process.env.DATA_DIR || path.join(BACKEND_ROOT, 'data'));

module.exports = {
  env,
  isProd: env === 'production',
  port: int(process.env.PORT, 3001),

  // Everything that must survive a redeploy lives under dataDir:
  // the database, uploaded receipts/logo and automatic backups.
  dataDir,
  dbPath: path.join(dataDir, 'financial.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
  backupsDir: path.join(dataDir, 'backups'),
  frontendDist: path.join(BACKEND_ROOT, '..', 'frontend', 'dist'),

  // First administrator, created only when the users table is empty.
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  sessionDays: int(process.env.SESSION_DAYS, 7),
  // 'auto' = Secure cookie whenever the request arrived over HTTPS.
  cookieSecure: process.env.COOKIE_SECURE || 'auto',
  // Number of reverse proxies in front of the app. 0 = none: forwarded headers
  // are ignored, so a client cannot fake its address. The Docker image sets 1
  // (Dokploy's Traefik).
  trustProxy: int(process.env.TRUST_PROXY, 0),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),

  // Business timezone: "today", due dates and the 9 AM reminder jobs use it.
  timezone: process.env.APP_TIMEZONE || 'Asia/Colombo',

  backupKeep: int(process.env.BACKUP_KEEP, 14),
  restartOnRestore: bool(process.env.RESTART_ON_RESTORE, true),

  // Stops ALL outgoing email. For a demo or test copy running on real data,
  // so no client is ever emailed from it.
  emailDisabled: bool(process.env.EMAIL_DISABLED, false),

  // Email through Resend (https://resend.com). The API key is read from the
  // environment only: it is never stored in the database or sent to the browser.
  resend: {
    apiKey: (process.env.RESEND_API_KEY || '').trim(),
    // "Name <address@your-verified-domain>" or just the address.
    from: (process.env.EMAIL_FROM || '').trim(),
    replyTo: (process.env.EMAIL_REPLY_TO || '').trim(),
  },

  // Optional SMTP fallbacks, used only while the Settings page is left blank.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
};
