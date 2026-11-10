# Project handover

Everything needed to pick this project up on a new machine or in a new chat: what was built, why, how it works, how it was tested, and what is still open. Last updated 10 Nov 2026.

For setting the system up and deploying it, see [README.md](README.md). This file is the background.

---

## 1. What this is

**GroovyMark Finance** is a finance system for one company: proposals, invoices, income, expenses, recurring payments, simple payroll and reports, with users and passwords, email and backups. It is deployed as one Docker container on a VPS through **Dokploy**, with the data in one volume.

It was rebuilt on **4 Oct 2026** from an older, larger GroovyMark system that also had HR, an employee portal, task management, a client portal and AI features. Only the finance part was kept, then redesigned, extended, audited and fixed.

| | |
|---|---|
| This repository | https://github.com/KavinduGM/finance-only (branch `main`) |
| Original system | https://github.com/KavinduGM/finance (private, branch `company`). Reference only: **never push this project there** |
| History | This repository was started from a single fresh commit on purpose. The original repository's history contains hard-coded credentials, so it was not carried over |

---

## 2. Decisions the owner made

These came from the owner and should not be reversed without asking.

| Topic | Decision |
|---|---|
| Scope | Finance only: proposals, invoices, income, expenses, recurring payments, clients, reports, dashboard, currencies, settings |
| Removed | HR, employee portal, employee logins, leave, KPIs, birthdays, tasks, task-manager role, projects, todos, client portal (client logins, payment slips, online payment gateway), **all AI / OpenAI features** |
| Payroll | Kept, but simplified: a plain list of people and their monthly salary payments. No HR features |
| Proposals | New module (did not exist before). Modelled on invoices; a proposal converts into an invoice |
| Database | SQLite (one file) in a persistent volume, with backup download and restore. Chosen over PostgreSQL |
| Hosting | The owner's VPS, deployed with Dokploy |
| Email | **Resend**. The API key and sender address are set only in environment variables, never in code, the database or the UI. SMTP stays as a fallback |
| Credentials | The first admin login comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables |
| Look | Refresh the existing screens to look professional, minimal and futuristic. Same structure, not a ground-up redesign |

---

## 3. What was done, in order

1. **Cloned and mapped the original system.** A multi-agent read of every file classified each section as finance or non-finance and found every dependency between them, so the cut could be clean. Main findings: the old admin login was cosmetic (no API route checked it), real credentials were hard-coded in the source, and several finance flows had money bugs.
2. **Removed the non-finance modules** (about 30 files) and their database tables.
3. **Rebuilt the backend foundation:** new schema with an automatic upgrade path for old databases, real authentication, security middleware, validation helpers, money and date helpers, backups.
4. **Rebuilt every backend route and service** against a written contract (parallel agents), then integrated and tested.
5. **Built a new frontend design system** (dark and light themes, components, charts) and rebuilt all ten pages on it.
6. **Added Resend email** configured from environment variables.
7. **Packaged for Dokploy:** Dockerfile, compose file, container start script, README.
8. **Audited the whole system** with seven independent reviewers before the client demo: 52 findings (2 critical, 6 high, 19 medium, 25 low). All critical, high and medium findings were fixed, plus nearly all low ones (see section 10).
9. **Tested end to end:** 138 API checks plus an 8-check restore test, all passing, and every screen checked in a browser in both themes and at phone width.
10. **Pushed** to the new repository as one fresh commit.
11. **10 Nov 2026:** added this handover, `CLAUDE.md`, and the test suite (`npm test`) to the repository, for the move to a new machine.

---

## 4. How it is built

### Stack

| Part | Technology |
|---|---|
| Backend | Node.js 20+ (22 in Docker), Express 4, better-sqlite3 (synchronous SQLite), CommonJS |
| PDFs | pdfkit with the built-in Helvetica fonts |
| Email | Resend REST API (plain `fetch`), or nodemailer for SMTP |
| Scheduled jobs | node-cron, in the business timezone |
| Frontend | React 18, TypeScript, Vite 5, Tailwind 3, react-router 6, recharts 2, lucide-react, react-hot-toast |
| Fonts | Inter and JetBrains Mono, bundled (no external requests) |
| Production | Express serves the built frontend and the API on one port (3001) |

### Folders

