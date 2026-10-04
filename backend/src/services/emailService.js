const nodemailer = require('nodemailer');
const config = require('../config');
const { formatMoney, round2 } = require('../lib/money');
const { today, monthLabel } = require('../lib/dates');

// Outgoing email. `settings` is always the object from getSettings(). Every
// send* function rejects with a readable reason when the message cannot be
// sent; callers decide how to report it.

const ACCENT = '#0EA5A4';
const INK = '#0F172A';
const BODY = '#334155';
const MUTED = '#64748B';
const RULE = '#E2E8F0';
const PAGE = '#F1F5F9';
const FONT = "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;";

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';
const text = (value) => (isBlank(value) ? '' : String(value).trim());
const looksLikeEmail = (value) => EMAIL_RE.test(text(value));
// Subjects and display names must stay on one line.
const headerText = (value) => text(value).replace(/\s+/g, ' ');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Escaped first, then line breaks become <br>.
const multiline = (value) => escapeHtml(text(value)).replace(/\r\n|\r|\n/g, '<br>');

const companyName = (settings) => headerText(settings.company_name) || 'GroovyMark';
const safeFileName = (value) => text(value).replace(/[^A-Za-z0-9._-]/g, '_') || 'document';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2026-03-05 → "5 Mar 2026". Works on the stored string, so no timezone is involved.
function displayDate(value) {
  const stored = text(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stored);
  if (!m || !MONTHS[m[2] - 1]) return stored;
  return `${Number(m[3])} ${MONTHS[m[2] - 1]} ${m[1]}`;
}

