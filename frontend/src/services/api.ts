import axios from 'axios'

// Same-origin API. The session lives in an HttpOnly cookie that the browser
// sends automatically, so no token is stored or attached here.
const api = axios.create({ baseURL: '/api', timeout: 30000 })

export const AUTH_EXPIRED_EVENT = 'auth:expired'
export const PASSWORD_CHANGE_EVENT = 'auth:password-change'

api.interceptors.response.use(
  (r) => {
    // A JSON API never answers with a web page; if it does, a proxy or the
    // app fallback replied instead of the API. Fail loudly rather than render HTML as data.
    if (typeof r.data === 'string' && /^\s*<!doctype html/i.test(r.data)) {
      return Promise.reject(Object.assign(new Error('Unexpected response from the server'), { response: r }))
    }
    return r
  },
  (err) => {
    const code = err.response?.data?.code
    const url: string = err.config?.url || ''
    // Only the two calls where "not signed in" is an expected answer are exempt.
    if (err.response?.status === 401 && code === 'UNAUTHENTICATED' && url !== '/auth/login' && url !== '/auth/me') {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    }
    if (err.response?.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event(PASSWORD_CHANGE_EVENT))
    }
    return Promise.reject(err)
  }
)

// ── Types ────────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'staff'

export interface User {
  id: number
  username: string
  name: string | null
  email: string | null
  role: Role
  must_change_password: boolean
}

export interface UserRow extends Omit<User, 'must_change_password'> {
  is_active: number
  must_change_password: number
  last_login_at: string | null
  password_changed_at: string | null
  locked_until: string | null
  created_at: string
}

export interface SessionRow {
  id: number
  ip: string | null
  user_agent: string | null
  created_at: string
  last_seen_at: string
  current: boolean
}

export interface AuditRow {
  id: number
  username: string | null
  action: string
  detail: string | null
  ip: string | null
  created_at: string
}

export interface Settings {
  company_name: string | null
  company_email: string | null
  company_phone: string | null
  company_address: string | null
  company_website: string | null
  company_tax_id: string | null
  currency: string
  currency_symbol: string
  logo_path: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_user: string | null
  smtp_from_name: string | null
  smtp_pass_set: boolean
  invoice_prefix: string | null
  proposal_prefix: string | null
  invoice_terms: string | null
  invoice_notes: string | null
  invoice_due_days: number | null
  default_tax_rate: number | null
  proposal_terms: string | null
  proposal_validity_days: number | null
  bank_name: string | null
  bank_account_name: string | null
  bank_account_no: string | null
  bank_branch: string | null
  bank_swift: string | null
  payment_instructions: string | null
  auto_send_reminders: number
  reminder_days_before: number
  overdue_check_enabled: number
  low_cash_alert_enabled: number
}

export interface SystemInfo {
  version: string
  node: string
  timezone: string
  database_size: number
  email_configured: boolean
  email: {
    configured: boolean
    provider: 'resend' | 'smtp' | null
    from: string
    /** A Resend key is set on the server but no usable sender address was found. */
    resend_missing_sender: boolean
    /** EMAIL_DISABLED is set on the server: nothing is sent. */
    disabled: boolean
  }
  rates_updated_at: string | null
  counts: { clients: number; invoices: number; proposals: number; income: number; expenses: number; payees: number }
}

export interface Client {
  id: number
  name: string
  email: string | null
  phone: string | null
  company: string | null
  address: string | null
  country: string | null
  notes: string | null
  created_at: string
  invoice_count?: number
  proposal_count?: number
  total_billed?: number
  outstanding?: number
}

export interface LineItem {
  id?: number
  description: string
  quantity: number | string
  unit_price: number | string
  amount?: number
}

export interface DocumentClientFields {
  client_id: number | null
  client_name: string
  client_email: string | null
  client_company: string | null
  client_address: string | null
}

export type InvoiceStatus = 'Draft' | 'Sent' | 'Paid' | 'Overdue' | 'Cancelled'

export interface Invoice extends DocumentClientFields {
  id: number
  invoice_number: string
  issue_date: string
  due_date: string
  currency: string
  subtotal: number
  tax_rate: number
  tax_amount: number
  discount: number
  total: number
  status: InvoiceStatus
  notes: string | null
  terms: string | null
  paid_date: string | null
  email_sent: number
  email_sent_at: string | null
  reminder_count: number
  proposal_id: number | null
  created_at: string
  items: LineItem[]
}

