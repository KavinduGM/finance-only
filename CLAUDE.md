# GroovyMark Finance

Finance system for one company (proposals, invoices, income, expenses, recurring payments, simple payroll, reports). Express + better-sqlite3 backend in `backend/`, React + TypeScript + Tailwind frontend in `frontend/`, deployed as one Docker container on Dokploy.

**Read [HANDOVER.md](HANDOVER.md) first.** It holds the history, the owner's decisions, the architecture, the money rules and the open items. [README.md](README.md) covers setup and deployment.

## Owner decisions (do not reverse without asking)

- Finance only. HR, employee logins, tasks, projects, the client portal and all AI/OpenAI features were removed on purpose; do not bring them back.
- Payroll stays simple: people and monthly payments, no HR.
- SQLite in a volume, not PostgreSQL. Deployment is Dokploy.
- Email goes through Resend. The key and sender come only from environment variables (`RESEND_API_KEY`, `EMAIL_FROM`), as does the first admin login (`ADMIN_USERNAME`, `ADMIN_PASSWORD`). No secret in code, the database or the UI.

## Repository rules

- Push to this repository (`github.com/KavinduGM/finance-only`, branch `main`). Never push to or merge from `github.com/KavinduGM/finance`: that is the original system, and its history contains hard-coded credentials.
- This repository may be public. Never commit `backend/.env`, `backend/data/`, `*.db` files, keys or passwords. Check `git diff --cached` for secrets before every commit.
- Before pushing, both must be clean:
  - `cd frontend && npx tsc --noEmit`
  - `npm test` (138 end-to-end checks plus 8 restore checks, on a throwaway database)

## Code conventions

- **Backend routes:**
  - Handlers are `wrap((req, res) => …)`. Expected problems throw `HttpError(status, message)`; never `try/catch → res.status(500)`.
  - Every input goes through the `v.*` validators in `lib/http.js`.
  - Several writes share one `db.transaction`. Emails are sent after the commit and never fail the request.
  - Calendar dates come from `today()` / `shiftDate()` in `lib/dates.js` (business timezone), never SQLite `date('now')`.
  - Money is rounded with `round2()`. Totals across rows are converted with `baseConverter()`, never `SUM()` across currencies.
  - The automatic income and expense rows (invoice → income, salaries → expense, recurring → income or expense) must stay in step with their source. See HANDOVER.md section 4.
- **Frontend:**
  - Colours come only from the theme tokens and component classes in `src/index.css`; no fixed Tailwind colours, no hex.
  - Shared pieces come from `components/ui`.
  - Every request is in try/catch with `toast.error(errorMessage(err, …))`. Confirmations use `useConfirm()`.
  - Money is shown with `<Money>` / `money()`. Different currencies are never added together.
  - Charts use only the components in `components/ui/charts.tsx`.
- Plain-English user-facing text, no emoji. Comments only where the reason is not obvious.
