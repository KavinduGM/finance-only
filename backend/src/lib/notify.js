const db = require('../database');

// Adds an entry to the in-app notification bell. Pass a dedupeKey for anything
// a scheduled job may raise repeatedly: a key is only ever raised once, even
// after the notification itself has been read and deleted.
// Returns true when a notification was added.
function notify(type, title, message, { dedupeKey = null, relatedType = null, relatedId = null } = {}) {
  if (dedupeKey) {
    const first = db.prepare('INSERT OR IGNORE INTO notification_keys (key) VALUES (?)').run(dedupeKey).changes;
    if (!first) return false;
  }
  db.prepare(`
    INSERT OR IGNORE INTO notifications (type, title, message, related_type, related_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(type, title, message, relatedType, relatedId, dedupeKey);
  return true;
}

module.exports = { notify };
