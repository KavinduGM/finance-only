const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');
const { symbolFor, round2, formatMoney } = require('../lib/money');
const { monthLabel } = require('../lib/dates');

// Invoices, proposals and salary slips. Every PDF is built in memory and
// returned as a Buffer; nothing is written to disk.

// ── Page geometry (A4, in points) ────────────────────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 54;
const RIGHT = PAGE_W - 54;
const WIDTH = RIGHT - LEFT;
const TOP = 54;
// Body content never goes below BOTTOM: the strip under it belongs to the footer.
const BOTTOM = PAGE_H - 78;
const FOOTER_RULE_Y = PAGE_H - 62;
const FOOTER_TEXT_Y = PAGE_H - 52;
const RUNNING_HEAD_Y = 30;

const INK = '#0F172A';
const MUTED = '#64748B';
const ACCENT = '#0EA5A4';
const RULE = '#E2E8F0';
const RULE_STRONG = '#CBD5E1';

// Helvetica's ascender as a fraction of the type size (pdfkit places text by its top edge).
const ASCENT = 0.718;
const LOGO_MAX_W = 160;
const LOGO_MAX_H = 52;
const MAX_LOGO_PIXELS = 16e6;

// ── Text the built-in fonts can draw ─────────────────────────────────────────
// Helvetica only covers WinAnsi (Latin-1 plus a few typographic characters).
// pdfkit writes anything else as broken bytes, so such characters are replaced
// before they reach the page.
const WIN_ANSI_EXTRA = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);
const inWinAnsi = (cp) => (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA1 && cp <= 0xFF) || WIN_ANSI_EXTRA.has(cp);

// null/undefined → '', odd spaces and dashes → plain ones, control characters
// dropped, each run of undrawable characters → a single "?". Keeps line breaks.
function clean(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u00AD\u0300-\u036F\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF]/g, '')
    .replace(/[\u2010-\u2012\u2015\u2212]/g, '-');
  let out = '';
  let replaced = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\n' || inWinAnsi(cp)) {
      out += ch;
      replaced = false;
    } else if (cp > 0x9F && !replaced) {
      out += '?';
      replaced = true;
    }
  }
  return out.replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const oneLine = (value) => clean(value).replace(/\s*\n\s*/g, ' ');

// "Rs. 1,200.00" in the document's own currency. A symbol Helvetica cannot draw
// (the rupee sign, for one) gives way to the currency code: "INR 1,200.00".
function pdfMoney(amount, currency) {
  const code = oneLine(currency).toUpperCase() || 'LKR';
  const value = round2(amount);
  const symbol = symbolFor(code);
  if (symbol && [...symbol].every((ch) => inWinAnsi(ch.codePointAt(0)))) return formatMoney(value, code);
  const figure = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '-' : ''}${code} ${figure}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2026-03-05 → "5 Mar 2026". Works on the stored string, so no timezone is involved.
function displayDate(value) {
  const text = oneLine(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!m || !MONTHS[m[2] - 1]) return text;
  return `${Number(m[3])} ${MONTHS[m[2] - 1]} ${m[1]}`;
}