export type ProposalStatus = 'Draft' | 'Sent' | 'Accepted' | 'Declined' | 'Expired'

export interface Proposal extends DocumentClientFields {
  id: number
  proposal_number: string
  title: string
  summary: string | null
  issue_date: string
  valid_until: string
  currency: string
  subtotal: number
  tax_rate: number
  tax_amount: number
  discount: number
  total: number
  status: ProposalStatus
  notes: string | null
  terms: string | null
  email_sent: number
  sent_at: string | null
  decided_at: string | null
  invoice_id: number | null
  created_at: string
  items: LineItem[]
}

export interface ProposalStats {
  base_currency: string
  counts: Record<ProposalStatus, number>
  open_value: number
  accepted_value: number
  win_rate: number | null
}

export interface RevenueEntry {
  id: number
  client_id: number | null
  client_name: string
  project_name: string | null
  service_type: string | null
  invoice_number: string | null
  invoice_id: number | null
  invoice_date: string | null
  due_date: string | null
  amount: number
  currency: string
  /** 'Overdue' only appears on entries carried over from the previous system. */
  payment_status: 'Pending' | 'Paid' | 'Overdue'
  payment_method: string | null
  is_recurring: number
  billing_cycle: string | null
  auto_recorded: number
  notes: string | null
}

export interface Expense {
  id: number
  title: string
  category: string
  vendor: string | null
  amount: number
  currency: string
  payment_date: string | null
  payment_method: string | null
  is_recurring: number
  billing_cycle: string | null
  receipt_path: string | null
  /** Set on automatic rows: "payroll:2026-03:LKR" or "recurring:12:2026-03-01". */
  source: string | null
  notes: string | null
}

export interface RecurringPayment {
  id: number
  name: string
  type: 'Income' | 'Expense'
  category: string | null
  billing_cycle: string
  amount: number
  currency: string
  next_payment_date: string | null
  auto_renewal: number
  status: string
  client_vendor: string | null
  email: string | null
  reminder_days: number
  last_processed_date: string | null
  notes: string | null
}

/** A person on payroll (stored in the `employees` table). */
export interface Payee {
  id: number
  name: string
  position: string | null
  department: string | null
  email: string | null
  phone: string | null
  salary_type: string
  base_salary: number
  currency: string
  start_date: string | null
  status: 'Active' | 'Inactive'
  bank_details: string | null
  notes: string | null
}

export interface SalaryPayment {
  id: number
  employee_id: number | null
  employee_name: string
  position: string | null
  department: string | null
  salary_type: string
  base_salary: number
  bonuses: number
  deductions: number
  net_salary: number
  currency: string
  payment_month: string
  payment_date: string | null
  payment_method: string | null
  status: 'Pending' | 'Paid'
  slip_sent: number
  notes: string | null
}

export interface AppNotification {
  id: number
  type: 'info' | 'success' | 'warning' | 'critical'
  title: string
  message: string | null
  is_read: number
  created_at: string
}

export interface DashboardData {
  base_currency: string
  currency_symbol: string
  rates_updated_at: string | null
  stats: {
    monthRevenue: number; lastMonthRevenue: number; yearRevenue: number
    monthExpenses: number; lastMonthExpenses: number; yearExpenses: number
    monthSalaries: number; monthOpsExpenses: number
    monthProfit: number; lastMonthProfit: number; yearProfit: number
    profitMargin: number
    revenueGrowth: number | null; expenseGrowth: number | null; profitGrowth: number | null
    pendingInvoices: number; pendingInvoiceAmount: number
    overdueInvoices: number; overdueAmount: number
    draftInvoices: number
    accountsReceivable: number
    pendingSalaries: number; pendingSalaryAmount: number
    openProposals: number; openProposalAmount: number
    proposalWinRate: number | null
    cashBalance: number
  }
  chartData: { month: string; ym: string; revenue: number; expenses: number; profit: number }[]
  expenseBreakdown: { category: string; total: number }[]
  recentInvoices: Invoice[]
  overdueList: { id: number; invoice_number: string; client_name: string; total: number; currency: string; due_date: string; days_overdue: number }[]
  upcomingPayments: RecurringPayment[]
  recentProposals: Proposal[]
}

