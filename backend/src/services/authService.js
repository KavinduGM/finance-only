const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../database');
const config = require('../config');

const BCRYPT_COST = 12;
const MAX_FAILED_ATTEMPTS = 5; // wrong passwords from one address before that address is held back
const LOCK_MINUTES = 15;
// Wrong passwords for one account across ALL addresses before the account
// itself pauses. High on purpose: it is a backstop against many addresses
// guessing at once, not something a single outsider can trigger.
const ACCOUNT_BACKSTOP = 30;
const SESSION_COOKIE = 'fin_session';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

// ── Passwords ────────────────────────────────────────────────────────────────

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_COST);
const verifyPassword = (password, hash) => bcrypt.compare(String(password), hash || '');

// Returns a message describing what is wrong, or null when the password is acceptable.
function passwordProblem(password, username = '') {
  const p = String(password || '');
  if (p.length < 10) return 'Password must be at least 10 characters';
  // bcrypt only reads the first 72 bytes; refuse anything longer rather than silently truncating.
  if (Buffer.byteLength(p, 'utf8') > 72) return 'Password must be 72 characters or fewer';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain both letters and numbers';
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username';
  return null;
}

// Random password without look-alike characters (no 0/O, 1/l/I).
function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < alphabet.length * 4) out += alphabet[byte % alphabet.length];
  }
  // Guarantee the policy (letters and numbers) is met.
  return /[0-9]/.test(out) && /[A-Za-z]/.test(out) ? out : generatePassword(length);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// The browser holds a random token in an HttpOnly cookie; only its hash is stored.

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, ip, user_agent, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sha256(token), userId, req.ip || null, String(req.get('user-agent') || '').slice(0, 300),
    now, now, isoIn(config.sessionDays * 86400000));
  return token;
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
           u.id, u.username, u.name, u.email, u.role, u.is_active, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  const now = new Date().toISOString();
  if (row.expires_at <= now || !row.is_active) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(row.session_id);
    return null;
  }
  // Touch at most once a minute to avoid a write on every request.
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now, row.session_id);
  }
  return {
    sessionId: row.session_id,
    user: {
      id: row.id, username: row.username, name: row.name, email: row.email, role: row.role,
      must_change_password: !!row.must_change_password,
    },
  };
}

const destroySession = (sessionId) => db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);

function destroyUserSessions(userId, exceptSessionId = null) {
  if (exceptSessionId) db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(userId, exceptSessionId);
  else db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

const purgeExpiredSessions = () =>
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());

function readCookie(req, name = SESSION_COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieOptions(req) {
  const secure = config.cookieSecure === 'auto' ? req.secure : ['1', 'true', 'yes'].includes(String(config.cookieSecure).toLowerCase());
  return { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: config.sessionDays * 86400000 };
}

const setSessionCookie = (req, res, token) => res.cookie(SESSION_COOKIE, token, cookieOptions(req));
const clearSessionCookie = (req, res) => {
  const { maxAge, ...opts } = cookieOptions(req);
  res.clearCookie(SESSION_COOKIE, opts);
};

// ── Login ────────────────────────────────────────────────────────────────────

// Hash compared against when the username does not exist, so a wrong username
// takes as long to reject as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// Wrong passwords are counted per username AND address. Someone guessing from
// elsewhere is held back themselves and cannot lock the real owner out. Names
// that do not exist are counted the same way, so being held back says nothing
// about whether an account exists.
const attempts = new Map(); // "username|address" → { count, lockedUntil, lastAt }
const attemptKey = (username, ip) => `${String(username || '').trim().toLowerCase()}|${ip || 'unknown'}`;

const heldBack = (key) => (attempts.get(key)?.lockedUntil || 0) > Date.now();

// Returns true when this failure reached the limit.
function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, lockedUntil: 0, lastAt: now };
  entry.count += 1;
  entry.lastAt = now;
  const locked = entry.count >= MAX_FAILED_ATTEMPTS;
  if (locked) {
    entry.count = 0;
    entry.lockedUntil = now + LOCK_MINUTES * 60000;
  }
  attempts.set(key, entry);
  return locked;
}

// Forget stale counters so the map cannot grow without bound.
setInterval(() => {
  const cutoff = Date.now() - LOCK_MINUTES * 60000;
  for (const [key, entry] of attempts) {
    if (entry.lockedUntil < Date.now() && entry.lastAt < cutoff) attempts.delete(key);
  }
}, 5 * 60000).unref();