```
backend/
  src/
    server.js            app setup, route mounting, static frontend, shutdown
    config.js            every environment variable, read in one place
    database.js          schema, column upgrades, old-database migration, restore swap-in
    lib/                 http.js (wrap, HttpError, validators v.*), money.js, dates.js,
                         settings.js, notify.js, numbering.js
    middleware/          auth.js (requireAuth, requireAdmin), security.js (headers,
                         same-origin check, rate limit), errors.js
    routes/              one file per API area (see section 5)
    services/            authService, backupService, currencyService, emailService,
                         invoiceService (shared by invoices and proposals), pdfService,
                         schedulerService
    scripts/             reset-password.js (emergency), container-start.js (Docker entry)
frontend/
  src/
    App.tsx              routes and the sign-in guard
    services/api.ts      typed API client and every entity type
    context/             AuthContext, SettingsContext (base currency, money()), ThemeContext
    components/ui/       Modal, Confirm, primitives (StatCard, Money, StatusBadge, Tabs...),
                         LineItemsEditor, ClientFields, charts
    components/Layout/   Sidebar, Header, Layout
    pages/               one file per screen; settings/ holds the Settings tabs
    lib/                 format.ts (money, dates), files.ts (CSV, PDF links)
    index.css            theme tokens and component classes
tests/                   e2e.mjs (138 checks), restore.mjs (8 checks)
scripts/                 dev.js (runs API + web app), test.js (npm test)
Dockerfile, docker-compose.yml, README.md, HANDOVER.md, CLAUDE.md
```

### Database tables

`settings` (one row), `users`, `sessions`, `audit_log`, `counters` (document numbers), `clients`, `proposals`, `proposal_items`, `invoices`, `invoice_items`, `revenue` (shown as **Income**), `expenses`, `employees` (payroll people, old table name kept), `salary_payments`, `recurring_payments`, `notifications`, `notification_keys`, `exchange_rates`.

Table and column names match the original system, so an old `financial.db` upgrades in place. On start, `database.js` adds any missing columns, and when it finds tables of the removed modules it first saves a full copy (`backups/pre-upgrade-*.db`), then drops them.

### Rules the money logic follows

- **Automatic entries stay in step with their source:**
  - Marking an invoice paid creates one income entry linked by `invoice_id`. Marking it unpaid or deleting it removes that entry.
  - Paid salaries create one expense per payroll month, per currency and per month the money was paid (`source = payroll:<month>:<CUR>:<paid month>`).
  - Recording a recurring payment adds the income or expense (`source = recurring:<id>:<date>`, unique).
  - These automatic rows cannot be edited from the Income or Expenses pages.
- **Currencies are never mixed.** Each amount keeps its own currency. Totals, charts and reports convert row by row into the company's base currency (Settings → Company), using exchange rates refreshed every 4 hours.
- **Totals:** the discount comes off before tax. Unit prices allow at most two decimals. Every write is rounded to the cent.
- **Document numbers** (`INV-0001-2026`, `PRO-0001-2026`) come from a counter that only moves forward, so a deleted number is never reused.
- **Dates** are calendar dates in the business timezone (`APP_TIMEZONE`, default Asia/Colombo), never UTC "now". Dates outside 2000–2100 are refused.
- **Statuses:**
  - Invoices: Draft → Sent → Paid / Overdue / Cancelled. A paid invoice must be marked unpaid before it can be edited.
  - Proposals: Draft → Sent → Accepted / Declined / Expired. An accepted proposal can be converted into an invoice once.

### Scheduled jobs (`schedulerService.js`)

| Job | When | What |
|---|---|---|
| refreshRates | every 4 h | exchange rates from two free APIs |
| markOverdue | hourly | Sent invoices past due become Overdue, with a notification |
| expireProposals | hourly | Sent proposals past their date become Expired |
| sendInvoiceReminders | 09:00 | email reminders before the due date and every 3 days when overdue (max 6) |
| sendRecurringReminders | 09:00 | reminders for recurring payments coming due |
| lowCashCheck | 00:10 | weekly alert when cash is below one month of average expenses |
| backup | 02:00 | database backup, keeps the last `BACKUP_KEEP` (14) |
| housekeeping | 03:00 | removes expired sessions, old read notifications and old audit-log rows |

The jobs run only while the server is running, and running one late or twice is safe.

---

## 5. API overview

