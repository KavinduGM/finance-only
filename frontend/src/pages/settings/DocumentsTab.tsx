import { useState } from 'react'
import toast from 'react-hot-toast'
import { settingsApi } from '../../services/api'
import type { Settings } from '../../services/api'
import { Field } from '../../components/ui'
import { errorMessage, thisYear } from '../../lib/format'
import { SaveBar, Section, textOrNull, useSettingsForm, wholeNumber } from './shared'
import type { SettingsTabProps } from './shared'

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value))

const toForm = (s: Settings) => ({
  invoice_prefix: s.invoice_prefix || '',
  proposal_prefix: s.proposal_prefix || '',
  invoice_due_days: numberText(s.invoice_due_days),
  proposal_validity_days: numberText(s.proposal_validity_days),
  default_tax_rate: numberText(s.default_tax_rate),
  invoice_terms: s.invoice_terms || '',
  invoice_notes: s.invoice_notes || '',
  proposal_terms: s.proposal_terms || '',
  bank_name: s.bank_name || '',
  bank_account_name: s.bank_account_name || '',
  bank_account_no: s.bank_account_no || '',
  bank_branch: s.bank_branch || '',
  bank_swift: s.bank_swift || '',
  payment_instructions: s.payment_instructions || '',
})

type Form = ReturnType<typeof toForm>
type Errors = Partial<Record<keyof Form, string>>

// The prefix becomes the first part of every document number.
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9-]{0,9}$/
const PREFIX_MESSAGE = 'Use 1 to 10 letters, numbers or dashes, starting with a letter or number'

const sampleNumber = (prefix: string, fallback: string) => `${prefix.trim() || fallback}-0042-${thisYear()}`

