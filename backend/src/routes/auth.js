const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { wrap, HttpError, v } = require('../lib/http');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many sign-in attempts from this address. Try again in 15 minutes.',
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const username = v.str(req.body?.username, 'Username', { required: true, max: 100 });
  const password = v.str(req.body?.password, 'Password', { required: true, max: 200 });

  const result = await auth.login(username, password, req.ip);
  if (!result.ok) {
    auth.audit(req, 'login_failed', `username=${username}${result.reason === 'locked' ? ' (locked)' : ''}`, result.user);
    if (result.reason === 'locked') {
      throw new HttpError(423, `Too many wrong passwords. Try again in ${auth.LOCK_MINUTES} minutes.`, 'LOCKED');
    }
    throw new HttpError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
  }

  const token = auth.createSession(result.user.id, req);
  auth.setSessionCookie(req, res, token);
  auth.audit(req, 'login', null, result.user);
  const u = result.user;
  res.json({
    user: {
      id: u.id, username: u.username, name: u.name, email: u.email, role: u.role,
      must_change_password: !!u.must_change_password,
    },
  });
}));

router.post('/logout', (req, res) => {
  const session = auth.getSession(auth.readCookie(req));
  if (session) auth.destroySession(session.sessionId);
  auth.clearSessionCookie(req, res);
  res.json({ message: 'Signed out' });
});

router.use(requireAuth);

router.get('/me', (req, res) => res.json({ user: req.user }));

router.post('/change-password', wrap(async (req, res) => {
  const current = v.str(req.body?.current_password, 'Current password', { required: true, max: 200 });
  const next = v.str(req.body?.new_password, 'New password', { required: true, max: 200 });

  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!(await auth.verifyPassword(current, row.password_hash))) {
    auth.audit(req, 'password_change_failed');
    throw new HttpError(400, 'Current password is incorrect');
  }
  const problem = auth.passwordProblem(next, req.user.username);
  if (problem) throw new HttpError(400, problem);
  if (await auth.verifyPassword(next, row.password_hash)) {
    throw new HttpError(400, 'New password must be different from the current one');
  }

  await auth.setPassword(req.user.id, next);
  // Any other device signed in with the old password is signed out.
  auth.destroyUserSessions(req.user.id, req.sessionId);
  auth.audit(req, 'password_changed');
  res.json({ message: 'Password updated' });
}));

router.put('/profile', wrap((req, res) => {
  const name = v.str(req.body?.name, 'Name', { max: 100 });
  const email = v.email(req.body?.email, 'Email');
  db.prepare('UPDATE users SET name=?, email=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, email, req.user.id);
  res.json({ user: { ...req.user, name, email } });
}));

router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions
    WHERE user_id=? ORDER BY last_seen_at DESC
  `).all(req.user.id);
  res.json(rows.map((s) => ({ ...s, current: s.id === req.sessionId })));
});

router.post('/logout-others', (req, res) => {
  auth.destroyUserSessions(req.user.id, req.sessionId);
  auth.audit(req, 'logout_other_sessions');
  res.json({ message: 'Signed out of all other devices' });
});

module.exports = router;
