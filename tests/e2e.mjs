// End-to-end API test against a running server with a fresh database.
// Run it through `npm test` (scripts/test.js starts the server for you).
//   BASE      server address, e.g. http://localhost:3998
//   ADMIN_PW  password of the "admin" account the server was started with
//   OUT       folder for the generated PDFs (also used as a sample receipt)
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3998'
const ADMIN_PW = process.env.ADMIN_PW
let pass = 0, fail = 0
const failures = []
const ok = (cond, name, extra = '') => {
  if (cond) pass++
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL  ${name} ${extra}`) }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005

function client() {
  let cookie = ''
  async function call(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) }
    if (cookie) headers.cookie = cookie
    let payload
    if (body instanceof FormData) payload = body
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
    const type = res.headers.get('content-type') || ''
    let data
    if (opts.raw) data = Buffer.from(await res.arrayBuffer())
    else if (type.includes('json')) data = await res.json()
    else data = await res.text()
    return { status: res.status, data, headers: res.headers }
  }
  return {
    get: (p, o) => call('GET', p, undefined, o), post: (p, b, o) => call('POST', p, b ?? {}, o),
    put: (p, b, o) => call('PUT', p, b ?? {}, o), del: (p, o) => call('DELETE', p, undefined, o),
    cookie: () => cookie,
  }
}

const A = client()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' })
const ym = today.slice(0, 7)
const plus = (d) => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10) }

console.log('— auth')
let r = await A.get('/api/dashboard'); ok(r.status === 401, 'unauthenticated dashboard is 401', r.status)
r = await A.get('/api/health'); ok(r.status === 200 && r.data.status === 'ok', 'health')
r = await A.post('/api/auth/login', { username: 'admin', password: 'wrong-password-1' }); ok(r.status === 401, 'wrong password 401', r.status)
r = await A.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }); ok(r.status === 200 && r.data.user.role === 'admin', 'admin login', r.status)
ok(/HttpOnly/i.test(r.headers.get('set-cookie') || '') && /SameSite=Strict/i.test(r.headers.get('set-cookie') || ''), 'cookie is HttpOnly + SameSite=Strict')
r = await A.get('/api/auth/me'); ok(r.status === 200 && r.data.user.username === 'admin', 'me')
r = await A.post('/api/clients', { name: 'X' }, { headers: { origin: 'https://evil.example' } }); ok(r.status === 403, 'cross-site POST blocked', r.status)
r = await A.get('/api/nope'); ok(r.status === 404 && r.data.error, 'unknown API path is JSON 404', r.status)
r = await A.get('/dashboard'); ok(r.status === 200 && String(r.data).includes('<div id="root">'), 'SPA fallback serves the app')
ok((r.headers.get('content-security-policy') || '').includes("default-src 'self'"), 'CSP header present')

console.log('— settings')
r = await A.put('/api/settings', { company_name: 'GroovyMark', company_email: 'finance@groovymark.test', bank_name: 'Test Bank', bank_account_no: '0001112223', bank_account_name: 'GroovyMark (Pvt) Ltd', invoice_due_days: 14, default_tax_rate: 0 })
ok(r.status === 200 && r.data.company_name === 'GroovyMark' && r.data.invoice_due_days === 14, 'settings update', r.status + ' ' + JSON.stringify(r.data).slice(0, 120))
ok(!('smtp_pass' in r.data) && !('admin_password_hash' in r.data) && !('openai_key' in r.data), 'settings response has no secrets')
r = await A.put('/api/settings', { invoice_prefix: 'bad prefix!!' }); ok(r.status === 400, 'bad prefix rejected', r.status)
r = await A.get('/api/settings/system'); ok(r.status === 200 && r.data.email && r.data.email.provider === null && !JSON.stringify(r.data).includes('re_'), 'system info, email not configured, no key leaked')

console.log('— clients')
r = await A.post('/api/clients', { name: 'Acme Holdings', email: 'accounts@acme.test', company: 'Acme (Pvt) Ltd', address: '12 Galle Road, Colombo' }); ok(r.status === 201, 'client create', r.status)
const clientId = r.data.id
r = await A.post('/api/clients', { email: 'x@y.test' }); ok(r.status === 400, 'client without name rejected', r.status)

console.log('— proposals')
const items = [{ description: 'Website design', quantity: 1, unit_price: 1500 }, { description: 'Hosting (12 months)', quantity: 12, unit_price: 12.5 }]
r = await A.post('/api/proposals', { client_id: clientId, client_name: 'Acme Holdings', client_email: 'accounts@acme.test', title: 'Website redesign', summary: 'Design and build.', issue_date: today, valid_until: plus(30), currency: 'USD', items, tax_rate: 10, discount: 50 })
ok(r.status === 201 && /^PRO-0001-/.test(r.data.proposal_number), 'proposal create', r.status + ' ' + JSON.stringify(r.data))
const propId = r.data.id
r = await A.get(`/api/proposals/${propId}`)
// subtotal 1650, discount 50, tax 10% of 1600 = 160, total 1760
ok(near(r.data.subtotal, 1650) && near(r.data.tax_amount, 160) && near(r.data.total, 1760), 'proposal totals (discount before tax)', JSON.stringify([r.data.subtotal, r.data.tax_amount, r.data.total]))
r = await A.get(`/api/proposals/${propId}/pdf`, { raw: true }); ok(r.status === 200 && r.data.subarray(0, 4).toString() === '%PDF' && r.data.length > 1500, 'proposal PDF', r.status + ' ' + r.data.length)
fs.writeFileSync(process.env.OUT + '/proposal.pdf', r.data)
r = await A.post(`/api/proposals/${propId}/send`); ok(r.status === 200 && r.data.emailSent === false && /not (set up|configured)/i.test(r.data.message), 'proposal send without email → marked sent, explains', JSON.stringify(r.data))
r = await A.get('/api/proposals/stats'); ok(r.status === 200 && r.data.counts.Sent === 1 && r.data.open_value > 0, 'proposal stats', JSON.stringify(r.data))
r = await A.post(`/api/proposals/${propId}/convert`); ok(r.status === 201 && r.data.invoice_number, 'convert to invoice', r.status + ' ' + JSON.stringify(r.data))
const convInvId = r.data.invoice_id
r = await A.post(`/api/proposals/${propId}/convert`); ok(r.status === 409, 'second convert is 409', r.status)
r = await A.get(`/api/invoices/${convInvId}`); ok(near(r.data.total, 1760) && r.data.currency === 'USD' && r.data.items.length === 2 && r.data.status === 'Draft', 'converted invoice matches proposal', JSON.stringify([r.data.total, r.data.currency, r.data.status]))
r = await A.put(`/api/proposals/${propId}`, { client_name: 'Acme Holdings', title: 'x', issue_date: today, valid_until: plus(30), currency: 'USD', items, tax_rate: 0, discount: 0 }); ok(r.status === 400, 'accepted proposal cannot be edited', r.status)
r = await A.post(`/api/proposals/${propId}/duplicate`); ok(r.status === 201 && /^PRO-0002-/.test(r.data.proposal_number), 'proposal duplicate', JSON.stringify(r.data))

console.log('— invoices')
r = await A.post('/api/invoices', { client_id: clientId, client_name: 'Acme Holdings', client_email: 'accounts@acme.test', issue_date: today, due_date: plus(14), currency: 'LKR', items: [{ description: 'Monthly retainer', quantity: 2, unit_price: 1500.56 }], tax_rate: 18, discount: 0 })
ok(r.status === 201, 'invoice create', r.status + ' ' + JSON.stringify(r.data))
const invId = r.data.id, invNo = r.data.invoice_number
r = await A.get(`/api/invoices/${invId}`)
// unit 1500.56 ×2 = 3001.12; tax 18% = 540.20; total 3541.32
ok(near(r.data.subtotal, 3001.12) && near(r.data.tax_amount, 540.2) && near(r.data.total, 3541.32), 'invoice totals rounding', JSON.stringify([r.data.subtotal, r.data.tax_amount, r.data.total]))
const invBody = { client_id: clientId, client_name: 'Acme Holdings', client_email: 'accounts@acme.test', issue_date: today, due_date: plus(14), currency: 'LKR', items: r.data.items, tax_rate: 18, discount: 0 }
r = await A.put(`/api/invoices/${invId}`, invBody); const r2 = await A.get(`/api/invoices/${invId}`)
ok(r.status === 200 && near(r2.data.total, 3541.32), 're-saving an invoice does not move its total', r2.data.total)
r = await A.post('/api/invoices', { client_name: 'Acme', issue_date: today, due_date: plus(-1), items: [{ description: 'a', quantity: 1, unit_price: 1 }] }); ok(r.status === 400, 'due date before issue date rejected', r.status)
r = await A.post('/api/invoices', { client_name: 'Acme', issue_date: '2026-02-31', due_date: '2026-03-10', items: [{ description: 'a', quantity: 1, unit_price: 1 }] }); ok(r.status === 400, 'impossible date rejected', r.status)
r = await A.post('/api/invoices', { client_name: 'Acme', issue_date: today, due_date: today, items: [] }); ok(r.status === 400, 'invoice without items rejected', r.status)
r = await A.put(`/api/invoices/${invId}`, { ...invBody, status: 'Paid' }); ok(r.status === 400, 'cannot set Paid through edit', r.status)
r = await A.get(`/api/invoices/${invId}/pdf`, { raw: true }); ok(r.status === 200 && r.data.subarray(0, 4).toString() === '%PDF', 'invoice PDF', r.status)
fs.writeFileSync(process.env.OUT + '/invoice.pdf', r.data)
r = await A.post(`/api/invoices/${invId}/send`); ok(r.status === 200 && r.data.emailSent === false, 'invoice send (no email) marks sent', JSON.stringify(r.data))
r = await A.get(`/api/invoices/${invId}`); ok(r.data.status === 'Sent', 'status is Sent', r.data.status)
r = await A.post(`/api/invoices/${invId}/mark-paid`, { paid_date: today, payment_method: 'Bank Transfer' }); ok(r.status === 200, 'mark paid', r.status + ' ' + JSON.stringify(r.data))
r = await A.get('/api/revenue'); let auto = r.data.filter((x) => x.invoice_id === invId)
ok(auto.length === 1 && near(auto[0].amount, 3541.32) && auto[0].payment_status === 'Paid' && auto[0].auto_recorded === 1, 'income row created from paid invoice', JSON.stringify(auto))
r = await A.post(`/api/invoices/${invId}/mark-paid`, {}); ok(r.status === 400, 'second mark-paid rejected', r.status)
r = await A.put(`/api/invoices/${invId}`, invBody); ok(r.status === 400, 'paid invoice cannot be edited', r.status)
r = await A.del(`/api/revenue/${auto[0].id}`); ok(r.status === 400, 'auto income cannot be deleted directly', r.status)
r = await A.get('/api/dashboard'); ok(r.status === 200 && near(r.data.stats.monthRevenue, 3541.32) && r.data.chartData.length === 12, 'dashboard reflects income', JSON.stringify([r.data.stats.monthRevenue, r.data.chartData.length]))
r = await A.post(`/api/invoices/${invId}/mark-unpaid`); const rv = await A.get('/api/revenue')
ok(r.status === 200 && rv.data.filter((x) => x.invoice_id === invId).length === 0, 'mark unpaid removes the income row', r.status)
r = await A.post(`/api/invoices/${invId}/mark-paid`, {}); r = await A.del(`/api/invoices/${invId}`); const rv2 = await A.get('/api/revenue')
ok(r.status === 200 && rv2.data.filter((x) => x.invoice_number === invNo).length === 0, 'deleting a paid invoice removes its income', r.status)
r = await A.post('/api/invoices', { client_name: 'Acme Holdings', issue_date: today, due_date: plus(7), currency: 'LKR', items: [{ description: 'Next', quantity: 1, unit_price: 10 }] })
ok(r.status === 201 && r.data.invoice_number !== invNo, 'deleted invoice number is not reused', r.data.invoice_number + ' vs ' + invNo)
const inv3 = r.data.id
r = await A.post(`/api/invoices/${inv3}/status`, { status: 'Cancelled' }); ok(r.status === 200 && r.data.status === 'Cancelled', 'cancel via status endpoint', JSON.stringify(r.data))
r = await A.post(`/api/invoices/${inv3}/mark-paid`, {}); ok(r.status === 400, 'cancelled invoice cannot be paid', r.status)
r = await A.post(`/api/invoices/${convInvId}/send`); r = await A.post(`/api/invoices/${convInvId}/mark-paid`, { paid_date: today }); ok(r.status === 200, 'pay the USD invoice', r.status)
// overdue: create an invoice issued and due in the past, saved as Sent
r = await A.post('/api/invoices', { client_name: 'Late Payer Ltd', issue_date: plus(-40), due_date: plus(-10), currency: 'LKR', items: [{ description: 'Old work', quantity: 1, unit_price: 5000 }], status: 'Sent' })
const lateId = r.data.id
r = await A.get('/api/invoices?status=Overdue'); ok(r.data.some((x) => x.id === lateId), 'past-due sent invoice becomes Overdue on listing', JSON.stringify(r.data.map((x) => [x.id, x.status])))
r = await A.get('/api/notifications'); ok(r.data.some((n) => n.title === 'Invoice overdue'), 'overdue notification raised')
r = await A.get('/api/reports/receivables'); ok(r.status === 200 && near(r.data.total, 5000) && near(r.data.buckets.d1_30, 5000), 'receivables ageing', JSON.stringify([r.data.total, r.data.buckets]))

console.log('— income (manual)')
r = await A.post('/api/revenue', { client_name: 'Walk-in', service_type: 'Consulting', invoice_date: today, amount: 250, currency: 'USD', payment_status: 'Paid' }); ok(r.status === 201, 'manual income', r.status)
r = await A.post('/api/revenue', { client_name: 'Walk-in', invoice_date: today, amount: -5 }); ok(r.status === 400, 'negative income rejected', r.status)
r = await A.get('/api/revenue/stats'); ok(r.status === 200 && r.data.byClient.length >= 1 && r.data.base_currency === 'LKR', 'income stats', JSON.stringify(r.data).slice(0, 160))

console.log('— expenses')
const pdfBytes = fs.readFileSync(process.env.OUT + '/invoice.pdf')
let fd = new FormData(); fd.append('title', 'Figma subscription'); fd.append('category', 'Software'); fd.append('amount', '45'); fd.append('currency', 'USD'); fd.append('payment_date', today); fd.append('receipt', new Blob([pdfBytes], { type: 'application/pdf' }), 'receipt.pdf')
r = await A.post('/api/expenses', fd); ok(r.status === 201, 'expense with receipt', r.status + ' ' + JSON.stringify(r.data))
const expId = r.data.id
r = await A.get('/api/expenses'); const exp = r.data.find((x) => x.id === expId)
ok(exp && /^\/uploads\/receipts\/[a-f0-9]+\.pdf$/.test(exp.receipt_path), 'receipt stored with a server-chosen name', exp && exp.receipt_path)
r = await A.get(exp.receipt_path, { raw: true }); ok(r.status === 200 && r.data.length === pdfBytes.length, 'receipt downloadable when signed in', r.status)
r = await client().get(exp.receipt_path); ok(r.status === 401, 'receipt is private', r.status)
fd = new FormData(); fd.append('title', 'Bad'); fd.append('category', 'Software'); fd.append('amount', '1'); fd.append('payment_date', today); fd.append('receipt', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html')
r = await A.post('/api/expenses', fd); ok(r.status === 400, 'HTML upload rejected', r.status)
r = await A.del(`/api/expenses/${expId}`); const gone = await A.get(exp.receipt_path); ok(r.status === 200 && gone.status === 404, 'deleting an expense removes its receipt file', gone.status)
fd = new FormData(); fd.append('title', 'Office rent'); fd.append('category', 'Rent'); fd.append('amount', '85000'); fd.append('currency', 'LKR'); fd.append('payment_date', today)
r = await A.post('/api/expenses', fd); ok(r.status === 201, 'expense without receipt', r.status)

console.log('— recurring')
r = await A.post('/api/recurring', { name: 'Cloud hosting', type: 'Expense', category: 'Software', billing_cycle: 'Monthly', amount: 12000, currency: 'LKR', next_payment_date: plus(2) }); ok(r.status === 201, 'recurring create', r.status + JSON.stringify(r.data))
const recId = r.data.id
r = await A.post(`/api/recurring/${recId}/process`, { occurrence_date: plus(2) }); ok(r.status === 200 && r.data.recorded?.type === 'expense' && r.data.next_payment_date > plus(2), 'recording a recurring payment adds an expense and moves the date', JSON.stringify(r.data))
r = await A.post(`/api/recurring/${recId}/process`, { occurrence_date: plus(2) }); ok(r.status === 409, 'same occurrence cannot be recorded twice', r.status)
r = await A.get('/api/expenses?category=Software'); ok(r.data.some((x) => x.source === `recurring:${recId}:${plus(2)}` && near(x.amount, 12000)), 'recurring expense row present')
r = await A.post('/api/recurring', { name: 'Retainer — Acme', type: 'Income', category: 'Retainer', billing_cycle: 'Monthly', amount: 300, currency: 'USD', next_payment_date: today, client_vendor: 'Acme Holdings' }); const recInc = r.data.id
r = await A.post(`/api/recurring/${recInc}/process`, {}); ok(r.status === 200 && r.data.recorded?.type === 'income', 'recurring income recorded', JSON.stringify(r.data))

console.log('— payroll')
r = await A.post('/api/employees', { name: 'Nimal Perera', position: 'Designer', department: 'Studio', email: 'nimal@groovymark.test', base_salary: 150000, currency: 'LKR' }); ok(r.status === 201, 'person create', r.status + JSON.stringify(r.data))
const p1 = r.data.id
r = await A.post('/api/employees', { name: 'Kamala Silva', position: 'Developer', base_salary: 200000, currency: 'LKR' }); const p2 = r.data.id
r = await A.post('/api/salaries/generate', { payment_month: ym }); ok(r.status === 200 && r.data.created === 2, 'generate payroll', JSON.stringify(r.data))
r = await A.post('/api/salaries/generate', { payment_month: ym }); ok(r.status === 400, 'generate twice rejected', r.status)
r = await A.get(`/api/salaries?month=${ym}`); const [s1, s2] = r.data
ok(r.data.length === 2 && r.data.every((s) => s.status === 'Pending'), 'two pending salaries')
r = await A.post(`/api/salaries/${s1.id}/pay`, {}); ok(r.status === 200, 'pay salary 1', r.status + JSON.stringify(r.data))
r = await A.post(`/api/salaries/${s2.id}/pay`, {}); ok(r.status === 200, 'pay salary 2', r.status)
const payrollRow = async () => (await A.get('/api/expenses?category=Salaries')).data.filter((x) => (x.source || '').startsWith(`payroll:${ym}`))
let pr = await payrollRow(); ok(pr.length === 1 && near(pr[0].amount, 350000), 'one payroll expense row with the sum', JSON.stringify(pr.map((x) => [x.source, x.amount])))
r = await A.put(`/api/expenses/${pr[0].id}`, (() => { const f = new FormData(); f.append('title', 'x'); f.append('category', 'Salaries'); f.append('amount', '1'); f.append('payment_date', today); return f })()); ok(r.status === 400, 'payroll expense is read-only in Expenses', r.status)
r = await A.post(`/api/salaries/${s1.id}/unpay`); pr = await payrollRow(); ok(r.status === 200 && pr.length === 1 && near(pr[0].amount, s2.net_salary), 'unpay reduces the payroll expense', JSON.stringify(pr.map((x) => x.amount)))
r = await A.del(`/api/salaries/${s2.id}`); pr = await payrollRow(); ok(r.status === 200 && pr.length === 0, 'deleting the last paid salary removes the payroll expense', pr.length)
r = await A.post(`/api/salaries/${s1.id}/pay`, {}); r = await A.get(`/api/salaries/${s1.id}/pdf`, { raw: true }); ok(r.status === 200 && r.data.subarray(0, 4).toString() === '%PDF', 'salary slip PDF', r.status)
fs.writeFileSync(process.env.OUT + '/slip.pdf', r.data)
r = await A.del(`/api/employees/${p1}`); const kept = await A.get(`/api/salaries?month=${ym}`); ok(r.status === 200 && kept.data.length === 1, 'deleting a person keeps their payment history', r.status)

console.log('— reports')
r = await A.get(`/api/reports/pl?month=${ym}`)
ok(r.status === 200 && near(r.data.totalExpenses, r.data.salaries + r.data.opsExpenses) && near(r.data.netProfit, r.data.revenue - r.data.totalExpenses), 'P&L is internally consistent', JSON.stringify([r.data.revenue, r.data.totalExpenses, r.data.salaries, r.data.opsExpenses, r.data.netProfit]))
const pl = r.data
r = await A.get('/api/dashboard'); ok(near(r.data.stats.monthRevenue, pl.revenue), 'dashboard and P&L agree on income to the cent', r.data.stats.monthRevenue + ' vs ' + pl.revenue)
ok(near(r.data.stats.monthExpenses, pl.totalExpenses), 'dashboard and P&L agree on expenses to the cent', r.data.stats.monthExpenses + ' vs ' + pl.totalExpenses)
for (const rep of ['revenue', 'expenses', 'cashflow', `payroll?month=${ym}`]) { r = await A.get(`/api/reports/${rep}`); ok(r.status === 200 && r.data.base_currency === 'LKR', `report ${rep}`, r.status) }
r = await A.get('/api/currency/rates'); ok(r.status === 200 && r.data.base === 'LKR' && r.data.rates.length >= 5, 'currency rates', JSON.stringify(r.data).slice(0, 100))

console.log('— users & roles')
r = await A.post('/api/users', { username: 'priya', name: 'Priya', role: 'staff' }); ok(r.status === 201 && r.data.temporary_password, 'create staff user', r.status)
const tempPw = r.data.temporary_password, staffId = r.data.id
const S = client()
r = await S.post('/api/auth/login', { username: 'priya', password: tempPw }); ok(r.status === 200 && r.data.user.must_change_password === true, 'staff login with temp password', r.status)
r = await S.get('/api/clients'); ok(r.status === 403 && r.data.code === 'PASSWORD_CHANGE_REQUIRED', 'blocked until password changed', r.status)
r = await S.post('/api/auth/change-password', { current_password: tempPw, new_password: 'short1' }); ok(r.status === 400, 'weak password rejected', r.status)
r = await S.post('/api/auth/change-password', { current_password: tempPw, new_password: 'StaffPassw0rd-22' }); ok(r.status === 200, 'password changed', r.status)
r = await S.get('/api/clients'); ok(r.status === 200, 'staff can use the system', r.status)
r = await S.get('/api/users'); ok(r.status === 403, 'staff cannot list users', r.status)
r = await S.get('/api/backup'); ok(r.status === 403, 'staff cannot see backups', r.status)
r = await S.put('/api/settings', { company_name: 'Hacked' }); ok(r.status === 403, 'staff cannot change settings', r.status)
r = await S.get('/api/settings/system'); ok(r.status === 403, 'staff cannot see system info', r.status)
r = await A.post(`/api/users/${staffId}/reset-password`); const S2 = await S.get('/api/clients'); ok(r.status === 200 && S2.status === 401, 'password reset signs the user out', S2.status)
r = await A.del(`/api/users/1`); ok(r.status === 400, 'cannot delete own account', r.status)
r = await A.put('/api/users/1', { role: 'staff' }); ok(r.status === 400, 'cannot demote the last admin', r.status)

console.log('— backup')
r = await A.post('/api/backup'); ok(r.status === 201, 'create backup', r.status)
r = await A.get('/api/backup'); ok(r.status === 200 && r.data.backups.length >= 1, 'list backups')
r = await A.get('/api/backup/download', { raw: true }); ok(r.status === 200 && r.data.subarray(0, 15).toString() === 'SQLite format 3', 'download is a SQLite file', r.status)
const backupBytes = r.data
fd = new FormData(); fd.append('backup', new Blob(['not a database'], { type: 'application/octet-stream' }), 'x.db')
r = await A.post('/api/backup/restore', fd); ok(r.status === 400, 'junk restore rejected', r.status + ' ' + JSON.stringify(r.data))
r = await A.get('/api/backup/..%2F..%2Ffinancial.db/download'); ok(r.status === 404, 'path traversal on backup name refused', r.status)
fd = new FormData(); fd.append('backup', new Blob([backupBytes]), 'good.db')
r = await A.post('/api/backup/restore', fd); ok(r.status === 200 && r.data.restarting === false, 'valid restore is staged', r.status + ' ' + JSON.stringify(r.data))

console.log('— lockout')
const L = client()
for (let i = 0; i < 5; i++) r = await L.post('/api/auth/login', { username: 'priya', password: 'nope-nope-' + i })
ok(r.status === 423, 'five wrong passwords hold this address back', r.status)
r = await A.post(`/api/users/${staffId}/unlock`); ok(r.status === 200, 'admin can unlock', r.status)

console.log('— logout')
r = await A.post('/api/auth/logout'); r = await A.get('/api/auth/me'); ok(r.status === 401, 'signed out', r.status)

console.log('— audit fixes')
const B = client()
r = await B.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }); ok(r.status === 200, 'admin signs in again', r.status)
const one = [{ description: 'Line', quantity: 1, unit_price: 100 }]
const doc = (extra) => ({ client_name: 'Checks Ltd', issue_date: today, due_date: plus(10), currency: 'LKR', items: one, ...extra })
r = await B.post('/api/invoices', doc({ items: [{ description: 'Impressions', quantity: 10000, unit_price: 0.035 }] })); ok(r.status === 400 && /2 decimal/.test(r.data.error), 'unit price with 3 decimals is refused, not rounded', r.status + ' ' + JSON.stringify(r.data))
r = await B.post('/api/invoices', doc({ items: [{ description: 'Big', quantity: 1e308, unit_price: 100 }] })); ok(r.status === 400, 'absurd quantity refused', r.status)
r = await B.post('/api/invoices', doc({ items: [{ description: ['a', 'b'], quantity: 1, unit_price: 1 }] })); ok(r.status === 400, 'non-text description refused', r.status)
r = await B.post('/api/invoices', doc({ client_name: { a: 1 } })); ok(r.status === 400, 'object as client name refused', r.status)
r = await B.post('/api/invoices', doc({ tax_rate: 'abc' })); ok(r.status === 400, 'non-numeric tax refused', r.status)
r = await B.post('/api/invoices', doc({ issue_date: '0026-10-04', due_date: '0026-10-20' })); ok(r.status === 400, 'year 0026 refused', r.status)
r = await B.post('/api/revenue', { client_name: 'X', invoice_date: '0026-10-04', amount: 5 }); ok(r.status === 400, 'income dated year 0026 refused', r.status)
r = await B.post('/api/invoices', doc({ client_id: 999999 })); ok(r.status === 201, 'a deleted client id no longer blocks saving', r.status + ' ' + JSON.stringify(r.data))
const dId = r.data.id
r = await B.get(`/api/invoices/${dId}`); ok(r.data.client_id === null, 'the dead client link is dropped', r.data.client_id)
r = await B.post(`/api/invoices/${dId}/mark-paid`, {}); r = await B.post(`/api/invoices/${dId}/mark-unpaid`); ok(r.status === 200 && r.data.status === 'Draft', 'unpaying an invoice paid as a draft returns it to Draft', JSON.stringify(r.data))
r = await B.put(`/api/invoices/${dId}`, doc({ due_date: plus(40) })); ok(r.status === 200, 'edit with a new due date', r.status)

// proposals: guards
r = await B.post('/api/proposals', { client_name: 'Checks Ltd', title: 'Guard test', issue_date: today, valid_until: plus(20), currency: 'LKR', items: one }); const gp = r.data.id
r = await B.post(`/api/proposals/${gp}/status`, { status: 'Declined' }); r = await B.post(`/api/proposals/${gp}/convert`); ok(r.status === 409, 'a declined proposal cannot be converted', r.status)
r = await B.post(`/api/proposals/${gp}/status`, { status: 'Draft' }); r = await B.post(`/api/proposals/${gp}/convert`); ok(r.status === 201, 'reopened proposal converts', r.status)
r = await B.post(`/api/proposals/${gp}/status`, { status: 'Declined' }); ok(r.status === 409, 'a proposal with an invoice cannot be declined', r.status)

// recurring: stale occurrence, pause/resume
r = await B.post('/api/recurring', { name: 'Stale check', type: 'Expense', billing_cycle: 'Monthly', amount: 10, currency: 'LKR', next_payment_date: plus(1) }); const sc = r.data.id
r = await B.post(`/api/recurring/${sc}/process`, { occurrence_date: plus(1) }); ok(r.status === 200, 'record once', r.status)
r = await B.post(`/api/recurring/${sc}/process`, { occurrence_date: plus(1) }); ok(r.status === 409 && r.data.code === 'OCCURRENCE_CHANGED', 'a stale dialog gets OCCURRENCE_CHANGED, not a second expense', r.status + ' ' + JSON.stringify(r.data))
r = await B.post(`/api/recurring/${sc}/status`, { status: 'Paused' }); const afterPause = (await B.get('/api/recurring')).data.find((x) => x.id === sc)
ok(r.status === 200 && afterPause.status === 'Paused' && near(afterPause.amount, 10), 'pause changes only the status', JSON.stringify([afterPause.status, afterPause.amount]))
r = await B.post(`/api/recurring/${sc}/status`, { status: 'Active' }); ok(r.status === 200, 'resume', r.status)

// payroll: a late payment must not move earlier payroll into a later month
const lastMonthDay = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(0); return d.toISOString().slice(0, 10) })()
const prevYm = lastMonthDay.slice(0, 7)
r = await B.post('/api/employees', { name: 'Eve', base_salary: 100000, currency: 'LKR' }); const eve = r.data.id
r = await B.post('/api/employees', { name: 'Fay', base_salary: 50000, currency: 'LKR' }); const fay = r.data.id
r = await B.post('/api/salaries', { employee_id: eve, employee_name: 'Eve', base_salary: 100000, payment_month: prevYm, currency: 'LKR' }); const sEve = r.data.id
r = await B.post('/api/salaries', { employee_id: fay, employee_name: 'Fay', base_salary: 50000, payment_month: prevYm, currency: 'LKR' }); const sFay = r.data.id
r = await B.post(`/api/salaries/${sEve}/pay`, { payment_date: lastMonthDay }); ok(r.status === 200, 'pay Eve last month', r.status + JSON.stringify(r.data))
let plPrev = (await B.get(`/api/reports/pl?month=${prevYm}`)).data
ok(near(plPrev.salaries, 100000), 'last month shows Eve only', plPrev.salaries)
r = await B.post(`/api/salaries/${sFay}/pay`, { payment_date: today }); ok(r.status === 200, 'pay Fay this month', r.status)
plPrev = (await B.get(`/api/reports/pl?month=${prevYm}`)).data
const rowsPrev = (await B.get('/api/expenses?category=Salaries')).data.filter((x) => (x.source || '').startsWith(`payroll:${prevYm}:`))
ok(near(plPrev.salaries, 100000), 'paying Fay late leaves last month at 100,000', plPrev.salaries)
ok(rowsPrev.length === 2 && rowsPrev.some((x) => near(x.amount, 100000) && x.payment_date === lastMonthDay) && rowsPrev.some((x) => near(x.amount, 50000) && x.payment_date === today), 'one payroll expense per month of payment', JSON.stringify(rowsPrev.map((x) => [x.source, x.amount, x.payment_date])))
r = await B.post(`/api/salaries/${sFay}/unpay`); const rowsAfter = (await B.get('/api/expenses?category=Salaries')).data.filter((x) => (x.source || '').startsWith(`payroll:${prevYm}:`))
ok(rowsAfter.length === 1 && near(rowsAfter[0].amount, 100000), 'unpaying Fay removes only her row', JSON.stringify(rowsAfter.map((x) => [x.source, x.amount])))

// lockout is per address: a guesser elsewhere cannot lock the owner out (needs TRUST_PROXY=1)
const X = client()
for (let i = 0; i < 6; i++) r = await X.post('/api/auth/login', { username: 'admin', password: 'guess-guess-' + i }, { headers: { 'x-forwarded-for': '203.0.113.9' } })
ok(r.status === 423, 'the guessing address is held back', r.status)
r = await client().post('/api/auth/login', { username: 'admin', password: ADMIN_PW }); ok(r.status === 200, 'the owner still signs in from their own address', r.status)
for (let i = 0; i < 6; i++) r = await client().post('/api/auth/login', { username: 'nobody-here', password: 'guess-guess-' + i }, { headers: { 'x-forwarded-for': '203.0.113.10' } })
ok(r.status === 423, 'unknown usernames are held back the same way (no account discovery)', r.status)

// backup download twice at once
const [d1, d2] = await Promise.all([B.get('/api/backup/download', { raw: true }), B.get('/api/backup/download', { raw: true })])
ok(d1.status === 200 && d2.status === 200 && d1.data.length > 4096 && d2.data.length > 4096, 'two simultaneous backup downloads both complete', d1.status + '/' + d2.status)
r = await B.get('/api/settings/system'); ok(r.data.email && r.data.email.disabled === false, 'email status exposes the disabled flag')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1) }
