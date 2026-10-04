const express = require('express');
const router = express.Router();
const { wrap } = require('../lib/http');
const { SUPPORTED_CURRENCIES } = require('../lib/money');
const { baseCurrency } = require('../lib/settings');
const { requireAdmin } = require('../middleware/auth');
const { displayRates, refreshRates, getCachedRatesData } = require('../services/currencyService');

// updated_at is null until live rates have been fetched at least once; until
// then the built-in fallback rates are the ones in use.
const currentRates = () => ({
  base: baseCurrency(),
  updated_at: getCachedRatesData()?.updated_at || null,
  rates: displayRates(),
});

router.get('/rates', wrap((req, res) => {
  res.json({ ...currentRates(), supported: SUPPORTED_CURRENCIES });
}));

// refreshRates never throws for a network problem: it keeps the saved rates
// and reports live = false.
router.post('/refresh', requireAdmin, wrap(async (req, res) => {
  const { live } = await refreshRates();
  res.json({
    ...currentRates(),
    live,
    message: live
      ? 'Exchange rates updated'
      : 'The exchange-rate service could not be reached. The last saved rates are still in use.',
  });
}));

module.exports = router;
