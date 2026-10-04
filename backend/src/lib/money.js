const SUPPORTED_CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'INR', 'CAD', 'JPY'];

const CURRENCY_SYMBOLS = {
  LKR: 'Rs.', USD: '$', EUR: '€', GBP: '£',
  AUD: 'A$', SGD: 'S$', INR: '₹', CAD: 'C$', JPY: '¥',
};

const symbolFor = (currency) => CURRENCY_SYMBOLS[String(currency || '').toUpperCase()] || currency || '';

// Money is stored as REAL; round at every write so 0.1 + 0.2 never leaks into totals.
const round2 = (n) => {
  const x = Number(n) || 0;
  // The tiny nudge makes half-cent values such as 1.005 round up as expected.
  return Math.round(x * (1 + Number.EPSILON) * 100) / 100;
};

function formatMoney(amount, currency = 'LKR') {
  const n = Number(amount) || 0;
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbolFor(currency)} ${body}`;
}

// Shared by invoices and proposals. `items` = [{ description, quantity, unit_price }].
// Returns cleaned line items plus totals; throws a plain Error with a user-facing message.
// `stored: true` is for lines re-read from the database (duplicate, convert): an
// old row with a 3-decimal price is rounded instead of being refused.
function computeDocumentTotals(items, taxRate, discount, { stored = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Add at least one line item');
  }
  if (items.length > 200) throw new Error('A document can have at most 200 line items');
  const numeric = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN);
  const lines = items.map((it, i) => {
    const n = i + 1;
    if (it === null || typeof it !== 'object') throw new Error(`Line ${n} is not valid`);
    const raw = it.description;
    const description = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    const quantity = numeric(it.quantity);
    const unitPrice = numeric(it.unit_price);
    if (!description) throw new Error(`Line ${n}: description is required`);
    if (description.length > 1000) throw new Error(`Line ${n}: description must be 1000 characters or fewer`);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Line ${n}: quantity must be greater than 0`);
    if (quantity > 1e9) throw new Error(`Line ${n}: quantity is too large`);
    if (!Number.isFinite(unitPrice)) throw new Error(`Line ${n}: unit price must be a number`);
    if (unitPrice < 0) throw new Error(`Line ${n}: unit price cannot be negative`);
    if (unitPrice > 1e12) throw new Error(`Line ${n}: unit price is too large`);
    // Multiply the rounded price, so re-saving a document never moves its total by a cent.
    const price = round2(unitPrice);
    // Rounding 0.035 to 0.04 would quietly change what the client is charged.
    if (!stored && Math.abs(unitPrice - price) > 1e-9) {
      throw new Error(`Line ${n}: unit price can have at most 2 decimal places`);
    }
    return { description, quantity, unit_price: price, amount: round2(quantity * price) };
  });
  const rate = Number(taxRate) || 0;
  const disc = round2(discount);
  if (rate < 0 || rate > 100) throw new Error('Tax rate must be between 0 and 100');
  if (disc < 0) throw new Error('Discount cannot be negative');
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (disc > subtotal) throw new Error('Discount cannot be larger than the subtotal');
  // Discount comes off before tax, so tax is charged on what the client actually pays for.
  const taxAmount = round2(((subtotal - disc) * rate) / 100);
  const total = round2(subtotal - disc + taxAmount);
  if (!Number.isFinite(total) || subtotal > 1e12) throw new Error('The document total is too large');
  return { lines, subtotal, tax_rate: rate, tax_amount: taxAmount, discount: disc, total };
}

module.exports = { SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS, symbolFor, round2, formatMoney, computeDocumentTotals };