Every route is under `/api` and needs a signed-in user, except `POST /api/auth/login`, `POST /api/auth/logout` and `GET /api/health`. `users` and `backup` are admin-only, as are settings changes.

| Area | Main endpoints |
|---|---|
| auth | login, logout, me, change-password, profile, sessions, logout-others |
| users | list, create (returns a one-time temporary password), update, reset-password, unlock, delete, audit-log |
| clients | CRUD with billed/outstanding totals; detail with recent invoices and proposals |
| proposals | CRUD, stats, send, status, convert (to invoice), duplicate, pdf |
| invoices | CRUD, send, mark-paid, mark-unpaid, status (cancel/reopen), duplicate, pdf |
| revenue | income CRUD, stats |
| expenses | CRUD with receipt upload (PDF/JPEG/PNG/WebP, 5 MB), categories |
| recurring | CRUD, process (record a payment), status (pause/resume) |
| employees, salaries | payroll people; payments, generate month, pay, pay-all, unpay, slip email, slip pdf |
| dashboard, reports | dashboard; pl, revenue, expenses, payroll, cashflow, receivables |
| currency, notifications | rates/refresh; bell list, read, clear |
| settings | get/update, logo, test-email, system info (shows which email provider is active, never the key) |
| backup | list, create, download, restore (stored or uploaded), delete |

The full behaviour of each endpoint is in the route files. `frontend/src/services/api.ts` lists every call and its types.

---

## 6. Frontend

- **Routes:** `/login`, `/change-password`, then `/dashboard`, `/proposals`, `/invoices`, `/clients`, `/income`, `/expenses`, `/recurring`, `/payroll`, `/reports`, `/settings`. The old addresses `/revenue` and `/salaries` redirect.
- **Settings tabs:**
  - Account (profile, password, signed-in devices)
  - Company (details, logo, base currency, exchange rates)
  - Documents (invoice and proposal prefixes, terms, bank details)
  - Email (active provider, SMTP fallback, test email)
  - Automation (reminders, overdue marking, low-cash alert)
  - Users (accounts, roles, security log)
  - Backup (download, create, restore, system info)

  Staff users see only Account.
- **Design:** dark by default, light available from the header. All colours are theme tokens defined in `src/index.css` and exposed to Tailwind. Use them instead of fixed Tailwind colours, and use the component classes (`card`, `btn-primary`, `input`, `table`, `badge-*`...). Money is shown with `<Money>` or `money()` in the mono tabular font.
- **Charts:** income is always green, expenses always orange, a third series blue. The colours were checked for colour-blind separation in both themes. Only `TrendChart`, `ColumnChart` and `BarList` from `components/ui/charts.tsx` are used, with no pie charts and no dual axes.
- **Behaviour rules:**
  - Every data view has loading, empty and error states.
  - Every request is in try/catch with a toast.
  - Confirmations use `useConfirm()`, never `window.confirm`.
  - Buttons are disabled while their request runs.
  - Different currencies are never added together in the UI.

---

## 7. Security model

- **Sessions:** a random token in an HttpOnly, SameSite=Strict cookie, marked Secure behind HTTPS. Only a hash of the token is stored. Sessions are revoked on password change, reset, deactivation and restore.
- **Passwords:** bcrypt (cost 12), at least 10 characters with letters and numbers, not containing the username. New and reset accounts get a temporary password that must be replaced at first sign-in.
- **Login protection:** five wrong passwords from one address hold that address back for 15 minutes, so someone else cannot lock the owner out. An account-wide pause after 30 failures acts as a backstop. There is also a per-address request limit on login. These counters live in memory and reset on restart.
- **Requests:**
  - Cross-site requests are refused by an Origin check, on top of the SameSite cookie.
  - A strict Content-Security-Policy and the usual security headers are set.
  - Uploads and receipts are served only to signed-in users.
  - The error handler hides internal details in production.
- **Proxy:** `TRUST_PROXY=1` in Docker for Dokploy's Traefik, 0 locally, so a client cannot fake its address.
- **Secrets:** the Resend key, SMTP password and password hashes are never sent to the browser or written to logs.
- **Old databases:** a database from the old system keeps its admin username but not the old password; the account starts with `ADMIN_PASSWORD`. Set `EMAIL_DISABLED=true` on any demo or test copy that runs on real data.

---

## 8. Running it on a new machine