export interface BackupFile { name: string; size: number; created_at: string }

type Params = Record<string, string | number | undefined | null>
const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

// ── Endpoints ────────────────────────────────────────────────────────────────
// Every call resolves to the response body (not the axios response).

export const authApi = {
  login: (username: string, password: string) => data<{ user: User }>(api.post('/auth/login', { username, password })),
  logout: () => data<{ message: string }>(api.post('/auth/logout')),
  me: () => data<{ user: User }>(api.get('/auth/me')),
  changePassword: (current_password: string, new_password: string) =>
    data<{ message: string }>(api.post('/auth/change-password', { current_password, new_password })),
  updateProfile: (body: { name: string | null; email: string | null }) => data<{ user: User }>(api.put('/auth/profile', body)),
  sessions: () => data<SessionRow[]>(api.get('/auth/sessions')),
  logoutOthers: () => data<{ message: string }>(api.post('/auth/logout-others')),
}

export const userApi = {
  list: () => data<UserRow[]>(api.get('/users')),
  create: (body: { username: string; name?: string | null; email?: string | null; role: Role }) =>
    data<{ id: number; username: string; temporary_password: string }>(api.post('/users', body)),
  update: (id: number, body: { name?: string | null; email?: string | null; role?: Role; is_active?: boolean }) =>
    data<{ message: string }>(api.put(`/users/${id}`, body)),
  resetPassword: (id: number) => data<{ username: string; temporary_password: string }>(api.post(`/users/${id}/reset-password`)),
  unlock: (id: number) => data<{ message: string }>(api.post(`/users/${id}/unlock`)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/users/${id}`)),
  auditLog: () => data<AuditRow[]>(api.get('/users/audit-log')),
}

export const dashboardApi = {
  get: () => data<DashboardData>(api.get('/dashboard')),
}

export const clientApi = {
  list: (params?: Params) => data<Client[]>(api.get('/clients', { params })),
  get: (id: number) => data<Client & { invoices: Partial<Invoice>[]; proposals: Partial<Proposal>[] }>(api.get(`/clients/${id}`)),
  create: (body: Partial<Client>) => data<{ id: number }>(api.post('/clients', body)),
  update: (id: number, body: Partial<Client>) => data<{ message: string }>(api.put(`/clients/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/clients/${id}`)),
}

export interface DocumentBody extends DocumentClientFields {
  currency: string
  items: LineItem[]
  tax_rate: number | string
  discount: number | string
  notes?: string | null
  terms?: string | null
}

export const invoiceApi = {
  list: (params?: Params) => data<Invoice[]>(api.get('/invoices', { params })),
  get: (id: number) => data<Invoice>(api.get(`/invoices/${id}`)),
  create: (body: DocumentBody & { issue_date: string; due_date: string; status?: 'Draft' | 'Sent' }) =>
    data<{ id: number; invoice_number: string }>(api.post('/invoices', body)),
  update: (id: number, body: DocumentBody & { issue_date: string; due_date: string; status?: 'Draft' | 'Sent' | 'Cancelled' }) =>
    data<{ message: string; status: InvoiceStatus }>(api.put(`/invoices/${id}`, body)),
  /** Changes only the status (cancel, reopen); the document itself is left as it is. */
  setStatus: (id: number, status: 'Draft' | 'Sent' | 'Cancelled') =>
    data<{ message: string; status: InvoiceStatus }>(api.post(`/invoices/${id}/status`, { status })),
  delete: (id: number) => data<{ message: string }>(api.delete(`/invoices/${id}`)),
  send: (id: number) => data<{ emailSent: boolean; message: string }>(api.post(`/invoices/${id}/send`)),
  markPaid: (id: number, body?: { paid_date?: string; payment_method?: string }) =>
    data<{ message: string; warning: string | null }>(api.post(`/invoices/${id}/mark-paid`, body || {})),
  markUnpaid: (id: number) => data<{ message: string }>(api.post(`/invoices/${id}/mark-unpaid`)),
  duplicate: (id: number) => data<{ id: number; invoice_number: string }>(api.post(`/invoices/${id}/duplicate`)),
  pdfUrl: (id: number) => `/api/invoices/${id}/pdf`,
}

export const proposalApi = {
  list: (params?: Params) => data<Proposal[]>(api.get('/proposals', { params })),
  stats: () => data<ProposalStats>(api.get('/proposals/stats')),
  get: (id: number) => data<Proposal>(api.get(`/proposals/${id}`)),
  create: (body: DocumentBody & { title: string; summary?: string | null; issue_date: string; valid_until: string }) =>
    data<{ id: number; proposal_number: string }>(api.post('/proposals', body)),
  update: (id: number, body: DocumentBody & { title: string; summary?: string | null; issue_date: string; valid_until: string }) =>
    data<{ message: string }>(api.put(`/proposals/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/proposals/${id}`)),
  send: (id: number) => data<{ emailSent: boolean; message: string }>(api.post(`/proposals/${id}/send`)),
  setStatus: (id: number, status: 'Draft' | 'Sent' | 'Accepted' | 'Declined') =>
    data<{ message: string }>(api.post(`/proposals/${id}/status`, { status })),
  convert: (id: number) => data<{ invoice_id: number; invoice_number: string }>(api.post(`/proposals/${id}/convert`)),
  duplicate: (id: number) => data<{ id: number; proposal_number: string }>(api.post(`/proposals/${id}/duplicate`)),
  pdfUrl: (id: number) => `/api/proposals/${id}/pdf`,
}

export const revenueApi = {
  list: (params?: Params) => data<RevenueEntry[]>(api.get('/revenue', { params })),
  stats: (params?: Params) => data<{
    base_currency: string
    byClient: { client_name: string; total: number; count: number }[]
    byService: { service_type: string; total: number }[]
    byStatus: { payment_status: string; count: number; total: number }[]
  }>(api.get('/revenue/stats', { params })),
  create: (body: Partial<RevenueEntry>) => data<{ id: number }>(api.post('/revenue', body)),
  update: (id: number, body: Partial<RevenueEntry>) => data<{ message: string; limited?: boolean }>(api.put(`/revenue/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/revenue/${id}`)),
}

export const expenseApi = {
  list: (params?: Params) => data<Expense[]>(api.get('/expenses', { params })),
  categories: () => data<string[]>(api.get('/expenses/categories')),
  /** multipart/form-data; optional file field `receipt`; `remove_receipt=1` on update drops the stored file. */
  // Longer timeout: a 5 MB receipt on a slow connection needs more than the default 30 s.
  create: (body: FormData) => data<{ id: number }>(api.post('/expenses', body, { timeout: 120000 })),
  update: (id: number, body: FormData) => data<{ message: string }>(api.put(`/expenses/${id}`, body, { timeout: 120000 })),
  delete: (id: number) => data<{ message: string }>(api.delete(`/expenses/${id}`)),
}

export const recurringApi = {
  list: (params?: Params) => data<RecurringPayment[]>(api.get('/recurring', { params })),
  create: (body: Partial<RecurringPayment>) => data<{ id: number }>(api.post('/recurring', body)),
  update: (id: number, body: Partial<RecurringPayment>) => data<{ message: string }>(api.put(`/recurring/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/recurring/${id}`)),
  /** Pause or resume without touching anything else on the item. */
  setStatus: (id: number, status: 'Active' | 'Paused') =>
    data<{ message: string }>(api.post(`/recurring/${id}/status`, { status })),
  /**
   * Records the income/expense for this occurrence (unless record=false) and moves to the next date.
   * Always send occurrence_date (the due date shown to the user): the server answers 409 with
   * code OCCURRENCE_CHANGED when that occurrence was already settled elsewhere, and 409 with
   * code ALREADY_RECORDED when the money for it is already in the books.
   */
  process: (id: number, body?: { record?: boolean; paid_date?: string; occurrence_date?: string }) =>
    data<{ message: string; next_payment_date: string | null; recorded: { type: 'expense' | 'income'; id: number } | null }>(
      api.post(`/recurring/${id}/process`, body || {})),
}

export const payeeApi = {
  list: () => data<Payee[]>(api.get('/employees')),
  departments: () => data<string[]>(api.get('/employees/departments')),
  create: (body: Partial<Payee>) => data<{ id: number }>(api.post('/employees', body)),
  update: (id: number, body: Partial<Payee>) => data<{ message: string }>(api.put(`/employees/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/employees/${id}`)),
}

export const salaryApi = {
  list: (params?: Params) => data<SalaryPayment[]>(api.get('/salaries', { params })),
  create: (body: Partial<SalaryPayment>) => data<{ id: number }>(api.post('/salaries', body)),
  update: (id: number, body: Partial<SalaryPayment>) => data<{ message: string }>(api.put(`/salaries/${id}`, body)),
  delete: (id: number) => data<{ message: string }>(api.delete(`/salaries/${id}`)),
  generate: (payment_month: string) => data<{ created: number; skipped: number; message: string }>(api.post('/salaries/generate', { payment_month })),
  payAll: (payment_month: string, payment_date?: string) =>
    data<{ count: number; message: string }>(api.post('/salaries/pay-all', { payment_month, payment_date })),
  clearPending: (month: string) => data<{ count: number }>(api.delete('/salaries/pending', { params: { month } })),
  pay: (id: number, payment_date?: string) => data<{ message: string; slipSent: boolean }>(api.post(`/salaries/${id}/pay`, { payment_date })),
  unpay: (id: number) => data<{ message: string }>(api.post(`/salaries/${id}/unpay`)),
  sendSlip: (id: number, email?: string) => data<{ message: string }>(api.post(`/salaries/${id}/send-slip`, { email })),
  pdfUrl: (id: number) => `/api/salaries/${id}/pdf`,
}

export const reportApi = {
  pl: (params?: Params) => data<any>(api.get('/reports/pl', { params })),
  revenue: (params?: Params) => data<any>(api.get('/reports/revenue', { params })),
  expenses: (params?: Params) => data<any>(api.get('/reports/expenses', { params })),
  payroll: (params?: Params) => data<any>(api.get('/reports/payroll', { params })),
  cashflow: (params?: Params) => data<any>(api.get('/reports/cashflow', { params })),
  receivables: () => data<any>(api.get('/reports/receivables')),
}

export const currencyApi = {
  rates: () => data<{ base: string; updated_at: string | null; rates: { currency: string; rate: number }[]; supported: string[] }>(api.get('/currency/rates')),
  refresh: () => data<{ base: string; updated_at: string | null; rates: { currency: string; rate: number }[]; live: boolean }>(api.post('/currency/refresh')),
}

export const notificationApi = {
  list: () => data<AppNotification[]>(api.get('/notifications')),
  unreadCount: () => data<{ count: number }>(api.get('/notifications/unread-count')),
  markRead: (id: number) => data<{ message: string }>(api.put(`/notifications/${id}/read`)),
  markAllRead: () => data<{ message: string }>(api.put('/notifications/read-all')),
  delete: (id: number) => data<{ message: string }>(api.delete(`/notifications/${id}`)),
  clearRead: () => data<{ count: number }>(api.delete('/notifications')),
}

export const settingsApi = {
  get: () => data<Settings>(api.get('/settings')),
  /** smtp_pass: a non-empty string replaces it, null clears it, omitted leaves it unchanged. */
  update: (body: Partial<Settings> & { smtp_pass?: string | null }) => data<Settings>(api.put('/settings', body)),
  uploadLogo: (file: File) => {
    const fd = new FormData()
    fd.append('logo', file)
    return data<{ logo_path: string }>(api.post('/settings/logo', fd))
  },
  removeLogo: () => data<{ message: string }>(api.delete('/settings/logo')),
  testEmail: (to?: string) => data<{ message: string }>(api.post('/settings/test-email', { to })),
  system: () => data<SystemInfo>(api.get('/settings/system')),
}

export const backupApi = {
  list: () => data<{ backups: BackupFile[]; keep: number }>(api.get('/backup')),
  create: () => data<{ name: string; message: string }>(api.post('/backup')),
  delete: (name: string) => data<{ message: string }>(api.delete(`/backup/${encodeURIComponent(name)}`)),
  restoreStored: (name: string) => data<{ restarting: boolean; message: string }>(api.post(`/backup/${encodeURIComponent(name)}/restore`)),
  restoreUpload: (file: File) => {
    const fd = new FormData()
    fd.append('backup', file)
    return data<{ restarting: boolean; message: string }>(api.post('/backup/restore', fd, { timeout: 120000 }))
  },
  /** Fresh copy of the live database. */
  downloadUrl: () => '/api/backup/download',
  storedUrl: (name: string) => `/api/backup/${encodeURIComponent(name)}/download`,
}

export default api
