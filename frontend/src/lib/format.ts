import { differenceInCalendarDays, format, isValid, parseISO } from 'date-fns'

export const SUPPORTED_CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'INR', 'CAD', 'JPY'] as const

export const CURRENCY_SYMBOLS: Record<string, string> = {
  LKR: 'Rs.', USD: '$', EUR: '€', GBP: '£',
  AUD: 'A$', SGD: 'S$', INR: '₹', CAD: 'C$', JPY: '¥',
}

export const symbolFor = (currency?: string | null) =>
  CURRENCY_SYMBOLS[String(currency || '').toUpperCase()] || currency || ''

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** "Rs. 12,500.00" — always in the currency the amount was recorded in. */
export function formatMoney(amount: unknown, currency: string = 'LKR', decimals = 2) {
  const n = num(amount)
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return `${n < 0 ? '−' : ''}${symbolFor(currency)} ${body}`
}

/** "Rs. 1.25M" — for stat tiles and chart axes where space is tight. */
export function formatCompact(amount: unknown, currency?: string) {
  const n = num(amount)
  const abs = Math.abs(n)
  let body: string
  // Thresholds sit just below each unit so 999,960 reads "1.00M", not "1000.0K".
  if (abs >= 999_995_000) body = `${(abs / 1e9).toFixed(2)}B`
  else if (abs >= 999_950) body = `${(abs / 1e6).toFixed(2)}M`
  else if (abs >= 1e4) body = `${(abs / 1e3).toFixed(1)}K`
  else body = abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
  const sym = currency ? `${symbolFor(currency)} ` : ''
  return `${n < 0 ? '−' : ''}${sym}${body}`
}

export const formatNumber = (v: unknown, decimals = 0) =>
  num(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

export function formatPercent(v: number | null | undefined, decimals = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(decimals)}%`
}

/** "05 Mar 2026". Accepts YYYY-MM-DD or a full timestamp; blank → "—". */
export function formatDate(value?: string | null, pattern = 'dd MMM yyyy') {
  if (!value) return '—'
  // SQLite timestamps are "YYYY-MM-DD HH:MM:SS" in UTC, without a zone marker.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const d = parseISO(iso)
  return isValid(d) ? format(d, pattern) : '—'
}

export const formatDateTime = (value?: string | null) => formatDate(value, 'dd MMM yyyy, HH:mm')

/** "March 2026" from "2026-03". */
export function formatMonth(ym?: string | null, pattern = 'MMMM yyyy') {
  if (!ym) return '—'
  const d = parseISO(`${ym}-01`)
  return isValid(d) ? format(d, pattern) : '—'
}

/** Today in the browser's timezone as YYYY-MM-DD (for date inputs). */
export const todayISO = () => format(new Date(), 'yyyy-MM-dd')
export const thisMonthISO = () => format(new Date(), 'yyyy-MM')
export const thisYear = () => new Date().getFullYear()

export function addDaysISO(dateISO: string, days: number) {
  const d = parseISO(dateISO)
  if (!isValid(d)) return dateISO
  d.setDate(d.getDate() + days)
  return format(d, 'yyyy-MM-dd')
}

/** Whole days from today until the date (negative when it has passed). */
export function daysUntil(dateISO?: string | null) {
  if (!dateISO) return null
  const d = parseISO(dateISO)
  return isValid(d) ? differenceInCalendarDays(d, new Date()) : null
}

/** Message from a failed API call, falling back to something readable. */
export function errorMessage(err: any, fallback = 'Something went wrong') {
  return err?.response?.data?.error || (err?.code === 'ERR_NETWORK' ? 'Cannot reach the server' : fallback)
}