// Used when an administrator unlocks an account or resets its password.
function clearLoginAttempts(username) {
  const prefix = `${String(username || '').trim().toLowerCase()}|`;
  for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key);
}

async function login(username, password, ip) {
  const key = attemptKey(username, ip);
  if (heldBack(key)) return { ok: false, reason: 'locked' };

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user) {
    await verifyPassword(password, DUMMY_HASH);
    return { ok: false, reason: recordFailure(key) ? 'locked' : 'invalid' };
  }

  const now = new Date().toISOString();
  const accountPaused = !!user.locked_until && user.locked_until > now;
  const valid = await verifyPassword(password, user.password_hash);

  if (valid && user.is_active) {
    // While the account is paused, only an address with no wrong guesses of its
    // own gets in: the owner still can, the guessers cannot.
    if (accountPaused && attempts.has(key)) return { ok: false, reason: 'locked', user };
    attempts.delete(key);
    db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?').run(now, user.id);
    return { ok: true, user };
  }

  if (!valid) {
    const locked = recordFailure(key);
    const total = user.failed_attempts + 1;
    const pause = total >= ACCOUNT_BACKSTOP;
    db.prepare('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?')
      .run(pause ? 0 : total, pause ? isoIn(LOCK_MINUTES * 60000) : user.locked_until, user.id);
    if (locked) return { ok: false, reason: 'locked', user };
  }
  return { ok: false, reason: 'invalid', user };
}

async function setPassword(userId, newPassword, { mustChange = false } = {}) {
  const hash = await hashPassword(newPassword);
  db.prepare(`
    UPDATE users SET password_hash=?, must_change_password=?, failed_attempts=0, locked_until=NULL,
      password_changed_at=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(hash, mustChange ? 1 : 0, new Date().toISOString(), userId);
  const row = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  if (row) clearLoginAttempts(row.username);
}

function audit(req, action, detail = null, user = null) {
  const u = user || req?.user || null;
  db.prepare('INSERT INTO audit_log (user_id, username, action, detail, ip) VALUES (?,?,?,?,?)')
    .run(u?.id ?? null, u?.username ?? null, action, detail, req?.ip ?? null);
}

// ── First administrator ──────────────────────────────────────────────────────

// Runs at startup. Creates the first admin only when no user exists yet.
function ensureInitialAdmin() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return;

  // Database carried over from the old system: its admin username is kept, its
  // password is not. The old system shipped with a published default password,
  // so the old hash is never accepted; the account starts with ADMIN_PASSWORD
  // or a generated password like any first administrator.
  let legacyUsername = null;
  if (db.columnsOf('settings').includes('admin_password_hash')) {
    const old = db.prepare('SELECT admin_username, admin_password_hash FROM settings WHERE id=1').get();
    if (old?.admin_password_hash) {
      legacyUsername = String(old.admin_username || '').trim() || null;
      db.prepare('UPDATE settings SET admin_password_hash=NULL WHERE id=1').run();
    }
  }

  const username = legacyUsername || config.adminUsername || 'admin';
  const provided = config.adminPassword;
  const problem = provided ? passwordProblem(provided, username) : null;
  if (provided && problem) {
    console.warn(`ADMIN_PASSWORD rejected (${problem}). A random password was generated instead.`);
  }
  const usable = provided && !problem;
  const password = usable ? provided : generatePassword(18);

  db.prepare(`INSERT INTO users (username, name, password_hash, role, must_change_password, password_changed_at) VALUES (?, 'Administrator', ?, 'admin', ?, ?)`)
    .run(username, bcrypt.hashSync(password, BCRYPT_COST), usable ? 0 : 1, new Date().toISOString());

  if (usable) {
    console.log(`Admin account "${username}" created with the password from ADMIN_PASSWORD.`);
  } else {
    // Shown once, in the server log only. It has to be changed at first login.
    console.log([
      '',
      '==============================================================',
      '  First-time setup: administrator account created',
      `    Username: ${username}`,
      `    Password: ${password}`,
      '  You will be asked to choose a new password at first login.',
      '==============================================================',
      '',
    ].join('\n'));
  }
}

module.exports = {
  SESSION_COOKIE, MAX_FAILED_ATTEMPTS, LOCK_MINUTES, clearLoginAttempts,
  hashPassword, verifyPassword, passwordProblem, generatePassword, setPassword,
  createSession, getSession, destroySession, destroyUserSessions, purgeExpiredSessions,
  readCookie, setSessionCookie, clearSessionCookie,
  login, audit, ensureInitialAdmin,
};
