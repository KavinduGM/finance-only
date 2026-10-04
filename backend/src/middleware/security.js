const config = require('../config');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

const hostOf = (url) => {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
};

// The session cookie is SameSite=Strict; this is the second line of defence
// against cross-site requests. A browser always sends Origin on state-changing
// requests, so anything whose Origin is not this site is refused.
function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // non-browser client (curl, health checks)
  const allowed = [req.get('host'), req.get('x-forwarded-host'), hostOf(config.appUrl)]
    .filter(Boolean).map((h) => String(h).toLowerCase());
  if (allowed.includes(hostOf(origin))) return next();
  res.status(403).json({ error: 'Cross-site request blocked', code: 'BAD_ORIGIN' });
}

// Small in-memory limiter; enough for a single-instance deployment.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Try again later.', code: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = { securityHeaders, sameOriginOnly, rateLimit };