function displayMonth(value) {
  const text = oneLine(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? monthLabel(text, 'MMMM yyyy') : text;
}

const trimNumber = (n) => String(Math.round(Number(n) * 100) / 100);
const companyName = (settings) => oneLine(settings.company_name) || 'GroovyMark';
const currencyOf = (record, settings) => (oneLine(record.currency) || oneLine(settings.currency) || 'LKR').toUpperCase();

// ── Drawing primitives ───────────────────────────────────────────────────────
// Every piece of text is placed as a single line at an explicit position.
// pdfkit's own wrapping adds pages by itself near the bottom margin, which
// would skip the repeated table header and run into the footer.

function setFont(doc, size, { bold = false, color = INK } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
}

// x is the left edge, or the right edge when align is 'right'. Returns the width drawn.
function put(doc, value, x, y, { align = 'left', spacing = 0 } = {}) {
  const text = oneLine(value);
  if (!text) return 0;
  const options = { lineBreak: false, characterSpacing: spacing };
  const width = doc.widthOfString(text, options);
  doc.text(text, align === 'right' ? x - width : x, y, options);
  return width;
}

// One line that has to stay inside maxWidth: the type is reduced first and the
// text is shortened only if that is not enough. Amounts are never shortened.
function putFitted(doc, value, x, y, maxWidth, size, style = {}, options = {}) {
  const { align = 'left', spacing = 0, shorten = true, smallest = Math.max(6, size * 0.6) } = options;
  let text = oneLine(value);
  if (!text) return 0;
  const measure = { characterSpacing: spacing };
  let fitted = size;
  setFont(doc, fitted, style);
  while (fitted > smallest && doc.widthOfString(text, measure) > maxWidth) {
    fitted -= 0.5;
    doc.fontSize(fitted);
  }
  if (shorten && doc.widthOfString(text, measure) > maxWidth) {
    while (text.length > 1 && doc.widthOfString(`${text}...`, measure) > maxWidth) text = text.slice(0, -1);
    text = `${text.trimEnd()}...`;
  }
  // Smaller type is moved down so it keeps the baseline of its neighbours.
  return put(doc, text, x, y + (size - fitted) * ASCENT, { align, spacing });
}

function putLabel(doc, value, x, y, align = 'left') {
  setFont(doc, 7.5, { bold: true, color: MUTED });
  return put(doc, oneLine(value).toUpperCase(), x, y, { align, spacing: 0.9 });
}

function rule(doc, y, { from = LEFT, to = RIGHT, color = RULE, weight = 0.5 } = {}) {
  doc.lineWidth(weight).strokeColor(color).moveTo(from, y).lineTo(to, y).stroke();
}

// Breaks text into lines no wider than `width` in the current font. Line breaks
// in the text are kept; with maxLines the overflow is cut and marked with "...".
function wrapText(doc, value, width, maxLines = Infinity) {
  const text = clean(value);
  if (!text) return [];
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (let word of paragraph.split(' ')) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // A single word wider than the column is cut where it stops fitting.
      while (word.length > 1 && doc.widthOfString(word) > width) {
        let fit = 1;
        while (fit < word.length - 1 && doc.widthOfString(word.slice(0, fit + 1)) <= width) fit += 1;
        lines.push(word.slice(0, fit));
        word = word.slice(fit);
      }
      line = word;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && doc.widthOfString(`${last}...`) > width) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}...`;
  }
  return lines;
}

// ── Page flow ────────────────────────────────────────────────────────────────
// A sheet is { doc, y, pageTop, tableHeader }: y is where the next block starts.

// Starts a new page when `height` no longer fits above the footer. A table in
// progress gets its column headings again. Returns true when a page was added.
function ensureSpace(sheet, height) {
  if (sheet.y + height <= BOTTOM || sheet.y <= sheet.pageTop) return false;
  sheet.doc.addPage();
  sheet.y = TOP;
  if (sheet.tableHeader) sheet.tableHeader();
  sheet.pageTop = sheet.y;
  return true;
}

function drawLines(sheet, lines, x, lineHeight, size, style) {
  for (const line of lines) {
    if (!line) {
      sheet.y += lineHeight / 2;
      continue;
    }
    ensureSpace(sheet, lineHeight);
    setFont(sheet.doc, size, style);
    put(sheet.doc, line, x, sheet.y);
    sheet.y += lineHeight;
  }
}

// ── Logo ─────────────────────────────────────────────────────────────────────

// pdfkit unpacks PNG pixel data in an asynchronous callback and throws inside
// it when the file is damaged, where no try/catch can reach. So the data is
// checked here first.
function imageIsReadable(file) {
  try {
    const data = fs.readFileSync(file);
    if (data[0] === 0xFF && data[1] === 0xD8) return true; // JPEG is read synchronously
    if (data.length < 33 || data.toString('latin1', 1, 4) !== 'PNG') return false;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (!width || !height || width * height > MAX_LOGO_PIXELS) return false;
    const pixelData = [];
    let pos = 8;
    while (pos + 12 <= data.length) {
      const length = data.readUInt32BE(pos);
      const type = data.toString('latin1', pos + 4, pos + 8);
      if (pos + 12 + length > data.length) return false;
      if (type === 'IDAT') pixelData.push(data.subarray(pos + 8, pos + 8 + length));
      if (type === 'IEND') break;
      pos += 12 + length;
    }
    if (!pixelData.length) return false;
    const pixels = zlib.inflateSync(Buffer.concat(pixelData), { maxOutputLength: (width + 1) * height * 8 + 1024 });

    // Every scanline starts with a filter byte from 0 to 4. The PDF library
    // decodes transparent PNGs in an asynchronous callback, where a bad byte
    // throws outside any try/catch and takes the whole server down, so check here.
    const bits = data[24];
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[data[25]];
    if (!channels || ![1, 2, 4, 8, 16].includes(bits)) return false;
    const passes = data[28] === 1
      ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
      : [[0, 0, 1, 1]];
    let at = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const w = Math.ceil((width - x0) / dx);
      const h = Math.ceil((height - y0) / dy);
      if (w <= 0 || h <= 0) continue;
      const rowBytes = Math.ceil((w * channels * bits) / 8);
      for (let row = 0; row < h && at < pixels.length; row += 1) {
        if (pixels[at] > 4) return false;
        at += 1 + rowBytes;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Result of the last check, so an unchanged logo is only inspected once.
let logoCheck = { key: '', ok: false };

// settings.logo_path is "/uploads/logos/<file>"; only the file name is trusted.
function logoFile(settings) {
  const stored = String(settings.logo_path || '').trim();
  if (!stored) return null;
  const file = path.join(config.uploadsDir, 'logos', path.basename(stored));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (logoCheck.key !== key) {
    logoCheck = { key, ok: imageIsReadable(file) };
    if (!logoCheck.ok) {
      console.error(`Logo ${path.basename(file)} is damaged or not a PNG/JPEG; PDFs show the company name instead`);
    }
  }
  return logoCheck.ok ? file : null;
}

// Returns the drawn size, or null when there is no usable logo.
function drawLogo(doc, settings, x, y) {
  const file = logoFile(settings);
  if (!file) return null;
  try {
    const image = doc.openImage(file);
    // Photos carry an EXIF rotation that pdfkit applies when drawing.
    const turned = image.orientation > 4;
    const naturalW = turned ? image.height : image.width;
    const naturalH = turned ? image.width : image.height;
    const scale = Math.min(LOGO_MAX_W / naturalW, LOGO_MAX_H / naturalH);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const size = { width: naturalW * scale, height: naturalH * scale };
    doc.image(image, x, y, size);
    return size;
  } catch (err) {
    console.error(`Logo could not be added to the PDF (${err.message}); using the company name instead`);
    return null;
  }
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function drawStatus(doc, status, rightEdge, y, accent) {
  const label = oneLine(status).toUpperCase();
  if (!label) return;
  const color = accent ? ACCENT : MUTED;
  const height = 16;
  setFont(doc, 7.5, { bold: true, color });
  const boxWidth = doc.widthOfString(label, { characterSpacing: 0.9 }) + 16;
  doc.lineWidth(0.75).strokeColor(color).roundedRect(rightEdge - boxWidth, y, boxWidth, height, height / 2).stroke();
  put(doc, label, rightEdge - 8, y + 5.3, { align: 'right', spacing: 0.9 });
}

// Company on the left, document title / number / status on the right.
function drawHeader(sheet, settings, { title, number, status, accent }) {
  const { doc } = sheet;
  const company = companyName(settings);
  const leftWidth = 250;
  let left = TOP;

  const logo = drawLogo(doc, settings, LEFT, left);
  if (logo) {
    left += logo.height + 12;
    setFont(doc, 10, { bold: true });
    for (const line of wrapText(doc, company, leftWidth, 2)) {
      put(doc, line, LEFT, left);
      left += 13;
    }
  } else {
    // A long legal name gets smaller type rather than being cut short.
    let size = 18;
    setFont(doc, size, { bold: true });
    while (size > 12 && wrapText(doc, company, leftWidth).length > 2) {
      size -= 2;
      doc.fontSize(size);
    }
    for (const line of wrapText(doc, company, leftWidth, 3)) {
      put(doc, line, LEFT, left);
      left += Math.round(size * 1.2);
    }
  }
  left += 3;

  setFont(doc, 8.5, { color: MUTED });
  const taxId = oneLine(settings.company_tax_id);
  const contact = [
    ...wrapText(doc, settings.company_address, leftWidth, 5),
    ...wrapText(doc, [settings.company_email, settings.company_phone].map(oneLine).filter(Boolean).join(' \u00B7 '), leftWidth, 2),
    ...wrapText(doc, oneLine(settings.company_website), leftWidth, 1),
    ...wrapText(doc, taxId ? `Tax ID: ${taxId}` : '', leftWidth, 1),
  ].filter(Boolean);
  for (const line of contact) {
    put(doc, line, LEFT, left);
    left += 12;
  }

  let right = TOP;
  putFitted(doc, title, RIGHT, right, 215, 22, { bold: true, color: ACCENT }, { align: 'right', spacing: 1 });
  right += 30;
  if (oneLine(number)) {
    putFitted(doc, number, RIGHT, right, 215, 11, {}, { align: 'right' });
    right += 19;
  }
  if (oneLine(status)) {
    drawStatus(doc, status, RIGHT, right, accent);
    right += 16;
  }

  sheet.y = Math.max(left, right) + 16;
  rule(doc, sheet.y, { color: ACCENT, weight: 1 });
  sheet.y += 22;
}

// "Billed to" style block on the left, labelled values (dates…) on the right.
function drawDetails(sheet, { label, name, lines = [], meta = [] }) {
  const { doc } = sheet;
  const top = sheet.y;
  const columnWidth = meta.length > 2 ? 98 : 112;
  const partyWidth = WIDTH - meta.length * columnWidth - 16;

  putLabel(doc, label, LEFT, top);
  let y = top + 15;
  setFont(doc, 11, { bold: true });
  for (const line of wrapText(doc, oneLine(name) || '-', partyWidth, 3)) {
    put(doc, line, LEFT, y);
    y += 14.5;
  }
  y += 1.5;
  setFont(doc, 9, { color: MUTED });
  for (const entry of lines) {
    for (const line of wrapText(doc, entry, partyWidth, 6)) {
      if (!line) continue;
      put(doc, line, LEFT, y);
      y += 12.5;
    }
  }

  let lowest = y;
  meta.forEach(([metaLabel, value], i) => {
    const edge = RIGHT - (meta.length - 1 - i) * columnWidth;
    putLabel(doc, metaLabel, edge, top, 'right');
    setFont(doc, 10);
    let metaY = top + 15;
    for (const line of wrapText(doc, oneLine(value) || '-', columnWidth - 12, 3)) {
      put(doc, line, edge, metaY, { align: 'right' });
      metaY += 13;
    }
    lowest = Math.max(lowest, metaY);
  });

  sheet.y = lowest + 22;
}

function drawProposalIntro(sheet, proposal) {
  const { doc } = sheet;
  const title = oneLine(proposal.title);
  const summary = clean(proposal.summary);
  if (!title && !summary) return;
  if (title) {
    setFont(doc, 14, { bold: true });
    drawLines(sheet, wrapText(doc, title, WIDTH, 3), LEFT, 18, 14, { bold: true });
    sheet.y += 4;
  }
  if (summary) {
    setFont(doc, 9.5);
    drawLines(sheet, wrapText(doc, summary, WIDTH), LEFT, 14, 9.5);
  }
  sheet.y += 18;
}

// heads: [[label, x, align]]
function drawColumnHeads(sheet, heads) {
  for (const [label, x, align] of heads) putLabel(sheet.doc, label, x, sheet.y, align);
  sheet.y += 14;
  rule(sheet.doc, sheet.y, { color: RULE_STRONG, weight: 0.75 });
}

const HEADS_HEIGHT = 14;
const ROW_PAD = 8;
const ROW_LINE = 13;
const ROW_SIZE = 9.5;

// Description takes what the three right-aligned number columns leave over.
const COLUMNS = {
  descriptionWidth: WIDTH - 46 - 92 - 100 - 14,
  qtyEdge: RIGHT - 100 - 92,
  qtyWidth: 46,
  priceEdge: RIGHT - 100,
  priceWidth: 82,
  amountEdge: RIGHT,
  amountWidth: 90,
};

function formatQuantity(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
}

function drawItemsTable(sheet, items, currency) {
  const { doc } = sheet;
  const heads = () => drawColumnHeads(sheet, [
    ['Description', LEFT],
    ['Qty', COLUMNS.qtyEdge, 'right'],
    ['Unit price', COLUMNS.priceEdge, 'right'],
    ['Amount', COLUMNS.amountEdge, 'right'],
  ]);
  const fullPage = BOTTOM - TOP - HEADS_HEIGHT;

  setFont(doc, ROW_SIZE);
  const rows = (Array.isArray(items) ? items.filter(Boolean) : []).map((item) => {
    const lines = wrapText(doc, item.description, COLUMNS.descriptionWidth);
    if (!lines.length) lines.push('-');
    const height = ROW_PAD * 2 + lines.length * ROW_LINE;
    // A row moves to the next page as a whole; only a row taller than a page is split.
    return { item, lines, needs: height <= fullPage ? height : ROW_PAD * 2 + ROW_LINE * 3 };
  });

  // The headings are never left alone at the foot of a page.
  ensureSpace(sheet, HEADS_HEIGHT + (rows.length ? rows[0].needs : ROW_PAD * 2 + ROW_LINE));
  heads();
  sheet.tableHeader = heads;

  for (const { item, lines, needs } of rows) {
    ensureSpace(sheet, needs);
    sheet.y += ROW_PAD;

    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unit_price) || 0;
    // Rows from the old system can have no stored amount.
    const amount = Number(item.amount) || round2(quantity * unitPrice);
    putFitted(doc, formatQuantity(item.quantity), COLUMNS.qtyEdge, sheet.y, COLUMNS.qtyWidth, ROW_SIZE, {}, { align: 'right', shorten: false });
    putFitted(doc, pdfMoney(unitPrice, currency), COLUMNS.priceEdge, sheet.y, COLUMNS.priceWidth, ROW_SIZE, {}, { align: 'right', shorten: false });
    putFitted(doc, pdfMoney(amount, currency), COLUMNS.amountEdge, sheet.y, COLUMNS.amountWidth, ROW_SIZE, {}, { align: 'right', shorten: false });

    for (const line of lines) {
      if (ensureSpace(sheet, ROW_LINE + ROW_PAD)) sheet.y += ROW_PAD;
      if (line) {
        setFont(doc, ROW_SIZE);
        put(doc, line, LEFT, sheet.y);
      }
      sheet.y += ROW_LINE;
    }
    sheet.y += ROW_PAD;
    rule(doc, sheet.y);
  }

  if (!rows.length) {
    sheet.y += ROW_PAD;
    setFont(doc, ROW_SIZE, { color: MUTED });
    put(doc, 'No line items', LEFT, sheet.y);
    sheet.y += ROW_LINE + ROW_PAD;
    rule(doc, sheet.y);
  }
  sheet.tableHeader = null;
}

// Label / amount rows for the salary slip.
function drawAmountTable(sheet, heading, rows, currency) {
  const { doc } = sheet;
  ensureSpace(sheet, HEADS_HEIGHT + rows.length * (ROW_PAD * 2 + ROW_LINE));
  drawColumnHeads(sheet, [[heading, LEFT], ['Amount', RIGHT, 'right']]);
  for (const [label, amount] of rows) {
    sheet.y += ROW_PAD;
    putFitted(doc, label, LEFT, sheet.y, WIDTH - 180, ROW_SIZE);
    putFitted(doc, pdfMoney(amount, currency), RIGHT, sheet.y, 160, ROW_SIZE, {}, { align: 'right', shorten: false });
    sheet.y += ROW_LINE + ROW_PAD;
    rule(doc, sheet.y);
  }
  sheet.y += 20;
}

// Right-aligned summary: plain rows, a rule, then the highlighted total. Never split across pages.
function drawTotals(sheet, rows, totalLabel, totalValue) {
  const { doc } = sheet;
  const blockWidth = 236;
  const x = RIGHT - blockWidth;
  const rowHeight = 18;
  ensureSpace(sheet, 10 + rows.length * rowHeight + 12 + 30);

  sheet.y += 10;
  for (const [label, value] of rows) {
    setFont(doc, ROW_SIZE, { color: MUTED });
    const labelWidth = put(doc, label, x, sheet.y);
    putFitted(doc, value, RIGHT, sheet.y, blockWidth - labelWidth - 12, ROW_SIZE, {}, { align: 'right', shorten: false });
    sheet.y += rowHeight;
  }
  if (rows.length) {
    sheet.y += 2;
    rule(doc, sheet.y, { from: x, color: RULE_STRONG, weight: 0.75 });
    sheet.y += 10;
  }
  setFont(doc, 8, { bold: true, color: MUTED });
  const labelWidth = put(doc, oneLine(totalLabel).toUpperCase(), x, sheet.y + (14 - 8) * ASCENT, { spacing: 0.9 });
  putFitted(doc, totalValue, RIGHT, sheet.y, blockWidth - labelWidth - 12, 14, { bold: true, color: ACCENT }, { align: 'right', shorten: false });
  sheet.y += 34;
}

function documentTotalRows(record, currency) {
  const rows = [['Subtotal', pdfMoney(record.subtotal, currency)]];
  const discount = round2(record.discount);
  if (discount > 0) rows.push(['Discount', pdfMoney(-discount, currency)]);
  const rate = Number(record.tax_rate) || 0;
  const tax = round2(record.tax_amount);
  if (rate > 0 || tax > 0) rows.push([rate > 0 ? `Tax (${trimNumber(rate)}%)` : 'Tax', pdfMoney(tax, currency)]);
  return rows;
}

// Small-caps label followed by a paragraph that may run over several pages.
function drawSection(sheet, label, value, { color = INK, size = 9, lineHeight = 13 } = {}) {
  const { doc } = sheet;
  setFont(doc, size, { color });
  const lines = wrapText(doc, value, WIDTH);
  if (!lines.length) return;
  // The label stays with at least the first two lines.
  ensureSpace(sheet, 14 + Math.min(lines.length, 2) * lineHeight);
  putLabel(doc, label, LEFT, sheet.y);
  sheet.y += 14;
  drawLines(sheet, lines, LEFT, lineHeight, size, { color });
  sheet.y += 16;
}

// Bank details for invoices. Left out completely when nothing is filled in.
function drawPaymentDetails(sheet, settings) {
  const { doc } = sheet;
  const pairs = [
    ['Bank', settings.bank_name],
    ['Account name', settings.bank_account_name],
    ['Account number', settings.bank_account_no],
    ['Branch', settings.bank_branch],
    ['SWIFT / BIC', settings.bank_swift],
  ].map(([key, value]) => [key, oneLine(value)]).filter(([, value]) => value);
  setFont(doc, 9);
  const instructions = wrapText(doc, settings.payment_instructions, WIDTH);
  if (!pairs.length && !instructions.length) return;

  const keyWidth = 96;
  ensureSpace(sheet, 14 + 13 * 2);
  putLabel(doc, 'Payment details', LEFT, sheet.y);
  sheet.y += 14;
  for (const [key, value] of pairs) {
    setFont(doc, 9);
    const lines = wrapText(doc, value, WIDTH - keyWidth);
    ensureSpace(sheet, 13);
    setFont(doc, 9, { color: MUTED });
    put(doc, key, LEFT, sheet.y);
    drawLines(sheet, lines, LEFT + keyWidth, 13, 9);
  }
  if (instructions.length) {
    if (pairs.length) sheet.y += 5;
    drawLines(sheet, instructions, LEFT, 13, 9);
  }
  sheet.y += 16;
}

// Signature, name and date lines for the client. Kept together on one page.
function drawAcceptance(sheet) {
  const { doc } = sheet;
  ensureSpace(sheet, 100);
  putLabel(doc, 'Acceptance', LEFT, sheet.y);
  sheet.y += 14;
  setFont(doc, 9);
  put(doc, 'By signing below, the client accepts this proposal and its terms.', LEFT, sheet.y);
  sheet.y += 13 + 38;

  const gap = 18;
  const usable = WIDTH - gap * 2;
  let x = LEFT;
  for (const [label, share] of [['Signature', 0.42], ['Name', 0.34], ['Date', 0.24]]) {
    const width = usable * share;
    rule(doc, sheet.y, { from: x, to: x + width, color: MUTED, weight: 0.75 });
    putLabel(doc, label, x, sheet.y + 6);
    x += width + gap;
  }
  sheet.y += 24;
}

// Stamped last, once the page count is known: company line and "Page X of Y"
// on every page, the document name at the top of continuation pages.
function stampFooters(doc, settings, { running = '', note = '' } = {}) {
  const contact = [companyName(settings), settings.company_email, settings.company_phone, settings.company_website]
    .map(oneLine).filter(Boolean).join('  \u00B7  ');
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    rule(doc, FOOTER_RULE_Y);
    setFont(doc, 8, { color: MUTED });
    const pageWidth = put(doc, `Page ${i + 1} of ${range.count}`, RIGHT, FOOTER_TEXT_Y, { align: 'right' });
    putFitted(doc, contact, LEFT, FOOTER_TEXT_Y, WIDTH - pageWidth - 16, 8, { color: MUTED }, { smallest: 7 });
    if (note) putFitted(doc, note, LEFT, FOOTER_TEXT_Y + 13, WIDTH, 7.5, { color: MUTED }, { smallest: 7 });
    if (i > 0 && running) putFitted(doc, running, LEFT, RUNNING_HEAD_Y, WIDTH, 8, { color: MUTED }, { smallest: 7 });
  }
}

// Runs `build` against a fresh A4 document and resolves with the finished PDF.
// `build` returns the footer options ({ running, note }).
function render(info, settings, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: TOP, bottom: PAGE_H - BOTTOM, left: LEFT, right: PAGE_W - RIGHT },
      bufferPages: true,
      info,
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const sheet = { doc, y: TOP, pageTop: TOP, tableHeader: null };
      const footer = build(sheet) || {};
      stampFooters(doc, settings, footer);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Documents ────────────────────────────────────────────────────────────────

// `invoice` is the invoices row plus `items`.
async function generateInvoicePDF(invoice, settings) {
  const s = settings || {};
  const number = oneLine(invoice.invoice_number);
  const currency = currencyOf(invoice, s);
  const paid = invoice.status === 'Paid';

  return render({ Title: `Invoice ${number}`, Author: companyName(s) }, s, (sheet) => {
    drawHeader(sheet, s, { title: 'INVOICE', number, status: invoice.status, accent: paid });

    const meta = [['Issue date', displayDate(invoice.issue_date)], ['Due date', displayDate(invoice.due_date)]];
    if (paid && invoice.paid_date) meta.push(['Paid on', displayDate(invoice.paid_date)]);
    drawDetails(sheet, {
      label: 'Billed to',
      name: invoice.client_name,
      lines: [invoice.client_company, invoice.client_email, invoice.client_address],
      meta,
    });

    drawItemsTable(sheet, invoice.items, currency);
    drawTotals(sheet, documentTotalRows(invoice, currency), `Total (${currency})`, pdfMoney(invoice.total, currency));
    drawPaymentDetails(sheet, s);
    drawSection(sheet, 'Notes', invoice.notes);
    drawSection(sheet, 'Terms', invoice.terms, { color: MUTED, size: 8.5, lineHeight: 12 });
    return { running: `Invoice ${number}` };
  });
}

// `proposal` is the proposals row plus `items`.
async function generateProposalPDF(proposal, settings) {
  const s = settings || {};
  const number = oneLine(proposal.proposal_number);
  const currency = currencyOf(proposal, s);

  return render({ Title: `Proposal ${number}`, Author: companyName(s) }, s, (sheet) => {
    drawHeader(sheet, s, { title: 'PROPOSAL', number, status: proposal.status, accent: proposal.status === 'Accepted' });
    drawDetails(sheet, {
      label: 'Prepared for',
      name: proposal.client_name,
      lines: [proposal.client_company, proposal.client_email, proposal.client_address],
      meta: [['Issue date', displayDate(proposal.issue_date)], ['Valid until', displayDate(proposal.valid_until)]],
    });
    drawProposalIntro(sheet, proposal);

    drawItemsTable(sheet, proposal.items, currency);
    drawTotals(sheet, documentTotalRows(proposal, currency), `Total (${currency})`, pdfMoney(proposal.total, currency));
    drawSection(sheet, 'Notes', proposal.notes);
    drawSection(sheet, 'Terms', proposal.terms, { color: MUTED, size: 8.5, lineHeight: 12 });
    drawAcceptance(sheet);
    return { running: `Proposal ${number}` };
  });
}

// `salary` is a salary_payments row.
async function generateSalarySlipPDF(salary, settings) {
  const s = settings || {};
  const currency = currencyOf(salary, s);
  const period = displayMonth(salary.payment_month);
  const paid = salary.status === 'Paid';
  const type = oneLine(salary.salary_type);

  const base = round2(salary.base_salary);
  const bonuses = round2(salary.bonuses);
  const deductions = round2(salary.deductions);
  const net = salary.net_salary === null || salary.net_salary === undefined
    ? round2(base + bonuses - deductions)
    : round2(salary.net_salary);

  return render({ Title: `Salary slip ${period}`.trim(), Author: companyName(s) }, s, (sheet) => {
    drawHeader(sheet, s, { title: 'SALARY SLIP', number: period, status: salary.status || 'Pending', accent: paid });
    drawDetails(sheet, {
      label: 'Payee',
      name: salary.employee_name,
      lines: [salary.position, salary.department],
      meta: [
        ['Pay period', period],
        ['Payment date', salary.payment_date ? displayDate(salary.payment_date) : (paid ? '-' : 'Not yet paid')],
        ['Payment method', salary.payment_method],
      ],
    });

    drawAmountTable(sheet, 'Earnings', [
      [!type || type === 'Monthly' ? 'Basic salary' : `Basic pay (${type})`, base],
      ['Bonuses', bonuses],
    ], currency);
    drawAmountTable(sheet, 'Deductions', [['Deductions', -deductions]], currency);
    drawTotals(sheet, [], `Net pay (${currency})`, pdfMoney(net, currency));
    drawSection(sheet, 'Notes', salary.notes);
    return {
      running: `Salary slip ${period}`.trim(),
      note: 'This is a computer-generated salary slip and does not require a signature.',
    };
  });
}

module.exports = { generateInvoicePDF, generateProposalPDF, generateSalarySlipPDF };
