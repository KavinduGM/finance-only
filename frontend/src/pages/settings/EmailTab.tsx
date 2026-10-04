import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Send } from 'lucide-react'
import { settingsApi } from '../../services/api'
import type { Settings, SystemInfo } from '../../services/api'
import { Field, Spinner, useConfirm } from '../../components/ui'
import PasswordInput from '../../components/PasswordInput'
import { useAuth } from '../../context/AuthContext'
import { errorMessage } from '../../lib/format'
import { EMAIL_PATTERN, Notice, SaveBar, Section, textOrNull, useSettingsForm, wholeNumber } from './shared'
import type { SettingsTabProps } from './shared'

// The saved password never reaches the browser, so its box always starts empty
// and only what is typed into it is sent.
const toForm = (s: Settings) => ({
  smtp_host: s.smtp_host || '',
  smtp_port: s.smtp_port === null || s.smtp_port === undefined ? '' : String(s.smtp_port),
  smtp_user: s.smtp_user || '',
  smtp_from_name: s.smtp_from_name || '',
  smtp_pass: '',
})

type Form = ReturnType<typeof toForm>
type Errors = Partial<Record<keyof Form, string>>

function validate(form: Form, changed: (keyof Form)[]): Errors {
  const errors: Errors = {}
  const host = form.smtp_host.trim()
  if (changed.includes('smtp_host') && host && !/^[A-Za-z0-9._-]+$/.test(host)) {
    errors.smtp_host = 'Enter the host name only, such as smtp.example.com, without "https://" or a port'
  }
  if (changed.includes('smtp_port')) {
    const port = wholeNumber(form.smtp_port)
    if (port === null || port < 1 || port > 65535) errors.smtp_port = 'Enter a port from 1 to 65535'
  }
  if (form.smtp_pass !== '' && form.smtp_pass.trim() === '') errors.smtp_pass = 'A password cannot be only spaces'
  return errors
}

