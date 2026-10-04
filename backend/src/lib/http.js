const { SUPPORTED_CURRENCIES } = require('./money');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Wraps a route handler so sync throws and rejected promises both reach the
// error middleware instead of crashing the process or hanging the request.
const wrap = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

const bad = (msg) => new HttpError(400, msg);
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// ── Input validators ─────────────────────────────────────────────────────────
// Each returns a clean value (or null when optional and blank) or throws 400.

function str(v, name, { required = false, max = 500 } = {}) {
  if (isBlank(v)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  // An array or object would otherwise be stored as "[object Object]" or "a,b".
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${name} must be text`);
  const s = String(v).trim();
  if (s.length > max) throw bad(`${name} must be ${max} characters or fewer`);
  return s;
}

function num(v, name, { required = false, min = -1e12, max = 1e12, def = null } = {}) {
  if (isBlank(v)) {
    if (required) throw bad(`${name} is required`);
    return def;
  }
  if (typeof v !== 'number' && typeof v !== 'string') throw bad(`${name} must be a number`);
  // Plain decimals only: "0x10", "1e9" and "" are not amounts.
  const text = typeof v === 'string' ? v.trim().replace(/,/g, '') : '';
  if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(text)) throw bad(`${name} must be a number`);
  const n = typeof v === 'number' ? v : Number(text);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  if (n < min) throw bad(`${name} must be at least ${min}`);
  if (n > max) throw bad(`${name} is too large`);
  return n;
}

function int(v, name, opts = {}) {
  const n = num(v, name, opts);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  return n;
}

function date(v, name, { required = false } = {}) {
  if (isBlank(v)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).trim().slice(0, 10);
  // Round-trip so impossible dates (31 February) are rejected instead of rolling over.
  const d = new Date(`${s}T00:00:00Z`);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  if (!ok) throw bad(`${name} must be a valid date (YYYY-MM-DD)`);
  // A year typed as "26" becomes 0026 and silently drops out of every report.
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) throw bad(`${name} must be between the years 2000 and 2100`);
  return s;
}

function month(v, name, { required = false } = {}) {
  if (isBlank(v)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  const s = String(v).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw bad(`${name} must be a month (YYYY-MM)`);
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) throw bad(`${name} must be between the years 2000 and 2100`);
  return s;
}

function oneOf(v, name, allowed, { required = false, def = null } = {}) {
  if (isBlank(v)) {
    if (required) throw bad(`${name} is required`);
    return def;
  }
  const s = String(v).trim();
  if (!allowed.includes(s)) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return s;
}

function email(v, name, { required = false } = {}) {
  const s = str(v, name, { required, max: 254 });
  if (s === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${name} must be a valid email address`);
  return s;
}

function currency(v, fallback = 'LKR') {
  if (isBlank(v)) return fallback;
  const s = String(v).trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(s)) throw bad(`Unsupported currency: ${s}`);
  return s;
}

const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' ? 1 : 0);

// Route :id → positive integer, otherwise 404 (never reaches SQL as a string).
function id(req, param = 'id') {
  const n = Number(req.params[param]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
  return n;
}

// Escapes % and _ so user search text is matched literally. Use with: LIKE ? ESCAPE '\'
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

module.exports = {
  HttpError, wrap,
  v: { str, num, int, date, month, oneOf, email, currency, flag, id, like, isBlank },
};