function displayMonth(value) {
  const stored = text(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(stored) ? monthLabel(stored, 'MMMM yyyy') : stored;
}

// Amounts are shown in the record's own currency, never the base currency.
function money(amount, record, settings) {
  const currency = (text(record.currency) || text(settings.currency) || 'LKR').toUpperCase();
  return formatMoney(round2(amount), currency);
}

// ── Transport ────────────────────────────────────────────────────────────────

// Two ways to send: Resend (API key in the environment) or an SMTP mailbox
// (Settings → Email). Resend wins when both are set up.

const smtpConfigured = (settings) =>
  !!settings && !isBlank(settings.smtp_host) && !isBlank(settings.smtp_user) && !isBlank(settings.smtp_pass);

// EMAIL_FROM may be "Name <address>" or a bare address.
function parseFrom(value) {
  const raw = headerText(value);
  const m = /^(.*)<([^<>]+)>$/.exec(raw);
  const address = text(m ? m[2] : raw);
  const name = m ? text(m[1]).replace(/^"|"$/g, '').trim() : '';
  return looksLikeEmail(address) ? { name, address } : null;
}

// The Resend sender: EMAIL_FROM, else the company email. The address must be
// on a domain verified in the Resend account.
function resendSender(settings) {
  const from = parseFrom(config.resend.from) || parseFrom(settings && settings.company_email);
  if (!from) return null;
  return { name: from.name || headerText(settings.smtp_from_name) || companyName(settings), address: from.address };
}

// 'resend' | 'smtp' | null
function emailProvider(settings) {
  if (config.emailDisabled) return null;
  if (config.resend.apiKey && resendSender(settings || {})) return 'resend';
  if (smtpConfigured(settings)) return 'smtp';
  return null;
}

function isEmailConfigured(settings) {
  return emailProvider(settings) !== null;
}

// Safe to show in the browser: which provider is active and the sender address. Never the key.
function emailStatus(settings) {
  const provider = emailProvider(settings);
  let from = '';
  if (provider === 'resend') from = resendSender(settings).address;
  if (provider === 'smtp') from = senderAddress(settings);
  return {
    configured: provider !== null,
    provider,
    from,
    // The key is present but no usable sender address was found.
    resend_missing_sender: !config.emailDisabled && !!config.resend.apiKey && !resendSender(settings || {}),
    // EMAIL_DISABLED is set on the server: nothing is sent, whatever else is configured.
    disabled: config.emailDisabled,
  };
}

function smtpPort(settings) {
  const port = Number(settings.smtp_port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 465;
}

function getTransporter(settings) {
  if (!smtpConfigured(settings)) {
    throw new Error('Email is not configured. Add the mail server details in Settings.');
  }
  const port = smtpPort(settings);
  // 465 is TLS from the first byte; every other port must upgrade with STARTTLS
  // before the password is sent. Certificates are always verified.
  const secure = port === 465;
  return nodemailer.createTransport({
    host: text(settings.smtp_host),
    port,
    secure,
    requireTLS: !secure,
    auth: { user: text(settings.smtp_user), pass: String(settings.smtp_pass) },
    // A wrong host or a blocked port must not keep a request hanging.
    dnsTimeout: 10000,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

// The mail username when it is an address, otherwise the company email ('' when neither is usable).
function senderAddress(settings) {
  const address = looksLikeEmail(settings.smtp_user) ? text(settings.smtp_user) : text(settings.company_email);
  return looksLikeEmail(address) ? address : '';
}

function sender(settings) {
  const address = senderAddress(settings);
  if (!address) {
    throw new Error('No sender address. The mail username is not an email address, so add a company email in Settings.');
  }
  return { name: headerText(settings.smtp_from_name) || companyName(settings), address };
}

// One address, or several separated by commas or semicolons.
function recipients(value) {
  const list = text(value).split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (!list.length) throw new Error('No recipient email address');
  const invalid = list.find((address) => !EMAIL_RE.test(address));
  if (invalid) throw new Error(`"${invalid.slice(0, 80)}" is not a valid email address`);
  return list;
}

// Puts a plain-English reason in front of the mail library's own message.
function describeFailure(err, settings) {
  const server = `${text(settings.smtp_host)}:${smtpPort(settings)}`;
  const reasons = {
    EAUTH: 'The mail server rejected the username or password',
    EDNS: `The mail server ${text(settings.smtp_host)} could not be found`,
    ECONNECTION: `Could not connect to the mail server at ${server}`,
    ETIMEDOUT: `The mail server at ${server} did not respond in time`,
    ESOCKET: `The connection to the mail server at ${server} failed`,
    ETLS: `A secure connection to the mail server at ${server} could not be set up`,
    EENVELOPE: 'The mail server did not accept the sender or recipient address',
  };
  const detail = headerText(err && err.message) || 'Unknown error';
  const reason = reasons[err && err.code];
  const failure = new Error(reason ? `${reason} (${detail})` : detail, { cause: err });
  if (err && err.code) failure.code = err.code;
  return failure;
}

// ── Message layout ───────────────────────────────────────────────────────────

// `intro` is a string or a list of strings; blank lines separate paragraphs.
function paragraphsOf(intro) {
  return [].concat(intro || [])
    .flatMap((part) => text(part).split(/\n\s*\n/))
    .map((part) => part.trim())
    .filter(Boolean);
}

const shownRows = (rows) => (rows || []).filter((row) => Array.isArray(row) && !isBlank(row[1]));

function addressLine(settings) {
  return text(settings.company_address).split(/\r\n|\r|\n/)
    .map((line) => line.trim().replace(/,+$/, ''))
    .filter(Boolean)
    .join(', ');
}

// The one HTML shell every message uses: a 600px white card on a pale page,
// built from tables with inline styles only so Outlook and Gmail render it the
// same way. heading, intro, rows and highlight are plain text and are escaped
// here; bodyHtml is inserted as given and must already be escaped.
function layout({ heading, intro, rows = [], highlight = null, bodyHtml = '', settings = {} }) {
  const company = companyName(settings);

  const introHtml = paragraphsOf(intro)
    .map((part, i) => `<p style="margin:${i ? 12 : 0}px 0 0 0;${FONT}font-size:15px;line-height:24px;color:${BODY};">${multiline(part)}</p>`)
    .join('\n');

  const rowsHtml = shownRows(rows)
    .map(([label, value]) => `<tr>
<td valign="top" align="left" style="padding:10px 16px 10px 0;border-bottom:1px solid ${RULE};${FONT}font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(label)}</td>
<td valign="top" align="right" style="padding:10px 0 10px 0;border-bottom:1px solid ${RULE};${FONT}font-size:14px;line-height:20px;color:${INK};">${multiline(value)}</td>
</tr>`)
    .join('\n');

  const highlightHtml = Array.isArray(highlight) && !isBlank(highlight[1])
    ? `<tr>
<td valign="middle" align="left" style="padding:16px 16px 0 0;${FONT}font-size:13px;line-height:20px;font-weight:bold;color:${INK};">${escapeHtml(highlight[0])}</td>
<td valign="middle" align="right" style="padding:16px 0 0 0;${FONT}font-size:22px;line-height:28px;font-weight:bold;color:${ACCENT};">${escapeHtml(highlight[1])}</td>
</tr>`
    : '';

  const detailsHtml = rowsHtml || highlightHtml
    ? `<tr>
<td align="left" style="padding:24px 36px 0 36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};">
${rowsHtml}
${highlightHtml}
</table>
</td>
</tr>`
    : '';

  const contact = [settings.company_email, settings.company_phone, settings.company_website]
    .filter((value) => !isBlank(value))
    .map((value) => escapeHtml(text(value)))
    .join(' &nbsp;&middot;&nbsp; ');
  const address = escapeHtml(addressLine(settings));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};">
<tr>
<td align="center" style="padding:32px 12px 32px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:600px;background-color:#FFFFFF;border:1px solid ${RULE};">
<tr>
<td height="4" bgcolor="${ACCENT}" style="height:4px;line-height:4px;font-size:4px;background-color:${ACCENT};">&nbsp;</td>
</tr>
<tr>
<td align="left" style="padding:32px 36px 0 36px;">
<p style="margin:0;${FONT}font-size:12px;line-height:16px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;color:${MUTED};">${escapeHtml(company)}</p>
<h1 style="margin:10px 0 0 0;${FONT}font-size:22px;line-height:30px;font-weight:bold;color:${INK};">${escapeHtml(heading)}</h1>
</td>
</tr>
${introHtml ? `<tr>
<td align="left" style="padding:18px 36px 0 36px;">
${introHtml}
</td>
</tr>` : ''}
${detailsHtml}
${bodyHtml ? `<tr>
<td align="left" style="padding:8px 36px 0 36px;">
${bodyHtml}
</td>
</tr>` : ''}
<tr>
<td align="left" style="padding:32px 36px 32px 36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="left" style="padding:18px 0 0 0;border-top:1px solid ${RULE};${FONT}font-size:12px;line-height:18px;color:${MUTED};">
<strong style="color:${INK};">${escapeHtml(company)}</strong>${contact ? `<br>${contact}` : ''}${address ? `<br>${address}` : ''}
</td>
</tr>
</table>
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>`;
}

function sectionHtml(title, body) {
  return `<p style="margin:20px 0 6px 0;${FONT}font-size:11px;line-height:16px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;color:${MUTED};">${escapeHtml(title)}</p>
<p style="margin:0;${FONT}font-size:14px;line-height:22px;color:${BODY};">${multiline(body)}</p>`;
}

function closingHtml(closing) {
  return `<p style="margin:24px 0 0 0;${FONT}font-size:14px;line-height:22px;color:${BODY};">${multiline(closing)}</p>`;
}

// The same message for mail programs that do not show HTML.
function plainText({ heading, intro, rows, highlight, sections, closing, settings }) {
  const out = [text(heading), ''];
  const paragraphs = paragraphsOf(intro);
  if (paragraphs.length) out.push(paragraphs.join('\n\n'), '');

  const details = shownRows(rows).map(([label, value]) => `${label}: ${headerText(value)}`);
  if (Array.isArray(highlight) && !isBlank(highlight[1])) details.push(`${highlight[0]}: ${highlight[1]}`);
  if (details.length) out.push(...details, '');

  for (const [title, body] of sections) out.push(`${title}:`, text(body), '');
  if (closing) out.push(closing, '');

  out.push('-- ', companyName(settings));
  const contact = [settings.company_email, settings.company_phone, settings.company_website].map(text).filter(Boolean);
  if (contact.length) out.push(contact.join(' | '));
  const address = addressLine(settings);
  if (address) out.push(address);
  return out.join('\n');
}

// message: { heading, intro, rows, highlight, sections: [[title, text]], closing } — all plain text.
function compose(message, settings) {
  const sections = (message.sections || []).filter((section) => Array.isArray(section) && !isBlank(section[1]));
  const closing = text(message.closing);
  const bodyHtml = [
    ...sections.map(([title, body]) => sectionHtml(title, body)),
    closing ? closingHtml(closing) : '',
  ].filter(Boolean).join('\n');
  return {
    html: layout({ ...message, bodyHtml, settings }),
    text: plainText({ ...message, sections, closing, settings }),
  };
}

function pdfAttachment(name, pdfBuffer) {
  if (!pdfBuffer) return [];
  if (!Buffer.isBuffer(pdfBuffer)) throw new TypeError('The PDF attachment must be a Buffer');
  return [{ filename: `${safeFileName(name)}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }];
}

const quoteName = (name) => `"${String(name).replace(/["\\]/g, '')}"`;

// Resend answers errors as { statusCode, name, message }.
function describeResendFailure(status, body) {
  const detail = headerText(body && body.message) || `HTTP ${status}`;
  const name = body && body.name;
  let reason = null;
  if (status === 401 || ['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key'].includes(name)) {
    reason = 'Resend rejected the API key (check RESEND_API_KEY)';
  } else if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') {
    reason = 'The Resend sending quota for this plan is used up. Emails go out again when the quota resets or the plan is upgraded';
  } else if (status === 403) {
    reason = 'Resend refused the sender address. Verify the domain in Resend and use an address on it in EMAIL_FROM';
  } else if (status === 429) {
    reason = 'Resend is limiting how fast emails can be sent. Try again in a moment';
  } else if (status >= 500) {
    reason = 'Resend is temporarily unavailable';
  }
  return new Error(reason ? `${reason} (${detail})` : detail);
}

async function deliverWithResend(settings, mail) {
  const from = resendSender(settings);
  const replyTo = parseFrom(config.resend.replyTo) || parseFrom(settings.company_email);
  const payload = {
    from: `${quoteName(from.name)} <${from.address}>`,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };
  if (replyTo && replyTo.address !== from.address) payload.reply_to = replyTo.address;
  if (mail.attachments.length) {
    payload.attachments = mail.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
      content_type: a.contentType,
    }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? 'Resend did not respond in time'
      : `Could not reach Resend (${headerText(err.message) || 'network error'})`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw describeResendFailure(res.status, body);
  return { messageId: body && body.id, provider: 'resend' };
}

async function deliver(settings, to, subject, message, attachments = []) {
  const provider = emailProvider(settings);
  if (!provider) {
    if (config.emailDisabled) throw new Error('Email is switched off on this server (EMAIL_DISABLED).');
    throw new Error(config.resend.apiKey
      ? 'Email has no sender address. Set EMAIL_FROM to an address on your verified Resend domain.'
      : 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM on the server, or add a mail server in Settings.');
  }
  const mail = {
    to: recipients(to),
    subject: headerText(subject),
    ...compose(message, settings),
    attachments,
  };
  if (provider === 'resend') return deliverWithResend(settings, mail);

  const transporter = getTransporter(settings);
  try {
    return await transporter.sendMail({ ...mail, from: sender(settings) });
  } catch (err) {
    throw describeFailure(err, settings);
  }
}

// ── Shared wording ───────────────────────────────────────────────────────────

const greeting = (name) => (text(name) ? `Dear ${text(name)},` : 'Hello,');

// "<lead>, reply to this email or write to <company email>."
function replyLine(lead, settings) {
  const contact = text(settings.company_email);
  return looksLikeEmail(contact)
    ? `${lead}, reply to this email or write to ${contact}.`
    : `${lead}, reply to this email.`;
}

const questionsLine = (settings) => replyLine('If you have any questions', settings);

// Bank details as "Label: value" lines, '' when nothing is filled in.
function paymentDetails(settings) {
  const lines = [
    ['Bank', settings.bank_name],
    ['Account name', settings.bank_account_name],
    ['Account number', settings.bank_account_no],
    ['Branch', settings.bank_branch],
    ['SWIFT / BIC', settings.bank_swift],
  ].filter(([, value]) => !isBlank(value)).map(([label, value]) => `${label}: ${headerText(value)}`);
  if (!isBlank(settings.payment_instructions)) lines.push(text(settings.payment_instructions));
  return lines.join('\n');
}

// ── Messages ─────────────────────────────────────────────────────────────────

// To the client, with the invoice PDF attached.
async function sendInvoiceEmail(invoice, pdfBuffer, settings) {
  const company = companyName(settings);
  const number = headerText(invoice.invoice_number);
  const due = displayDate(invoice.due_date);
  const paid = invoice.status === 'Paid';

  const intro = [
    greeting(invoice.client_name),
    pdfBuffer
      ? `Please find invoice ${number} from ${company} attached. A summary is below.`
      : `Here is a summary of invoice ${number} from ${company}.`,
  ];
  if (paid) intro.push('This invoice has been paid. Thank you.');
  else if (due) intro.push(invoice.status === 'Overdue' ? `Payment was due on ${due}.` : `Payment is due by ${due}.`);

  return deliver(settings, invoice.client_email, `Invoice ${number} from ${company}`, {
    heading: `Invoice ${number}`,
    intro,
    rows: [
      ['Invoice number', number],
      ['Issue date', displayDate(invoice.issue_date)],
      ['Due date', due],
      paid && ['Paid on', displayDate(invoice.paid_date)],
    ],
    highlight: [paid ? 'Total paid' : 'Amount due', money(invoice.total, invoice, settings)],
    sections: [
      !paid && ['Payment details', paymentDetails(settings)],
      ['Notes', invoice.notes],
      ['Terms', invoice.terms],
    ],
    closing: questionsLine(settings),
  }, pdfAttachment(`Invoice-${number}`, pdfBuffer));
}

// To the client, with the proposal PDF attached.
async function sendProposalEmail(proposal, pdfBuffer, settings) {
  const company = companyName(settings);
  const number = headerText(proposal.proposal_number);
  const validUntil = displayDate(proposal.valid_until);

  const intro = [
    greeting(proposal.client_name),
    pdfBuffer
      ? `Thank you for your interest in working with ${company}. Our proposal is attached, and a summary is below.`
      : `Thank you for your interest in working with ${company}. A summary of our proposal is below.`,
  ];
  if (validUntil) intro.push(`This proposal is valid until ${validUntil}.`);

  return deliver(settings, proposal.client_email, `Proposal ${number} from ${company}`, {
    heading: headerText(proposal.title) || `Proposal ${number}`,
    intro,
    rows: [
      ['Proposal number', number],
      ['Date', displayDate(proposal.issue_date)],
      ['Valid until', validUntil],
    ],
    highlight: ['Total', money(proposal.total, proposal, settings)],
    sections: [
      ['Summary', proposal.summary],
      ['Notes', proposal.notes],
      ['Terms', proposal.terms],
    ],
    closing: replyLine('To accept this proposal or ask for changes', settings),
  }, pdfAttachment(`Proposal-${number}`, pdfBuffer));
}

// To the client: an unpaid invoice is coming due or is past its due date.
async function sendPaymentReminderEmail(invoice, settings) {
  const company = companyName(settings);
  const number = headerText(invoice.invoice_number);
  const dueDate = text(invoice.due_date).slice(0, 10);
  const due = displayDate(dueDate);
  const overdue = invoice.status === 'Overdue' || (/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate < today());

  const dueOn = due ? ` on ${due}` : '';

  return deliver(settings, invoice.client_email,
    overdue ? `Overdue: invoice ${number} from ${company}` : `Reminder: invoice ${number} from ${company} is due${dueOn || ' soon'}`,
    {
      heading: overdue ? 'Payment overdue' : 'Payment reminder',
      intro: [
        greeting(invoice.client_name),
        overdue
          ? `Our records show that invoice ${number}${due ? `, which was due on ${due},` : ''} has not been paid yet. Please arrange payment as soon as you can.`
          : `This is a friendly reminder that invoice ${number} is due${dueOn || ' soon'}.`,
        'If you have already made this payment, please ignore this message.',
      ],
      rows: [
        ['Invoice number', number],
        ['Issue date', displayDate(invoice.issue_date)],
        ['Due date', due],
      ],
      highlight: ['Amount due', money(invoice.total, invoice, settings)],
      sections: [['Payment details', paymentDetails(settings)]],
      closing: questionsLine(settings),
    });
}

// Internal: tells the business that one of its own recurring payments is coming up.
async function sendRecurringReminderEmail(payment, settings, to) {
  const income = payment.type === 'Income';
  const name = headerText(payment.name) || 'Recurring payment';
  const due = displayDate(payment.next_payment_date);
  const party = headerText(payment.client_vendor);
  const when = due ? ` on ${due}` : '';

  return deliver(settings, to || settings.company_email,
    `Reminder: ${name} is ${income ? 'expected' : 'due'}${when}`,
    {
      heading: income ? 'Incoming payment reminder' : 'Upcoming payment reminder',
      intro: [
        income
          ? `A recurring payment${party ? ` from ${party}` : ''} is expected${when}.`
          : `A recurring payment${party ? ` to ${party}` : ''} is due${when}.`,
        `This is an automatic reminder from the ${companyName(settings)} finance system. Record the payment on the Recurring page once it has been ${income ? 'received' : 'made'}.`,
      ],
      rows: [
        ['Name', name],
        ['Type', payment.type],
        ['Category', payment.category],
        [income ? 'Client' : 'Vendor', party],
        ['Billing cycle', payment.billing_cycle],
        ['Due date', due],
      ],
      highlight: ['Amount', money(payment.amount, payment, settings)],
      sections: [['Notes', payment.notes]],
    });
}

// To the payee, with the salary slip PDF attached.
async function sendSalarySlipEmail(salary, toEmail, pdfBuffer, settings) {
  const company = companyName(settings);
  const period = displayMonth(salary.payment_month);
  const base = round2(salary.base_salary);
  const bonuses = round2(salary.bonuses);
  const deductions = round2(salary.deductions);
  const net = isBlank(salary.net_salary) ? round2(base + bonuses - deductions) : round2(salary.net_salary);
  const forPeriod = period ? ` for ${period}` : '';

  return deliver(settings, toEmail, `Salary slip${forPeriod} from ${company}`, {
    heading: `Salary slip${forPeriod}`,
    intro: [
      greeting(salary.employee_name),
      pdfBuffer
        ? `Please find your salary slip${forPeriod} attached. A summary is below.`
        : `Here is a summary of your salary${forPeriod}.`,
    ],
    rows: [
      ['Pay period', period],
      ['Basic salary', money(base, salary, settings)],
      bonuses > 0 && ['Bonuses', money(bonuses, salary, settings)],
      deductions > 0 && ['Deductions', money(-deductions, salary, settings)],
      ['Payment date', displayDate(salary.payment_date)],
      ['Payment method', salary.payment_method],
    ],
    highlight: ['Net pay', money(net, salary, settings)],
    closing: questionsLine(settings),
  }, pdfAttachment(`Salary-Slip-${text(salary.employee_name)}-${text(salary.payment_month)}`, pdfBuffer));
}

// Short confirmation used by Settings → "Send test email".
async function sendTestEmail(settings, to) {
  const company = companyName(settings);
  return deliver(settings, to || settings.company_email, `Test email from ${company}`, {
    heading: 'Email is working',
    intro: [
      `This is a test message from the ${company} finance system.`,
      'Outgoing email is set up correctly, so invoices, proposals, reminders and salary slips can be sent.',
    ],
    rows: emailProvider(settings) === 'resend'
      ? [['Sent through', 'Resend'], ['Sent from', resendSender(settings).address]]
      : [['Mail server', `${text(settings.smtp_host)}:${smtpPort(settings)}`], ['Sent from', senderAddress(settings)]],
  });
}

module.exports = {
  isEmailConfigured,
  emailProvider,
  emailStatus,
  sendInvoiceEmail,
  sendProposalEmail,
  sendPaymentReminderEmail,
  sendRecurringReminderEmail,
  sendSalarySlipEmail,
  sendTestEmail,
};
