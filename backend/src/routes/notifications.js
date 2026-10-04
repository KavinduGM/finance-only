const express = require('express');
const router = express.Router();
const db = require('../database');
const { wrap, HttpError, v } = require('../lib/http');

// dedupe_key is internal bookkeeping for scheduled jobs and is not sent to the browser.
const COLUMNS = 'id, type, title, message, is_read, related_id, related_type, created_at';

router.get('/', wrap((req, res) => {
  res.json(db.prepare(`SELECT ${COLUMNS} FROM notifications ORDER BY id DESC LIMIT 50`).all());
}));

// Counts every unread notification, not only the 50 the list shows.
router.get('/unread-count', wrap((req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE COALESCE(is_read, 0) = 0').get();
  res.json({ count });
}));

router.put('/read-all', wrap((req, res) => {
  const result = db.prepare('UPDATE notifications SET is_read=1 WHERE COALESCE(is_read, 0) = 0').run();
  res.json({ message: 'All notifications marked as read', count: result.changes });
}));

router.put('/:id/read', wrap((req, res) => {
  const result = db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(v.id(req));
  if (!result.changes) throw new HttpError(404, 'Notification not found');
  res.json({ message: 'Notification marked as read' });
}));

// Clears the notifications that have been read; unread ones are kept.
router.delete('/', wrap((req, res) => {
  const result = db.prepare('DELETE FROM notifications WHERE is_read=1').run();
  res.json({ count: result.changes });
}));

router.delete('/:id', wrap((req, res) => {
  const result = db.prepare('DELETE FROM notifications WHERE id=?').run(v.id(req));
  if (!result.changes) throw new HttpError(404, 'Notification not found');
  res.json({ message: 'Notification deleted' });
}));

module.exports = router;
