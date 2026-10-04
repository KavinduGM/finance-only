import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { ImageOff, RefreshCw, Trash2, Upload } from 'lucide-react'
import { currencyApi, settingsApi } from '../../services/api'
import type { Settings } from '../../services/api'
import { ErrorState, Field, Spinner, TableSkeleton, useConfirm } from '../../components/ui'
import { useTheme } from '../../context/ThemeContext'
import { errorMessage, formatDateTime, SUPPORTED_CURRENCIES, symbolFor } from '../../lib/format'
import { EMAIL_PATTERN, Notice, SaveBar, Section, textOrNull, useSettingsForm } from './shared'
import type { SettingsTabProps } from './shared'

const CURRENCY_NAMES: Record<string, string> = {
  LKR: 'Sri Lankan rupee', USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', AUD: 'Australian dollar',
  SGD: 'Singapore dollar', INR: 'Indian rupee', CAD: 'Canadian dollar', JPY: 'Japanese yen',
}

const toForm = (s: Settings) => ({
  company_name: s.company_name || '',
  company_email: s.company_email || '',
  company_phone: s.company_phone || '',
  company_website: s.company_website || '',
  company_tax_id: s.company_tax_id || '',
  company_address: s.company_address || '',
  currency: s.currency || 'LKR',
})

type Form = ReturnType<typeof toForm>
type Errors = Partial<Record<keyof Form, string>>

