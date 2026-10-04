const db = require('../database');
const { SUPPORTED_CURRENCIES } = require('../lib/money');
const { baseCurrency } = require('../lib/settings');

// Used until live rates have been fetched at least once (rates are per 1 USD).
const FALLBACK_RATES = {
  USD: 1, LKR: 299.5, EUR: 0.92, GBP: 0.79,
  AUD: 1.53, SGD: 1.34, INR: 83.45, CAD: 1.36, JPY: 149.8,
};

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Two free, key-less providers; the second is tried only if the first fails.
async function fetchRatesFromAPI() {
  try {
    const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
    if (data.result === 'success' && data.rates?.USD) return data.rates;
    throw new Error('Unexpected response');
  } catch (first) {
    try {
      const data = await fetchJson('https://api.exchangerate-api.com/v4/latest/USD');
      if (data.rates?.USD) return data.rates;
    } catch { /* fall through to the first error */ }
    throw first;
  }
}

async function refreshRates() {
  try {
    const all = await fetchRatesFromAPI();
    // Keep only the currencies the system supports.
    const rates = {};
    for (const c of SUPPORTED_CURRENCIES) if (Number(all[c]) > 0) rates[c] = Number(all[c]);
    db.prepare('UPDATE exchange_rates SET rates_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(JSON.stringify(rates));
    return { rates, live: true };
  } catch (err) {
    console.warn(`Exchange-rate refresh failed (${err.message}); using the last saved rates`);
    return { rates: getRates(), live: false };
  }
}

function getCachedRatesData() {
  try {
    const row = db.prepare('SELECT rates_json, updated_at FROM exchange_rates WHERE id=1').get();
    if (!row?.rates_json) return null;
    return { rates: JSON.parse(row.rates_json), updated_at: row.updated_at };
  } catch {
    return null;
  }
}

function getRates() {
  const cached = getCachedRatesData();
  return { ...FALLBACK_RATES, ...(cached?.rates || {}) };
}

// Converts between any two supported currencies via USD.
function convert(amount, from, to, rates = getRates()) {
  const amt = Number(amount) || 0;
  const f = String(from || to).toUpperCase();
  const t = String(to).toUpperCase();
  if (amt === 0 || f === t) return amt;
  const fromRate = rates[f];
  const toRate = rates[t];
  // An unknown currency cannot be converted; count it at face value rather than drop it.
  if (!fromRate || !toRate) return amt;
  return amt * (toRate / fromRate);
}

// A converter bound to the company's base currency and one snapshot of rates,
// so every figure in a single report uses the same rates.
function baseConverter() {
  const base = baseCurrency();
  const rates = getRates();
  const toBase = (amount, currency) => convert(amount, currency || base, base, rates);
  const sum = (rows, amountField = 'amount', currencyField = 'currency') =>
    rows.reduce((s, r) => s + toBase(r[amountField], r[currencyField]), 0);
  return { base, rates, toBase, sum };
}

// 1 unit of each supported currency expressed in the base currency.
function displayRates() {
  const { base, rates } = baseConverter();
  return SUPPORTED_CURRENCIES.filter((c) => c !== base).map((c) => ({
    currency: c,
    rate: Number(convert(1, c, base, rates).toFixed(4)),
  }));
}

module.exports = { refreshRates, getCachedRatesData, getRates, convert, baseConverter, displayRates, FALLBACK_RATES };
