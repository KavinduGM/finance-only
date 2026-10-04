const express = require('express');
const router = express.Router();
const db = require('../database');
const auth = require('../services/authService');
const { wrap, HttpError, v } = require('../lib/http');

// Mounted behind requireAdmin: only administrators manage accounts.

const ROLES = ['admin', 'staff'];
const PUBLIC_COLUMNS = `id, username, name, email, role, is_active, must_change_password,
  last_login_at, password_changed_at, locked_until, created_at`;

const activeAdminCount = (exceptId = 0) =>
  db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND is_active=1 AND id<>?`).get(exceptId).c;

router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username`).all());
});

// Creates the account with a temporary password that is returned once and has
// to be replaced at first login.
router.post('/', wrap(async (req, res) => {
  const username = v.str(req.body?.username, 'Username', { required: true, max: 50 });
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-50 characters: letters, numbers, dot, dash or underscore');
  }
  const name = v.str(req.body?.name, 'Name', { max: 100 });
  const email = v.email(req.body?.email, 'Email');
  const role = v.oneOf(req.body?.role, 'Role', ROLES, { def: 'staff' });

  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    throw new HttpError(409, 'That username is already taken');
  }
  const tempPassword = auth.generatePassword(14);
  const hash = await auth.hashPassword(tempPassword);
  const result = db.prepare(`
    INSERT INTO users (username, name, email, password_hash, role, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(username, name, email, hash, role);

  auth.audit(req, 'user_created', `username=${username} role=${role}`);
  res.status(201).json({ id: result.lastInsertRowid, username, temporary_password: tempPassword });
}));

router.put('/:id', wrap((req, res) => {
  const id = v.id(req);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'User not found');

  const name = v.str(req.body?.name, 'Name', { max: 100 });
  const email = v.email(req.body?.email, 'Email');
  const role = v.oneOf(req.body?.role, 'Role', ROLES, { def: user.role });
  const isActive = req.body?.is_active === undefined ? user.is_active : v.flag(req.body.is_active);

  const losesAdmin = user.role === 'admin' && user.is_active && (role !== 'admin' || !isActive);
  if (losesAdmin && activeAdminCount(id) === 0) {
    throw new HttpError(400, 'At least one active administrator is required');
  }
  if (id === req.user.id && !isActive) throw new HttpError(400, 'You cannot deactivate your own account');

  db.prepare('UPDATE users SET name=?, email=?, role=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(name, email, role, isActive, id);
  if (!isActive) auth.destroyUserSessions(id);
  auth.audit(req, 'user_updated', `username=${user.username} role=${role} active=${isActive}`);
  res.json({ message: 'User updated' });
}));

// Replaces the password with a new temporary one and signs the user out everywhere.
router.post('/:id/reset-password', wrap(async (req, res) => {
  const id = v.id(req);
  const user = db.prepare('SELECT id, username FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'User not found');

  const tempPassword = auth.generatePassword(14);
  await auth.setPassword(id, tempPassword, { mustChange: true });
  auth.destroyUserSessions(id, id === req.user.id ? req.sessionId : null);
  auth.audit(req, 'password_reset', `username=${user.username}`);
  res.json({ username: user.username, temporary_password: tempPassword });
}));

router.post('/:id/unlock', wrap((req, res) => {
  const id = v.id(req);
  const user = db.prepare('SELECT username FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'User not found');
  db.prepare('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?').run(id);
  auth.clearLoginAttempts(user.username);
  auth.audit(req, 'user_unlocked', `id=${id}`);
  res.json({ message: 'Account unlocked' });
}));

router.delete('/:id', wrap((req, res) => {
  const id = v.id(req);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) throw new HttpError(404, 'User not found');
  if (id === req.user.id) throw new HttpError(400, 'You cannot delete your own account');
  if (user.role === 'admin' && user.is_active && activeAdminCount(id) === 0) {
    throw new HttpError(400, 'At least one active administrator is required');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  auth.audit(req, 'user_deleted', `username=${user.username}`);
  res.json({ message: 'User deleted' });
}));

router.get('/audit-log', (req, res) => {
  res.json(db.prepare(`
    SELECT id, username, action, detail, ip, created_at FROM audit_log
    ORDER BY id DESC LIMIT 200
  `).all());
});

module.exports = router;