/** Only the fields that were edited are checked, because only those are sent. */
function validate(form: Form, changed: (keyof Form)[]): Errors {
  const errors: Errors = {}
  const touched = (key: keyof Form) => changed.includes(key)

  if (touched('invoice_prefix') && !PREFIX.test(form.invoice_prefix.trim())) errors.invoice_prefix = PREFIX_MESSAGE
  if (touched('proposal_prefix') && !PREFIX.test(form.proposal_prefix.trim())) errors.proposal_prefix = PREFIX_MESSAGE

  if (touched('invoice_due_days')) {
    const days = wholeNumber(form.invoice_due_days)
    if (days === null || days > 365) errors.invoice_due_days = 'Enter a whole number of days from 0 to 365'
  }
  if (touched('proposal_validity_days')) {
    const days = wholeNumber(form.proposal_validity_days)
    if (days === null || days < 1 || days > 365) errors.proposal_validity_days = 'Enter a whole number of days from 1 to 365'
  }
  if (touched('default_tax_rate')) {
    const rate = form.default_tax_rate.trim() === '' ? NaN : Number(form.default_tax_rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.default_tax_rate = 'Enter a rate from 0 to 100'
  }
  return errors
}

/** Numbering and default wording of invoices and proposals, and the payment details printed on invoices. */
export default function DocumentsTab({ settings, onSaved }: SettingsTabProps) {
  const { form, set, changed, dirty, discard, adopt } = useSettingsForm(settings, toForm)
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)

  function update(key: keyof Form, value: string) {
    set(key, value)
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return
    const problems = validate(form, changed)
    setErrors(problems)
    if (Object.keys(problems).length > 0) {
      toast.error('Check the highlighted fields')
      return
    }

    const body: Partial<Settings> = {}
    for (const key of changed) {
      if (key === 'invoice_prefix' || key === 'proposal_prefix') body[key] = form[key].trim()
      else if (key === 'invoice_due_days' || key === 'proposal_validity_days' || key === 'default_tax_rate') body[key] = Number(form[key])
      else body[key] = textOrNull(form[key])
    }

    setSaving(true)
    try {
      const next = await settingsApi.update(body)
      adopt(next)
      onSaved(next)
      toast.success('Document settings saved')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the document settings'))
    } finally {
      setSaving(false)
    }
  }

  const text = (key: keyof Form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => update(key, e.target.value),
  })

  return (
    <form onSubmit={submit} className="space-y-5 max-w-4xl" noValidate>
      <Section
        title="Invoices & proposals"
        description="Numbering and the defaults that fill in when you start a new document. Each document can still be changed on its own."
      >
        <div className="form-grid">
          <Field
            label="Invoice prefix" required error={errors.invoice_prefix}
            hint={<>New invoices are numbered like <span className="num text-ink-2">{sampleNumber(form.invoice_prefix, 'INV')}</span></>}
          >
            <input className="input num" maxLength={10} autoCapitalize="characters" spellCheck={false} {...text('invoice_prefix')} />
          </Field>
          <Field
            label="Proposal prefix" required error={errors.proposal_prefix}
            hint={<>New proposals are numbered like <span className="num text-ink-2">{sampleNumber(form.proposal_prefix, 'PRO')}</span></>}
          >
            <input className="input num" maxLength={10} autoCapitalize="characters" spellCheck={false} {...text('proposal_prefix')} />
          </Field>

          <Field label="Default due days" error={errors.invoice_due_days} hint="Days from the issue date until a new invoice is due.">
            <input className="input num" type="number" inputMode="numeric" min={0} max={365} step={1} {...text('invoice_due_days')} />
          </Field>
          <Field label="Default proposal validity days" error={errors.proposal_validity_days} hint="Days a new proposal stays open before it expires.">
            <input className="input num" type="number" inputMode="numeric" min={1} max={365} step={1} {...text('proposal_validity_days')} />
          </Field>

          <Field label="Default tax rate %" error={errors.default_tax_rate} hint="Applied to new invoices and proposals. Use 0 for no tax.">
            <input className="input num" type="number" inputMode="decimal" min={0} max={100} step="any" {...text('default_tax_rate')} />
          </Field>
        </div>

        <div className="divider mt-6 pt-5">
          <p className="eyebrow text-ink-2 mb-4">Default wording</p>
        </div>
        <div className="form-grid">
          <Field label="Default invoice terms" className="form-full" hint="Also used for invoices created from an accepted proposal.">
            <textarea className="input resize-y" rows={3} maxLength={2000} placeholder="Payment is due within 30 days of the invoice date." {...text('invoice_terms')} />
          </Field>
          <Field label="Default invoice notes" className="form-full">
            <textarea className="input resize-y" rows={3} maxLength={2000} placeholder="Thank you for your business." {...text('invoice_notes')} />
          </Field>
          <Field label="Default proposal terms" className="form-full">
            <textarea className="input resize-y" rows={3} maxLength={2000} placeholder="Work begins once the proposal is accepted." {...text('proposal_terms')} />
          </Field>
        </div>
      </Section>

      <Section
        title="Payment details shown on invoices"
        description="Tells clients how to pay. Printed on every invoice and included in invoice emails; blank fields are left out."
      >
        <div className="form-grid">
          <Field label="Bank name">
            <input className="input" maxLength={150} {...text('bank_name')} />
          </Field>
          <Field label="Account name">
            <input className="input" maxLength={150} {...text('bank_account_name')} />
          </Field>
          <Field label="Account number">
            <input className="input num" maxLength={100} autoComplete="off" spellCheck={false} {...text('bank_account_no')} />
          </Field>
          <Field label="Branch">
            <input className="input" maxLength={150} {...text('bank_branch')} />
          </Field>
          <Field label="SWIFT / BIC">
            <input className="input num" maxLength={50} autoCapitalize="characters" spellCheck={false} {...text('bank_swift')} />
          </Field>
          <Field label="Payment instructions" className="form-full" hint="Anything else a client needs to know, such as the reference to quote.">
            <textarea className="input resize-y" rows={3} maxLength={2000} {...text('payment_instructions')} />
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
  )
}
