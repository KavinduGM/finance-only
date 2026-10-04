const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./database');
const auth = require('./services/authService');
const { requireAuth, requirePasswordCurrent, requireAdmin } = require('./middleware/auth');
const { securityHeaders, sameOriginOnly } = require('./middleware/security');
const { apiNotFound, errorHandler } = require('./middleware/errors');

auth.ensureInitialAdmin();

const app = express();
app.disable('x-powered-by');
// Behind Dokploy's Traefik proxy: read the real client IP and protocol from X-Forwarded-*.
app.set('trust proxy', config.trustProxy);

app.use(securityHeaders);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Used by the container health check; deliberately reveals nothing.
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

app.use('/api', sameOriginOnly);
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Login and logout are public; everything else in this router checks the session itself.
app.use('/api/auth', require('./routes/auth'));

// From here on, every request needs a signed-in user with a current password.
app.use('/api', requireAuth, requirePasswordCurrent);

app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/revenue', require('./routes/revenue'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/recurring', require('./routes/recurring'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/salaries', require('./routes/salaries'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/currency', require('./routes/currency'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/users', requireAdmin, require('./routes/users'));
app.use('/api/backup', requireAdmin, require('./routes/backup'));

app.use('/api', apiNotFound);

// Receipts and the company logo are private: same session cookie as the API.
app.use('/uploads', requireAuth, express.static(config.uploadsDir, {
  dotfiles: 'deny',
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=300'),
}));
app.use('/uploads', (req, res) => res.status(404).json({ error: 'Not found' }));

// In production Express also serves the built React app on the same port.
if (fs.existsSync(config.frontendDist)) {
  app.use(express.static(config.frontendDist, {
    index: false,
    setHeaders: (res, file) => {
      // Vite fingerprints everything under /assets, so it can be cached forever.
      res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    },
  }));
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`Finance system listening on port ${config.port} (${config.env})`);
  console.log(`Data directory: ${config.dataDir}`);

  const { refreshRates } = require('./services/currencyService');
  refreshRates().catch(() => {});
  require('./services/schedulerService').start();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
