const config = require('../config');

// Unknown /api paths answer with JSON 404. Without this the single-page-app
// fallback would return index.html with status 200 for a mistyped API call.
function apiNotFound(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request is too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: err.message });
  }
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    const message = err.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'That value is already in use'
      : err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
        ? 'This record is still used elsewhere and cannot be changed or removed'
        : 'The data could not be saved because it breaks a database rule';
    return res.status(409).json({ error: message });
  }

  console.error(`[${req.method} ${req.originalUrl}]`, err);
  // Internal details stay in the server log in production.
  res.status(500).json({ error: config.isProd ? 'Something went wrong on the server' : err.message });
}

module.exports = { apiNotFound, errorHandler };