```bash
git clone https://github.com/KavinduGM/finance-only.git "Finance System"
```

```bash
cd "Finance System" && npm run setup
```

Then create `backend/.env` from `backend/.env.example`:

```
NODE_ENV=development
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<choose one: 10+ characters, letters and numbers, not containing "admin">
APP_TIMEZONE=Asia/Colombo
RESEND_API_KEY=<optional, to send real email locally>
EMAIL_FROM=<sender on your verified Resend domain>
```

```bash
npm run dev
```

Open http://localhost:5173.

**Not in git, so not on the new machine unless copied by hand:**

- `backend/.env`: your local settings and secrets.
- `backend/data/`: the local database, uploads and backups. Copy this folder only if you need the local test data.
- The old machine's Claude chat history and memory. `CLAUDE.md` and this file replace them.

---

## 9. Testing

```bash
npm test
```

This starts the API on a throwaway database, runs `tests/e2e.mjs` (138 checks across every area), then `tests/restore.mjs` (8 checks, including a hard kill between staging a restore and restarting), and deletes everything afterwards. It ignores `backend/.env`, so no real email is sent. It builds the frontend first if `frontend/dist` is missing.

Before every push, run:

```bash
cd frontend && npx tsc --noEmit
```

and `npm test`. Both must be clean.

---

## 10. Audit results (4 Oct 2026)

**Fixed:**

| Severity | Finding |
|---|---|
| Critical | Restoring a backup could lose everything since the last restart, and the "before a restore" copy could be empty (SQLite write-ahead log not included) |
| High | A late salary payment moved the whole month's payroll into a later month |
| High | A stale "record payment" dialog could record a recurring payment twice |
| High | The account menu (Sign out) and notifications panel could not be clicked |
| High | The old mailbox password was in the repository history (solved by the fresh repository) |
| Medium | 19 items, including: the admin could be locked out by anyone; the old default admin password carried over; 3-decimal prices silently rounded; overflowing totals; edits blocked by deleted clients; reminders not restarting after a due-date change; a malformed PNG logo could crash the server; overlapping backup downloads; unsaved invoice forms discarded without warning; years like 0026 accepted |
| Low | Nearly all of the 25 |

**Not fixed:**

- Sinhala and Tamil text prints as "?" on PDFs: the built-in Helvetica font covers only Latin characters. The fix is to bundle Unicode fonts (for example Noto Sans, Noto Sans Sinhala, Noto Sans Tamil) and register them in `pdfService.js`.
- Resend errors are reported clearly but not retried automatically.

---

## 11. Open items and things to check

| Item | Status |
|---|---|
| Repository visibility | Was **public** on 10 Nov 2026. The owner plans to make it private after deploying: GitHub → Settings → General → Change visibility |
| Docker image | Never built on the development machine (no Docker there). The first build is the Dokploy one: check its build log |
| Real email through Resend | Tested only with the network call stubbed. After deploy: Settings → Email → Send test email |
| Old mailbox password | It is in the original repository's history. Change it at the mail host |
| Country blocking | None in this repository. If access is limited by country, it is set up outside the code (VPS firewall, Traefik middleware in Dokploy, or a CDN such as Cloudflare); record it here when it exists |
| Unicode PDF fonts | Open (see section 10) |
| Single instance only | SQLite, the in-memory login counters and the scheduler assume one running container. Do not scale the service to more than one replica |
| Demo data | A new deployment starts empty. A seed script for demos does not exist yet |

Possible next steps: demo seed script, Unicode PDF fonts, a GitHub Actions workflow running `npm test` on every push, off-site copies of the `/data` volume (Dokploy volume backups to S3).

---

## 12. Deployment notes (Dokploy)

The full steps are in [README.md](README.md#deploy-with-dokploy). In short:

1. Create an Application, build type `Dockerfile`.
2. Add a Volume Mount: `finance_data` → `/data`.
3. Set the environment variables (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `APP_URL`, `APP_TIMEZONE`, `RESEND_API_KEY`, `EMAIL_FROM`).
4. Add the domain with container port `3001` and HTTPS with Let's Encrypt.

The container starts as root only long enough to make `/data` writable, then runs as the `node` user. It restarts itself after a restore.

Locked out completely? Open a terminal in the container and run:

```bash
node backend/src/scripts/reset-password.js admin
```