/** Company details and base currency, with the logo and the exchange rates alongside. */
export default function CompanyTab({ settings, onSaved }: SettingsTabProps) {
  const confirm = useConfirm()
  const { form, set, changed, dirty, discard, adopt } = useSettingsForm(settings, toForm)
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    set(key, value)
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  // A currency saved by an older version stays selectable instead of silently changing.
  const currencies: string[] = [...SUPPORTED_CURRENCIES]
  if (!currencies.includes(form.currency)) currencies.unshift(form.currency)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return

    const problems: Errors = {}
    if (changed.includes('company_name') && !form.company_name.trim()) problems.company_name = 'Enter the company name'
    const address = form.company_email.trim()
    if (changed.includes('company_email') && address && !EMAIL_PATTERN.test(address)) {
      problems.company_email = 'Enter a valid email address'
    }
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    if (changed.includes('currency')) {
      const ok = await confirm({
        title: `Change the base currency to ${form.currency}?`,
        message: `Totals, charts and reports will be shown in ${form.currency}. Amounts already recorded keep their own currency and are converted at the latest exchange rates.`,
        confirmLabel: `Use ${form.currency}`,
      })
      if (!ok) return
    }

    const body: Partial<Settings> = {}
    for (const key of changed) {
      if (key === 'currency') body.currency = form.currency
      else if (key === 'company_name') body.company_name = form.company_name.trim()
      else body[key] = textOrNull(form[key])
    }

    setSaving(true)
    try {
      const next = await settingsApi.update(body)
      adopt(next)
      onSaved(next)
      toast.success('Company details saved')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the company details'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-5 items-start xl:grid-cols-[minmax(0,1fr)_23rem]">
      <form onSubmit={submit} className="space-y-5 min-w-0" noValidate>
        <Section title="Company details" description="Printed in the header of invoices, proposals and salary slips, and used in the emails you send.">
          <div className="form-grid">
            <Field label="Company name" required error={errors.company_name}>
              <input className="input" maxLength={150} value={form.company_name} onChange={(e) => update('company_name', e.target.value)} />
            </Field>
            <Field label="Email" error={errors.company_email}>
              <input
                className="input" type="email" maxLength={254} placeholder="accounts@example.com"
                value={form.company_email} onChange={(e) => update('company_email', e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input className="input" type="tel" maxLength={50} value={form.company_phone} onChange={(e) => update('company_phone', e.target.value)} />
            </Field>
            <Field label="Website">
              <input className="input" maxLength={200} placeholder="www.example.com" value={form.company_website} onChange={(e) => update('company_website', e.target.value)} />
            </Field>
            <Field label="Tax / registration number" hint="For example a VAT, TIN or company registration number.">
              <input className="input" maxLength={100} value={form.company_tax_id} onChange={(e) => update('company_tax_id', e.target.value)} />
            </Field>
            <Field
              label="Base currency"
              hint="Totals and reports are shown in this currency. Amounts in other currencies are converted at the latest exchange rates."
            >
              <select className="input" value={form.currency} onChange={(e) => update('currency', e.target.value)}>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c} · {CURRENCY_NAMES[c] ? `${CURRENCY_NAMES[c]} (${symbolFor(c)})` : symbolFor(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Address" className="form-full">
              <textarea
                className="input resize-y" rows={3} maxLength={500}
                value={form.company_address} onChange={(e) => update('company_address', e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <SaveBar
          dirty={dirty}
          saving={saving}
          onDiscard={() => {
            discard()
            setErrors({})
          }}
        />
      </form>

      <div className="space-y-5 min-w-0">
        <LogoCard settings={settings} onSaved={onSaved} />
        <ExchangeRatesCard baseCurrency={settings.currency || 'LKR'} />
      </div>
    </div>
  )
}

// ── Logo ─────────────────────────────────────────────────────────────────────

const MAX_LOGO_BYTES = 2 * 1024 * 1024

// The documents are PDFs, which can only carry PNG and JPEG images.
function isLogoFile(file: File) {
  if (file.type) return file.type === 'image/png' || file.type === 'image/jpeg'
  return /\.(png|jpe?g)$/i.test(file.name)
}

function LogoCard({ settings, onSaved }: SettingsTabProps) {
  const confirm = useConfirm()
  const { theme } = useTheme()
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [broken, setBroken] = useState(false)
  const logo = settings.logo_path

  useEffect(() => setBroken(false), [logo])

  async function upload(file: File) {
    if (!isLogoFile(file)) {
      toast.error('The logo must be a PNG or JPEG image')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('The logo is too large. The limit is 2 MB.')
      return
    }

    setBusy('upload')
    try {
      const res = await settingsApi.uploadLogo(file)
      onSaved({ ...settings, logo_path: res.logo_path })
      toast.success('Logo updated')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not upload the logo'))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Remove the logo?',
      message: 'Invoices, proposals and salary slips will show the company name only until a new logo is uploaded.',
      confirmLabel: 'Remove logo',
      tone: 'danger',
    })
    if (!ok) return

    setBusy('remove')
    try {
      await settingsApi.removeLogo()
      onSaved({ ...settings, logo_path: null })
      toast.success('Logo removed')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove the logo'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Logo" description="Shown at the top of invoices, proposals and salary slips.">
      {logo && !broken ? (
        // Documents are printed on white, so the preview sits on a light tile in both themes.
        <div className={`flex items-center justify-center h-28 max-w-sm rounded-lg border border-line p-4 ${theme === 'dark' ? 'bg-ink' : 'bg-surface'}`}>
          <img src={logo} alt="Company logo" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 h-28 max-w-sm rounded-lg border border-dashed border-line-strong text-ink-3">
          <ImageOff size={18} />
          <p className="text-xs">{logo ? 'The saved logo could not be shown' : 'No logo yet'}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button type="button" className="btn-secondary" onClick={() => picker.current?.click()} disabled={busy !== null}>
          {busy === 'upload' ? <Spinner /> : <Upload size={15} />} {logo ? 'Replace logo' : 'Upload logo'}
        </button>
        {logo && (
          <button type="button" className="btn-ghost" onClick={remove} disabled={busy !== null}>
            {busy === 'remove' ? <Spinner /> : <Trash2 size={15} />} Remove
          </button>
        )}
        <input
          ref={picker} type="file" accept="image/png,image/jpeg" className="hidden" tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Cleared so choosing the same file again is still noticed.
            e.target.value = ''
            if (file) upload(file)
          }}
        />
      </div>
      <p className="help">PNG or JPEG, up to 2 MB. The logo is saved as soon as you choose the file.</p>
    </Section>
  )
}

// ── Exchange rates ───────────────────────────────────────────────────────────

type RatesData = Awaited<ReturnType<typeof currencyApi.rates>>

// Small rates (1 LKR in USD) need the extra decimals; large ones do not.
const formatRate = (rate: number) =>
  rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: rate < 10 ? 4 : 2 })

function ExchangeRatesCard({ baseCurrency }: { baseCurrency: string }) {
  const [data, setData] = useState<Pick<RatesData, 'base' | 'updated_at' | 'rates'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // True after a refresh that could not reach the live service.
  const [offline, setOffline] = useState(false)
  const ticket = useRef(0)

  const load = useCallback(async () => {
    const mine = ++ticket.current
    setError(null)
    try {
      const res = await currencyApi.rates()
      if (mine === ticket.current) setData(res)
    } catch (err) {
      if (mine !== ticket.current) return
      setData(null)
      setError(errorMessage(err, 'Could not load the exchange rates'))
    }
  }, [])

  // Rates are quoted in the base currency, so they are read again when it changes.
  useEffect(() => {
    load()
  }, [load, baseCurrency])

  async function refresh() {
    const mine = ++ticket.current
    setRefreshing(true)
    try {
      const res = await currencyApi.refresh()
      if (mine === ticket.current) {
        setData(res)
        setError(null)
      }
      setOffline(!res.live)
      if (res.live) toast.success('Exchange rates updated')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not refresh the exchange rates'))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <Section
      flush
      title="Exchange rates"
      description="Used to convert other currencies into the base currency. Refreshed automatically every four hours."
      actions={
        <button type="button" className="btn-secondary btn-sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />} Refresh rates
        </button>
      }
    >
      {offline && (
        <div className="p-4 border-b border-line">
          <Notice tone="warn" alert>
            The live exchange-rate service could not be reached. The saved rates below are still in use.
          </Notice>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : data === null ? (
        <TableSkeleton rows={5} cols={2} />
      ) : (
        <>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="th">Currency</th>
                  <th scope="col" className="th-num">Worth in {data.base}</th>
                </tr>
              </thead>
              <tbody>
                {data.rates.map((r) => (
                  <tr key={r.currency} className="tr">
                    <td className="td whitespace-nowrap">
                      <span className="num text-ink font-medium">1 {r.currency}</span>
                      {CURRENCY_NAMES[r.currency] && <span className="text-ink-3 text-xs ml-2">{CURRENCY_NAMES[r.currency]}</span>}
                    </td>
                    <td className="td-num whitespace-nowrap">= {formatRate(r.rate)} {data.base}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 border-t border-line text-xs text-ink-3">
            {data.updated_at
              ? `Last updated ${formatDateTime(data.updated_at)}`
              : 'Live rates have not been fetched yet. Built-in starting rates are in use until then.'}
          </p>
        </>
      )}
    </Section>
  )
}