/** The mailbox that documents and reminders are sent from. */
export default function EmailTab({ settings, onSaved }: SettingsTabProps) {
  const confirm = useConfirm()
  const { user } = useAuth()
  const { form, set, changed, dirty, discard, adopt } = useSettingsForm(settings, toForm)
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  // Which provider the server is actually sending through. The Resend API key
  // lives in the server environment and is never sent to the browser.
  const [mail, setMail] = useState<SystemInfo['email'] | null>(null)
  const loadMail = useCallback(async () => {
    try {
      setMail((await settingsApi.system()).email)
    } catch {
      setMail(null)
    }
  }, [])
  useEffect(() => {
    loadMail()
  }, [loadMail])

  const [testTo, setTestTo] = useState('')
  const [testError, setTestError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  function update(key: keyof Form, value: string) {
    set(key, value)
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !dirty) return
    const problems = validate(form, changed)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    const body: Partial<Settings> & { smtp_pass?: string } = {}
    for (const key of changed) {
      if (key === 'smtp_port') body.smtp_port = Number(form.smtp_port)
      else if (key === 'smtp_pass') body.smtp_pass = form.smtp_pass
      else body[key] = textOrNull(form[key])
    }

    setSaving(true)
    try {
      const next = await settingsApi.update(body)
      adopt(next)
      onSaved(next)
      setTestResult(null)
      loadMail()
      toast.success('Email settings saved')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the email settings'))
    } finally {
      setSaving(false)
    }
  }

  async function removePassword() {
    const ok = await confirm({
      title: 'Remove the saved mail password?',
      message: 'Invoices, proposals, reminders and salary slips cannot be emailed until a new password is saved.',
      confirmLabel: 'Remove password',
      tone: 'danger',
    })
    if (!ok) return

    setRemoving(true)
    try {
      const next = await settingsApi.update({ smtp_pass: null })
      // Edits in the other fields stay; only the saved password changed.
      onSaved(next)
      setTestResult(null)
      loadMail()
      toast.success('Saved mail password removed')
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove the saved password'))
    } finally {
      setRemoving(false)
    }
  }

  async function sendTest(e: React.FormEvent) {
    e.preventDefault()
    if (testing || dirty) return
    const to = testTo.trim()
    if (to && !EMAIL_PATTERN.test(to)) {
      setTestError('Enter a valid email address')
      return
    }

    setTesting(true)
    setTestResult(null)
    try {
      const res = await settingsApi.testEmail(to || undefined)
      setTestResult({ ok: true, message: `${res.message}. Check the inbox, and the spam folder if it is not there.` })
    } catch (err) {
      // The server explains what the mail server answered; that is the useful part.
      setTestResult({ ok: false, message: errorMessage(err, 'The test email could not be sent') })
    } finally {
      setTesting(false)
    }
  }

  const ownAddress = user?.email || settings.company_email

  return (
    <div className="space-y-5 max-w-4xl">
      {mail?.provider === 'resend' && (
        <Notice tone="good">
          Email is sent through <strong>Resend</strong> from <span className="num">{mail.from}</span>. The API key is set on
          the server (<span className="num">RESEND_API_KEY</span>) and is never shown or stored here.
        </Notice>
      )}
      {mail?.provider === 'smtp' && (
        <Notice tone="good">
          Email is sent through the mailbox below, from <span className="num">{mail.from}</span>.
        </Notice>
      )}
      {mail?.disabled && (
        <Notice tone="warn">
          Email is switched off on this server (<span className="num">EMAIL_DISABLED</span>). Nothing is sent, including
          payment reminders. Remove that setting from the server environment to send email.
        </Notice>
      )}
      {mail && !mail.provider && !mail.disabled && (
        <Notice tone={mail.resend_missing_sender ? 'warn' : 'info'} alert={mail.resend_missing_sender}>
          {mail.resend_missing_sender ? (
            <>
              A Resend API key is set on the server, but there is no sender address. Set{' '}
              <span className="num">EMAIL_FROM</span> to an address on your verified Resend domain, then restart the app.
            </>
          ) : (
            <>
              Email is not set up yet, so documents can be downloaded as PDF but not emailed. The recommended way is to
              set <span className="num">RESEND_API_KEY</span> and <span className="num">EMAIL_FROM</span> in the server
              environment (Dokploy → Environment). A mailbox can be used instead by filling in the fields below.
            </>
          )}
        </Notice>
      )}

      <form onSubmit={submit} className="space-y-5" noValidate>
        <Section
          title={mail?.provider === 'resend' ? 'Mailbox (not in use)' : 'Mailbox (SMTP)'}
          description={mail?.provider === 'resend'
            ? 'Resend is handling email, so these mailbox details are ignored. Only the sender name below is used.'
            : 'An alternative to Resend: invoices, proposals, payment reminders and salary slips are sent through this mailbox.'}
        >
          <div className="form-grid">
            <Field label="SMTP host" error={errors.smtp_host} hint="The outgoing mail server of your email provider.">
              <input
                className="input" maxLength={255} placeholder="smtp.example.com" autoCapitalize="none" spellCheck={false}
                value={form.smtp_host} onChange={(e) => update('smtp_host', e.target.value)}
              />
            </Field>
            <Field label="Port" error={errors.smtp_port} hint="465 uses SSL, 587 uses STARTTLS.">
              <input
                className="input num" type="number" inputMode="numeric" min={1} max={65535} step={1} placeholder="465"
                value={form.smtp_port} onChange={(e) => update('smtp_port', e.target.value)}
              />
            </Field>
            <Field label="Username" hint="Usually the full address of the mailbox. Emails are sent from it.">
              <input
                className="input" maxLength={255} placeholder="accounts@example.com" autoComplete="off" autoCapitalize="none" spellCheck={false}
                value={form.smtp_user} onChange={(e) => update('smtp_user', e.target.value)}
              />
            </Field>
            <div>
              <Field label="Password" error={errors.smtp_pass}>
                <PasswordInput
                  autoComplete="new-password" maxLength={500}
                  placeholder={settings.smtp_pass_set ? 'Saved — leave blank to keep' : 'Mailbox or app password'}
                  value={form.smtp_pass} onChange={(e) => update('smtp_pass', e.target.value)}
                />
              </Field>
              {settings.smtp_pass_set ? (
                <button type="button" className="link text-xs mt-1.5 disabled:opacity-50" onClick={removePassword} disabled={removing || saving}>
                  {removing ? 'Removing…' : 'Remove saved password'}
                </button>
              ) : (
                <p className="help">No password is saved yet.</p>
              )}
            </div>
            <Field label="Sender name" className="form-full" hint="The name recipients see. Leave blank to use the company name.">
              <input
                className="input" maxLength={100} placeholder={settings.company_name || 'Your company'}
                value={form.smtp_from_name} onChange={(e) => update('smtp_from_name', e.target.value)}
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

      <Section title="Send test email" description="Checks that the saved settings work by sending one short message.">
        <form onSubmit={sendTest} className="flex flex-wrap items-start gap-3" noValidate>
          <Field
            label="Send to"
            className="flex-1 min-w-[15rem]"
            error={testError}
            hint={ownAddress ? `Leave blank to send it to ${ownAddress}.` : 'Enter the address that should receive the test.'}
          >
            <input
              className="input" type="email" maxLength={254} placeholder={ownAddress || 'you@example.com'}
              value={testTo}
              onChange={(e) => {
                setTestTo(e.target.value)
                if (testError) setTestError(null)
              }}
            />
          </Field>
          {/* Lines the button up with the input, under a label-high spacer. */}
          <div className="pt-[22px]">
            <button type="submit" className="btn-secondary" disabled={testing || dirty}>
              {testing ? <Spinner /> : <Send size={15} />} Send test email
            </button>
          </div>
        </form>

        {dirty && <p className="help">Save your changes first. The test uses the saved settings.</p>}
        {testResult && (
          <div className="mt-4">
            <Notice tone={testResult.ok ? 'good' : 'bad'} alert={!testResult.ok}>{testResult.message}</Notice>
          </div>
        )}
      </Section>
    </div>
  )
}
