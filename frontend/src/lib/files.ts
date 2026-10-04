export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

// Spreadsheet apps run cells that start with = + - @ as formulas; a leading
// apostrophe makes them plain text.
function csvCell(v: string | number | null | undefined) {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]) {
  const lines = [
    columns.map((c) => csvCell(c.header)).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(',')),
  ]
  // BOM so Excel reads UTF-8 (currency symbols, names) correctly.
  downloadBlob(new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), filename)
}

/** Opens a server-generated PDF in a new tab. The session cookie authenticates it. */
export function openPdf(path: string) {
  window.open(`${path}${path.includes('?') ? '&' : '?'}inline=1`, '_blank', 'noopener')
}

/** Saves a server-generated file (PDF, backup) through a plain link. */
export function downloadUrl(path: string) {
  const a = document.createElement('a')
  a.href = path
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
