const auth = require('../services/authService');

// Every /api route except login and health goes through this.
function requireAuth(req, res, next) {
  const session = auth.getSession(auth.readCookie(req));
  if (!session) {
    return res.status(401).json({ error: 'Please sign in', code: 'UNAUTHENTICATED' });
  }
  req.user = session.user;
  req.sessionId = session.sessionId;
  next();
}

// Until a temporary password has been replaced, only the auth endpoints work.
function requirePasswordCurrent(req, res, next) {
  if (req.user?.must_change_password) {
    return res.status(403).json({ error: 'Choose a new password to continue', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = { requireAuth, requirePasswordCurrent, requireAdmin };
