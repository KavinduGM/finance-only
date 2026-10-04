const { addDays, addMonths, addYears, format, parseISO, isValid } = require('date-fns');
const config = require('../config');

// "Today" in the business timezone, as YYYY-MM-DD. The server usually runs in
// UTC, which would otherwise flip dates around midnight Sri Lanka time.
function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const thisMonth = () => today().slice(0, 7);
const thisYear = () => today().slice(0, 4);
const nowIso = () => new Date().toISOString();

// Calendar-date arithmetic on YYYY-MM-DD strings, independent of server timezone.
function shiftDate(dateStr, { days = 0, months = 0, years = 0 } = {}) {
  let d = parseISO(dateStr);
  if (!isValid(d)) throw new Error(`Invalid date: ${dateStr}`);
  if (years) d = addYears(d, years);
  if (months) d = addMonths(d, months);
  if (days) d = addDays(d, days);
  return format(d, 'yyyy-MM-dd');
}

const BILLING_CYCLES = ['Weekly', 'Monthly', 'Quarterly', 'Semi-Annual', 'Annual'];

function nextCycleDate(dateStr, cycle) {
  switch (cycle) {
    case 'Weekly': return shiftDate(dateStr, { days: 7 });
    case 'Quarterly': return shiftDate(dateStr, { months: 3 });
    case 'Semi-Annual': return shiftDate(dateStr, { months: 6 });
    case 'Annual': return shiftDate(dateStr, { years: 1 });
    default: return shiftDate(dateStr, { months: 1 });
  }
}

// { start, end, label } for a YYYY-MM month.
function monthRange(ym) {
  const start = `${ym}-01`;
  const end = shiftDate(shiftDate(start, { months: 1 }), { days: -1 });
  return { start, end, label: format(parseISO(start), 'MMMM yyyy') };
}

const monthLabel = (ym, pattern = 'MMM yyyy') => format(parseISO(`${ym}-01`), pattern);

module.exports = { today, thisMonth, thisYear, nowIso, shiftDate, nextCycleDate, monthRange, monthLabel, BILLING_CYCLES };
