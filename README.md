# GroovyMark Finance

A finance system for one company: proposals, invoices, income, expenses, recurring payments, simple payroll and reports.

- **Backend:** Node.js + Express, SQLite database (one file)
- **Frontend:** React + TypeScript + Tailwind, served by the backend in production
- **Deployment:** one Docker container, one data volume

## What is in it

| Area | What it does |
|---|---|
| Proposals | Numbered quotes with line items, PDF, email, accept/decline, convert to invoice |
| Invoices | Draft → Sent → Paid / Overdue, PDF, email, payment reminders; a paid invoice records income automatically |
| Income | Money received, from invoices or entered by hand |
| Expenses | Costs with categories and receipt uploads |
| Recurring | Subscriptions and retainers; recording a payment adds the income or expense and moves the date on |
| Payroll | A list of people and their monthly payments; paid salaries become an expense automatically |
| Reports | Profit & loss, income, expenses, cash flow, receivables ageing, payroll, each with CSV export |
| Settings | Company details, document defaults, email (SMTP), users and passwords, backups |

Amounts keep the currency they were entered in. Totals, charts and reports are converted to the company's base currency (Settings → Company) using exchange rates refreshed every four hours.

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm run setup
```

```bash
npm run dev
```

Open http://localhost:5173. The sign-in is in `backend/.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). If `ADMIN_PASSWORD` is empty, a random password is printed once in the terminal the first time the server starts, and you are asked to replace it when you sign in.

Local data lives in `backend/data/` (ignored by git).

## Deploy with Dokploy

### 1. Put the code in a Git repository

Push this folder to a repository your Dokploy server can read (GitHub, GitLab, Gitea…). Do not commit `backend/.env` or `backend/data/`; both are already ignored.

### 2. Create the application

In Dokploy: **Create Service → Application**, connect the repository and branch, then:

| Setting | Value |
|---|---|
| Build Type | `Dockerfile` |
| Dockerfile Path | `Dockerfile` |
| Docker Context Path | `.` |

### 3. Add the data volume

**Advanced → Volumes → Add → Volume Mount**

| Field | Value |
|---|---|
| Volume Name | `finance_data` |
| Mount Path | `/data` |

This volume holds the database, uploaded receipts, the logo and the automatic backups. Without it, every redeploy starts with an empty system.

### 4. Set the environment

**Environment** tab:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<a password of 10+ characters with letters and numbers>
APP_URL=https://finance.your-domain.com
APP_TIMEZONE=Asia/Colombo
RESEND_API_KEY=<your Resend API key>
EMAIL_FROM=GroovyMark Finance <finance@your-verified-domain.com>
```

`ADMIN_USERNAME` and `ADMIN_PASSWORD` are read only on the very first start, when the database has no users. After that, passwords are managed inside the app. If you leave `ADMIN_PASSWORD` empty, a random one is printed once in the deployment log.

### 5. Add the domain

**Domains → Add Domain**

| Field | Value |
|---|---|
| Host | `finance.your-domain.com` |
| Container Port | `3001` |
| HTTPS | on |
| Certificate | `letsencrypt` |

Point the domain's DNS A record at the server first so the certificate can be issued.

### 6. Deploy

Press **Deploy**. When the build finishes, open the domain and sign in.

Then, in the app:

1. **Settings → Company**: company details, logo and base currency.
2. **Settings → Invoices & proposals**: number prefixes, default terms and the bank details printed on invoices.
3. **Settings → Email**: check that it says email is sent through Resend, then **Send test email**.

### Using Docker Compose instead

`docker-compose.yml` does the same with one file. In Dokploy choose **Create Service → Compose**, set the same environment variables, and add the domain on service `finance`, port `3001`. On a laptop, uncomment the `ports` lines in the file and run:

```bash
docker compose up -d --build
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | First administrator (first start only) |
| `ADMIN_PASSWORD` | empty | First administrator's password (first start only) |
| `APP_URL` | empty | Public address, e.g. `https://finance.example.com` |
| `APP_TIMEZONE` | `Asia/Colombo` | Business timezone for dates, due dates and the 9 AM reminder emails |
| `PORT` | `3001` | Port the server listens on |
| `DATA_DIR` | `/data` in Docker, `backend/data` locally | Where the database, uploads and backups are stored |
| `SESSION_DAYS` | `7` | How long a sign-in lasts |
| `BACKUP_KEEP` | `14` | How many automatic daily backups to keep |
| `RESEND_API_KEY` | empty | Resend API key used to send all email |
| `EMAIL_FROM` | empty | Sender, `Name <address>` or just the address, on a domain verified in Resend |
| `EMAIL_REPLY_TO` | empty | Where replies go (defaults to the company email) |
| `EMAIL_DISABLED` | `false` | `true` stops all outgoing email, for a demo or test copy running on real data |
| `TRUST_PROXY` | `1` in Docker, `0` locally | Number of reverse proxies in front of the app. Leave at `1` on Dokploy; set `0` if the port is exposed directly |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | empty | Optional SMTP mailbox, used only when no Resend key is set and Settings → Email is blank |

