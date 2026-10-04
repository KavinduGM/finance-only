const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const db = require('../database');
const backups = require('../services/backupService');
const auth = require('../services/authService');
const { wrap, HttpError } = require('../lib/http');

// Mounted behind requireAdmin.

const upload = multer({
  dest: path.join(os.tmpdir(), 'finance-restore'),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

router.get('/', (req, res) => {
  res.json({ backups: backups.listBackups(), keep: config.backupKeep });
});

router.post('/', wrap(async (req, res) => {
  const file = await backups.createBackup('manual');
  auth.audit(req, 'backup_created', path.basename(file));
  res.status(201).json({ name: path.basename(file), message: 'Backup created' });
}));

// Fresh, consistent copy of the live database, streamed straight to the browser.
// Each request gets its own temporary file, so two downloads never share one.
router.get('/download', wrap(async (req, res, next) => {
  const dir = path.join(os.tmpdir(), 'finance-download');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.db`);
  await db.backup(file);
  auth.audit(req, 'backup_downloaded', 'live database');
  res.download(file, `finance-backup-${new Date().toISOString().slice(0, 10)}.db`, (err) => {
    for (const suffix of ['', '-wal', '-shm']) fs.rm(file + suffix, { force: true }, () => {});
    if (err && !res.headersSent) next(err);
  });
}));

router.get('/:name/download', wrap((req, res) => {
  const file = backups.backupPath(req.params.name);
  if (!file) throw new HttpError(404, 'Backup not found');
  auth.audit(req, 'backup_downloaded', req.params.name);
  res.download(file, req.params.name);
}));

router.delete('/:name', wrap((req, res) => {
  if (!backups.deleteBackup(req.params.name)) throw new HttpError(404, 'Backup not found');
  auth.audit(req, 'backup_deleted', req.params.name);
  res.json({ message: 'Backup deleted' });
}));

function restartSoon() {
  if (!config.restartOnRestore) return false;
  // The container's restart policy brings the app back with the restored data.
  // Closing first folds the write-ahead log into the database file, so the
  // "before a restore" copy made at start-up is complete.
  setTimeout(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch { /* exit anyway; start-up copies through SQLite as well */ }
    process.exit(0);
  }, 800).unref();
  return true;
}

// Restore from an uploaded .db file. The current database is copied to
// backups/pre-restore-*.db before it is replaced.
router.post('/restore', upload.single('backup'), wrap((req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a backup file to restore');
  try {
    const problem = backups.validateBackupFile(req.file.path);
    if (problem) throw new HttpError(400, problem);
    backups.stageRestore(req.file.path);
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  auth.audit(req, 'restore_staged', req.file.originalname);
  const restarting = restartSoon();
  res.json({
    restarting,
    message: restarting
      ? 'Backup accepted. The system is restarting with the restored data. Sign in again in a few seconds.'
      : 'Backup accepted. Restart the server to finish the restore.',
  });
}));

// Restore from one of the backups already stored on the server.
router.post('/:name/restore', wrap((req, res) => {
  const file = backups.backupPath(req.params.name);
  if (!file) throw new HttpError(404, 'Backup not found');
  const problem = backups.validateBackupFile(file);
  if (problem) throw new HttpError(400, problem);
  backups.stageRestore(file);
  auth.audit(req, 'restore_staged', req.params.name);
  const restarting = restartSoon();
  res.json({
    restarting,
    message: restarting
      ? 'The system is restarting with the restored data. Sign in again in a few seconds.'
      : 'Restore staged. Restart the server to finish.',
  });
}));

module.exports = router;