## Email

Email goes through [Resend](https://resend.com). It sends invoices and proposals (with the PDF attached), payment reminders before and after the due date, salary slips, and reminders for recurring payments.

1. In Resend, add and verify your domain (**Domains → Add Domain**, then add the DNS records it shows).
2. Create an API key (**API Keys → Create API Key**, "Sending access" is enough).
3. Set `RESEND_API_KEY` and `EMAIL_FROM` in the environment and redeploy. `EMAIL_FROM` must use the verified domain, for example `GroovyMark Finance <finance@groovymark.com>`.
4. In the app, open **Settings → Email** and press **Send test email**.

The key stays in the server environment. It is never written to the database, never included in a backup and never sent to the browser; the Email page only shows that Resend is active and which address it sends from.

Without a key, the system falls back to an SMTP mailbox if one is entered in **Settings → Email**. With neither, documents can still be downloaded as PDF.

## Users and passwords

- Sign-in uses a session cookie that JavaScript cannot read; passwords are stored as bcrypt hashes.
- **Settings → Account**: change your password, see signed-in devices, sign out other devices.
- **Settings → Users** (administrators): add people, change roles, reset a password, unlock an account. New accounts and reset passwords get a temporary password that is shown once and must be replaced at the next sign-in.
- Roles: **Administrator** can do everything. **Staff** can do everything except manage users, settings and backups.
- Five wrong passwords from one address hold that address back for 15 minutes; other addresses are unaffected, so nobody else can lock you out.

### Locked out completely

Open a terminal in the running container (Dokploy: the application's **Terminal**) and run:

```bash
node backend/src/scripts/reset-password.js admin
```

It prints a temporary password for that user. Run it without a username to list the accounts.

## Backups

- An automatic backup of the database is made every day at 02:00 and the last 14 are kept in `/data/backups`.
- **Settings → Backup** lets an administrator download a backup, create one on the server, and restore from a stored backup or an uploaded `.db` file.
- A restore first saves the current database as a `pre-restore-…` backup, then restarts the application.
- The database backup does not contain uploaded files. Receipts and the logo are in `/data/uploads` on the same volume; to protect those as well, back up the `finance_data` volume from Dokploy.

## Moving data from the previous system

Either upload the old `financial.db` in **Settings → Backup → Restore from file**, or copy it into the data volume as `/data/financial.db` before the first start. On start the system:

1. saves a full copy as `/data/backups/pre-upgrade-….db`,
2. keeps clients, invoices, income, expenses, recurring payments, payroll people and payments,
3. removes the tables of the retired HR, task, client-portal and AI modules,
4. keeps the old admin username but not its password: the account starts with `ADMIN_PASSWORD` (or a generated password printed once in the log).

The old database also carries the old mailbox settings, with payment reminders switched on. If the copy is only for a demo or a test, set `EMAIL_DISABLED=true` so it cannot email real clients.

Receipts and the logo from the old system go in `/data/uploads/receipts` and `/data/uploads/logos`.
